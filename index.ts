/**
 * netmon — in-process network monitor for OpenCode model traffic.
 *
 * Hooks into the session HTTP and WebSocket transport, so it sees provider
 * requests without a TLS-intercepting proxy. Only model traffic that goes
 * through the session transport is captured; webfetch, MCP servers and plugin
 * installs use their own HTTP clients and are not visible here.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
  appendFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"

const VERSION = 1
const PID = typeof process !== "undefined" ? process.pid : 0
const MAX_REQ_BODY = 8 * 1024 * 1024
const MAX_RES_BODY = 4 * 1024 * 1024
const MAX_LINE = 128 * 1024

type Dict = Record<string, unknown>

type Pending = {
  id: string
  createdAt: number
  start: number
  sessionID: string
  agent: string
  kind: string
  providerID: string
  modelID: string
  method: string
  url: string
  host: string
  path: string
  reqBytes: number
  reqHeaders: Dict
  reqMeta?: Dict
  finalized: boolean
}

type Usage = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

type WsState = {
  sessionID: string
  agent: string
  kind: string
  providerID: string
  modelID: string
  url: string
  headers: Dict
  openedAt: number
  framesOut: number
  framesIn: number
  bytesOut: number
  bytesIn: number
  usage: Usage
  emitted: number
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function firstNum(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = num(value)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function redactPath(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.pathname
  } catch {
    return url
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return "unknown"
  }
}

const REQUEST_HEADERS = new Set([
  "content-type",
  "accept",
  "user-agent",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
  "x-request-id",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
])

const RESPONSE_HEADERS = [
  /^content-type$/,
  /^content-length$/,
  /^x-request-id$/,
  /^request-id$/,
  /^retry-after$/,
  /^openai-processing-ms$/,
  /^server$/,
  /^date$/,
  /^anthropic-/,
  /^x-ratelimit-/,
  /^ratelimit-/,
]

function pickHeaders(headers: Headers, mode: "request" | "response"): Dict {
  const out: Dict = {}
  headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (lower === "authorization" || lower === "proxy-authorization") {
      out[lower] = "[redacted]"
      return
    }
    if (lower === "cookie" || lower === "set-cookie") {
      out[lower] = `[redacted ${value.length}b]`
      return
    }
    if (mode === "request") {
      if (!REQUEST_HEADERS.has(lower)) return
    } else if (!RESPONSE_HEADERS.some((pattern) => pattern.test(lower))) {
      return
    }
    out[lower] = value.length > 512 ? `${value.slice(0, 512)}…` : value
  })
  return out
}

function normalizeUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Dict
  const usage: Usage = {
    input: firstNum(
      value.input_tokens,
      value.prompt_tokens,
      value.promptTokenCount,
      value.inputTokenCount,
    ),
    output: firstNum(
      value.output_tokens,
      value.completion_tokens,
      value.candidatesTokenCount,
      value.outputTokenCount,
    ),
    cacheRead: firstNum(
      value.cache_read_input_tokens,
      value.cached_tokens,
      value.cachedContentTokenCount,
      (value.prompt_tokens_details as Dict | undefined)?.cached_tokens,
      (value.input_tokens_details as Dict | undefined)?.cached_tokens,
    ),
    cacheWrite: firstNum(value.cache_creation_input_tokens, value.cacheWriteInputTokens),
    reasoning: firstNum(
      value.reasoning_tokens,
      value.thoughtsTokenCount,
      (value.completion_tokens_details as Dict | undefined)?.reasoning_tokens,
      (value.output_tokens_details as Dict | undefined)?.reasoning_tokens,
    ),
  }
  return Object.values(usage).some((entry) => entry !== undefined) ? usage : undefined
}

function mergeUsage(target: Usage, next: Usage | undefined): Usage {
  if (!next) return target
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const) {
    const value = next[key]
    if (value !== undefined) target[key] = value
  }
  return target
}

/** Pull usage out of any provider envelope. */
function extractUsage(payload: unknown): Usage | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const root = payload as Dict
  let usage = normalizeUsage(root.usage) ?? normalizeUsage(root.usageMetadata)
  const response = root.response as Dict | undefined
  if (response) {
    usage = mergeUsage(usage ?? {}, normalizeUsage(response.usage))
    usage = mergeUsage(usage, normalizeUsage(response.usageMetadata))
  }
  const message = root.message as Dict | undefined
  if (message) {
    usage = mergeUsage(usage ?? {}, normalizeUsage(message.usage))
    usage = mergeUsage(usage, normalizeUsage(message.usageMetadata))
  }
  return Object.keys(usage ?? {}).length ? usage : undefined
}

function extractErrorText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const root = payload as Dict
  const error = root.error as Dict | string | undefined
  if (typeof error === "string") return error.slice(0, 400)
  if (error && typeof error === "object") {
    const message = error.message ?? error.msg ?? error.type
    if (typeof message === "string") return message.slice(0, 400)
  }
  const message = root.message ?? root.detail
  if (typeof message === "string") return message.slice(0, 400)
  return undefined
}

function summarizeRequest(payload: unknown, contentType: string | null): Dict {
  const meta: Dict = {}
  const json = contentType?.includes("json")
  if (!json || !payload || typeof payload !== "object") return meta
  const body = payload as Dict
  if (typeof body.model === "string") meta.model = body.model
  if (typeof body.stream === "boolean") meta.stream = body.stream
  if (Array.isArray(body.messages)) meta.messages = body.messages.length
  else if (Array.isArray(body.input)) meta.messages = body.input.length
  else if (Array.isArray(body.contents)) meta.messages = body.contents.length
  if (Array.isArray(body.tools)) meta.tools = body.tools.length
  else if (Array.isArray(body.functions)) meta.tools = body.functions.length
  if (body.system) meta.system = Array.isArray(body.system) ? body.system.length : 1
  const maxTokens = firstNum(
    body.max_tokens,
    body.max_output_tokens,
    body.maxOutputTokens,
    (body.generationConfig as Dict | undefined)?.maxOutputTokens,
  )
  if (maxTokens !== undefined) meta.maxTokens = maxTokens
  return meta
}

/** Read a cloned request/response body while counting bytes and keeping a capped prefix. */
async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<{ bytes: number; body: Uint8Array }> {
  if (!stream) return { bytes: 0, body: new Uint8Array(0) }
  const reader = stream.getReader()
  const kept: Uint8Array[] = []
  let keptBytes = 0
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (keptBytes < cap) {
        const slice = value.byteLength <= cap - keptBytes ? value : value.subarray(0, cap - keptBytes)
        kept.push(slice)
        keptBytes += slice.byteLength
      }
    }
  } catch {
    // aborted or broken stream: report what we saw
  } finally {
    try {
      await reader.cancel()
    } catch {
      // ignore
    }
  }
  const body = new Uint8Array(keptBytes)
  let offset = 0
  for (const chunk of kept) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes: total, body }
}

function tryJson(bytes: Uint8Array, contentType: string | null): unknown {
  if (!contentType) return undefined
  if (!contentType.includes("json") && !contentType.includes("event-stream")) return undefined
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
}

/** Incremental SSE/NDJSON scanner that keeps the last usage block it saw. */
class StreamScanner {
  private decoder = new TextDecoder()
  private buffer = ""
  bytes = 0
  ttfb?: number
  usage: Usage = {}
  model?: string
  status?: number
  error?: string
  private first = true

  constructor(private started: number) {}

  push(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength
    if (this.first) {
      this.first = false
      this.ttfb = Math.round(performance.now() - this.started)
    }
    this.buffer += this.decoder.decode(chunk, { stream: true })
    let newline = this.buffer.indexOf("\n")
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "")
      this.buffer = this.buffer.slice(newline + 1)
      this.line(line)
      newline = this.buffer.indexOf("\n")
    }
    if (this.buffer.length > MAX_LINE) {
      // Avoid unbounded growth on a malformed stream.
      this.buffer = this.buffer.slice(-MAX_LINE / 2)
    }
  }

  private line(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let data = trimmed
    if (trimmed.startsWith("data:")) data = trimmed.slice(5).trim()
    else if (trimmed.startsWith("{")) data = trimmed
    else return
    if (data === "[DONE]") return
    if (
      !data.includes("usage") &&
      !data.includes("usageMetadata") &&
      !data.includes('"model"') &&
      !data.includes('"error"')
    ) {
      return
    }
    try {
      const payload = JSON.parse(data) as Dict
      mergeUsage(this.usage, extractUsage(payload))
      if (typeof payload.model === "string") this.model = payload.model
      if (typeof payload.status === "number") this.status = payload.status
      const response = payload.response as Dict | undefined
      if (response && typeof response.model === "string") this.model = response.model
      if (response && typeof response.status === "number") this.status = response.status
      const error = extractErrorText(payload)
      if (error) this.error = error
    } catch {
      // partial line or plain text chunk
    }
  }

  finish(): void {
    this.buffer += this.decoder.decode()
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-"
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function shortID(id: string): string {
  if (!id) return "-"
  return id.length > 14 ? `${id.slice(0, 14)}…` : id
}

function tokenTotal(usage: Usage | undefined): number {
  if (!usage) return 0
  return (usage.input ?? 0) + (usage.output ?? 0)
}

function usageText(usage: Usage | undefined): string {
  if (!usage) return "-"
  const parts: string[] = []
  if (usage.input !== undefined) parts.push(`in ${usage.input}`)
  if (usage.output !== undefined) parts.push(`out ${usage.output}`)
  if (usage.cacheRead) parts.push(`cache ${usage.cacheRead}`)
  if (usage.reasoning) parts.push(`reason ${usage.reasoning}`)
  return parts.length ? parts.join(" / ") : "-"
}

function defaultTrafficFile(): string {
  const env = typeof process !== "undefined" ? process.env : {}
  if (env.NETMON_FILE) return env.NETMON_FILE
  const xdg = env.XDG_DATA_HOME
  if (xdg && isAbsolute(xdg)) return join(xdg, "opencode", "netmon", "traffic.jsonl")
  if (typeof process !== "undefined" && process.platform === "win32") {
    const appData = env.APPDATA
    if (appData) return join(appData, "opencode", "netmon", "traffic.jsonl")
  }
  return join(homedir(), ".local", "share", "opencode", "netmon", "traffic.jsonl")
}

export default {
  id: "netmon",

  async setup(ctx: any) {
    const options: Dict = ctx?.options ?? {}
    const configured =
      typeof options.file === "string" && options.file.length
        ? (options.file as string)
        : defaultTrafficFile()
    const file =
      configured.startsWith("~/") || configured.startsWith("~\\")
        ? join(homedir(), configured.slice(2))
        : configured
    const maxMemory = firstNum(options.maxMemory) ?? 5000
    const maxFileBytes = firstNum(options.maxFileBytes) ?? 32 * 1024 * 1024
    const captureHeaders = options.headers !== false

    try {
      mkdirSync(dirname(file), { recursive: true })
      if (existsSync(file) && statSync(file).size > maxFileBytes) {
        renameSync(file, `${file}.1`)
      }
    } catch {
      // keep going; writes will report via the log only once
    }

    const ring: Dict[] = []
    const pending = new WeakMap<Request, Pending>()
    const pendingFallback: Pending[] = []
    const wsStates = new Map<string, WsState>()
    const disposers: Array<{ dispose: () => Promise<void> }> = []
    let writeError = ""
    let writeErrorAt = 0

    const emit = (record: Dict): void => {
      if (!writeError || Date.now() - writeErrorAt > 30_000) {
        try {
          appendFileSync(file, JSON.stringify(record) + "\n")
          writeError = ""
        } catch (error) {
          writeError = error instanceof Error ? error.message : String(error)
          writeErrorAt = Date.now()
        }
      }
      ring.push(record)
      if (ring.length > maxMemory) ring.shift()
    }

    const maybeRotate = (): void => {
      try {
        if (statSync(file).size > maxFileBytes) renameSync(file, `${file}.1`)
      } catch {
        // missing file or another instance rotated it
      }
    }

    const base = (event: any): Dict => ({
      v: VERSION,
      ts: new Date().toISOString(),
      pid: PID,
      id: crypto.randomUUID(),
      session: event?.sessionID ?? "",
      agent: event?.agent ?? "",
      kind: event?.kind ?? "primary",
      provider: event?.model?.providerID ?? "",
      model: event?.model?.id ?? "",
    })

    const matchPending = (request: Request): Pending | undefined => {
      const direct = pending.get(request)
      if (direct) return direct
      const url = request.url
      const method = request.method
      const now = performance.now()
      for (let index = 0; index < pendingFallback.length; index += 1) {
        const item = pendingFallback[index]
        if (item.finalized) continue
        if (item.url === url && item.method === method && now - item.start < 180_000) {
          return item
        }
      }
      return undefined
    }

    const flushPending = (item: Pending, record: Dict): void => {
      if (item.finalized) return
      item.finalized = true
      emit({
        ...base({ sessionID: item.sessionID, agent: item.agent, kind: item.kind, model: { providerID: item.providerID, id: item.modelID } }),
        ts: new Date(item.createdAt).toISOString(),
        ...record,
      })
      const index = pendingFallback.indexOf(item)
      if (index !== -1) pendingFallback.splice(index, 1)
    }

    const inspectRequest = async (item: Pending, request: Request): Promise<void> => {
      let clone: Request
      try {
        clone = request.clone()
      } catch {
        return
      }
      const contentType = clone.headers.get("content-type")
      const declared = Number(clone.headers.get("content-length") ?? 0)
      if (Number.isFinite(declared) && declared > MAX_REQ_BODY * 4) {
        item.reqBytes = declared
        return
      }
      const { bytes, body } = await readCapped(clone.body, MAX_REQ_BODY)
      item.reqBytes = bytes || (Number.isFinite(declared) ? declared : 0)
      if (bytes > 0) {
        const payload = tryJson(body, contentType)
        item.reqMeta = summarizeRequest(payload, contentType)
      }
    }

    const inspectResponse = async (item: Pending, response: Response): Promise<void> => {
      let clone: Response
      try {
        clone = response.clone()
      } catch {
        return
      }
      const contentType = response.headers.get("content-type")
      const record: Dict = {
        type: "request",
        status: response.status,
        statusText: response.statusText,
        contentType: contentType ?? "",
        headersMs: Math.round(performance.now() - item.start),
      }
      const resHeaders = captureHeaders ? pickHeaders(response.headers, "response") : {}
      if (Object.keys(resHeaders).length) record.resHeaders = resHeaders

      const scanner = new StreamScanner(item.start)
      if (contentType?.includes("event-stream") || contentType?.includes("json-seq")) {
        try {
          const reader = clone.body?.getReader()
          if (reader) {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (value) scanner.push(value)
            }
          }
        } catch {
          // aborted stream
        }
        scanner.finish()
        record.stream = true
        record.resBytes = scanner.bytes
        if (scanner.ttfb !== undefined) record.ttfbMs = scanner.ttfb
        if (scanner.model) record.upstreamModel = scanner.model
        if (Object.keys(scanner.usage).length) record.tokens = scanner.usage
        if (scanner.error) record.error = { type: "upstream", message: scanner.error }
      } else {
        const { bytes, body } = await readCapped(clone.body, MAX_RES_BODY)
        record.resBytes = bytes
        const payload = tryJson(body, contentType)
        if (contentType?.includes("json")) {
          const usage = extractUsage(payload)
          if (usage) record.tokens = usage
          const error = extractErrorText(payload)
          if (error) record.error = { type: "upstream", message: error }
          const bodyObject = payload && typeof payload === "object" ? (payload as Dict) : undefined
          if (bodyObject && typeof bodyObject.model === "string") record.upstreamModel = bodyObject.model
          if (bytes > MAX_RES_BODY && !record.error && response.status >= 400) {
            record.error = { type: "upstream", message: `body truncated at ${formatBytes(MAX_RES_BODY)}` }
          }
        } else if (bytes > 0 && response.status >= 400) {
          const snippet = new TextDecoder().decode(body.subarray(0, 400)).replace(/\s+/g, " ").trim()
          if (snippet) record.error = { type: "upstream", message: snippet }
        }
      }

      record.durationMs = Math.round(performance.now() - item.start)
      record.reqBytes = item.reqBytes
      record.method = item.method
      record.url = item.url
      record.host = item.host
      record.path = item.path
      record.reqHeaders = item.reqHeaders
      if (item.reqMeta && Object.keys(item.reqMeta).length) record.req = item.reqMeta
      if (response.status >= 400 && !record.error) {
        record.error = { type: "http", message: `HTTP ${response.status} ${response.statusText}`.trim() }
      }
      flushPending(item, record)
    }

    const attach = async (name: string, callback: (event: any) => unknown): Promise<void> => {
      try {
        const registration = await ctx.session.hook(name as any, callback as any)
        if (registration) disposers.push(registration)
      } catch {
        // hook not supported by this runtime version
      }
    }

    // --- HTTP -------------------------------------------------------------
    void attach("http.request", (event) => {
      try {
        const request: Request = event.request
        if (pending.get(request)) return
        const item: Pending = {
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          start: performance.now(),
          sessionID: event.sessionID,
          agent: event.agent,
          kind: event.kind ?? "primary",
          providerID: event.model?.providerID ?? "",
          modelID: event.model?.id ?? "",
          method: request.method,
          url: request.url,
          host: hostOf(request.url),
          path: redactPath(request.url),
          reqBytes: Number(request.headers.get("content-length") ?? 0) || 0,
          reqHeaders: captureHeaders ? pickHeaders(request.headers, "request") : {},
          finalized: false,
        }
        pending.set(request, item)
        pendingFallback.push(item)
        if (pendingFallback.length > 100) {
          const stale = pendingFallback.shift()
          if (stale && !stale.finalized) flushPending(stale, { type: "request", status: 0, error: { type: "dropped", message: "pending queue overflow" } })
        }
        void inspectRequest(item, request).catch(() => undefined)
      } catch {
        // never break dispatch
      }
    })

    void attach("http.response", (event) => {
      try {
        const item = matchPending(event.request)
        if (!item || item.finalized) return
        void inspectResponse(item, event.response).catch(() => undefined)
      } catch {
        // never break dispatch
      }
    })

    void attach("retry", (event) => {
      try {
        const record = base(event)
        record.type = "retry"
        record.attempt = event.attempt
        record.error = {
          type: event.error?.type ?? "unknown",
          message: String(event.error?.message ?? "").slice(0, 400),
          status: event.error?.status,
        }
        record.decision = event.decision
        emit(record)
      } catch {
        // ignore
      }
    })

    // --- WebSocket (experimental in 2.2.x) --------------------------------
    const wsKey = (event: any): string => `${event.sessionID}:${event.model?.providerID}:${event.kind}`

    const wsFlush = (state: WsState, force: boolean): void => {
      if (!force && state.framesIn + state.framesOut === state.emitted) return
      emit({
        v: VERSION,
        ts: new Date().toISOString(),
        pid: PID,
        id: crypto.randomUUID(),
        type: "ws",
        phase: "stats",
        session: state.sessionID,
        agent: state.agent,
        kind: state.kind,
        provider: state.providerID,
        model: state.modelID,
        url: state.url,
        durationMs: Math.round(performance.now() - state.openedAt),
        framesIn: state.framesIn,
        framesOut: state.framesOut,
        bytesIn: state.bytesIn,
        bytesOut: state.bytesOut,
        tokens: state.usage,
      })
      state.emitted = state.framesIn + state.framesOut
    }

    void attach("experimental.ws.handshake", (event) => {
      try {
        const key = wsKey(event)
        let state = wsStates.get(key)
        if (!state) {
          state = {
            sessionID: event.sessionID,
            agent: event.agent,
            kind: event.kind ?? "primary",
            providerID: event.model?.providerID ?? "",
            modelID: event.model?.id ?? "",
            url: event.url,
            headers: captureHeaders ? Object.fromEntries(
              Object.entries(event.headers ?? {}).filter(([name]) => !/authorization|api[-_]?key|cookie/i.test(name)),
            ) : {},
            openedAt: performance.now(),
            framesOut: 0,
            framesIn: 0,
            bytesOut: 0,
            bytesIn: 0,
            usage: {},
            emitted: 0,
          }
          wsStates.set(key, state)
          emit({
            v: VERSION,
            ts: new Date().toISOString(),
            pid: PID,
            id: crypto.randomUUID(),
            type: "ws",
            phase: "open",
            session: state.sessionID,
            agent: state.agent,
            kind: state.kind,
            provider: state.providerID,
            model: state.modelID,
            url: state.url,
            host: hostOf(state.url),
            reqHeaders: state.headers,
          })
        }
      } catch {
        // ignore
      }
    })

    void attach("experimental.ws.send", (event) => {
      try {
        const state = wsStates.get(wsKey(event))
        if (!state) return
        state.framesOut += 1
        state.bytesOut += textBytes(event.frame ?? "")
        const usage = extractUsageFromFrame(event.frame)
        mergeUsage(state.usage, usage)
      } catch {
        // ignore
      }
    })

    void attach("experimental.ws.receive", (event) => {
      try {
        const state = wsStates.get(wsKey(event))
        if (!state) return
        state.framesIn += 1
        state.bytesIn += textBytes(event.frame ?? "")
        const usage = extractUsageFromFrame(event.frame)
        mergeUsage(state.usage, usage)
      } catch {
        // ignore
      }
    })

    function extractUsageFromFrame(frame: unknown): Usage | undefined {
      if (typeof frame !== "string" || frame.length === 0 || frame.length > 1_000_000) return undefined
      if (!frame.includes("usage") && !frame.includes("usageMetadata")) return undefined
      try {
        return extractUsage(JSON.parse(frame))
      } catch {
        return undefined
      }
    }

    // --- housekeeping -----------------------------------------------------
    const sweep = setInterval(() => {
      const now = performance.now()
      for (const item of [...pendingFallback]) {
        if (item.finalized) continue
        if (now - item.start > 180_000) {
          flushPending(item, {
            type: "request",
            status: 0,
            durationMs: Math.round(now - item.start),
            method: item.method,
            url: item.url,
            host: item.host,
            path: item.path,
            reqBytes: item.reqBytes,
            reqHeaders: item.reqHeaders,
            req: item.reqMeta,
            error: { type: "timeout", message: "no response within 180s" },
          })
        }
      }
      for (const state of wsStates.values()) {
        if (state.framesIn + state.framesOut > state.emitted) wsFlush(state, false)
      }
      maybeRotate()
    }, 15_000)
    ;(sweep as any).unref?.()

    // --- tool -------------------------------------------------------------
    const readTail = (limit: number): Dict[] => {
      const records: Dict[] = []
      if (!existsSync(file)) return records
      try {
        const size = statSync(file).size
        const window = Math.min(size, 8 * 1024 * 1024)
        const fd = openSync(file, "r")
        const buffer = Buffer.allocUnsafe(window)
        try {
          readSync(fd, buffer, 0, window, size - window)
        } finally {
          closeSync(fd)
        }
        let text = buffer.toString("utf8")
        if (window < size) {
          const newline = text.indexOf("\n")
          text = newline === -1 ? "" : text.slice(newline + 1)
        }
        for (const line of text.split("\n")) {
          if (!line.trim()) continue
          try {
            records.push(JSON.parse(line) as Dict)
          } catch {
            // skip torn line
          }
        }
      } catch {
        // ignore
      }
      return records.slice(-limit)
    }

    const all = (limit: number): Dict[] => {
      const merged: Dict[] = []
      const seen = new Set<string>()
      const source = [...readTail(limit), ...ring]
      for (const record of source) {
        const id = String(record.id ?? "")
        if (id && seen.has(id)) continue
        if (id) seen.add(id)
        merged.push(record)
      }
      merged.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")))
      return merged.slice(-limit)
    }

    const aggregate = (records: Dict[]): Dict => {
      const total = {
        requests: 0,
        retries: 0,
        ws: 0,
        errors: 0,
        reqBytes: 0,
        resBytes: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        durationMs: 0,
        timed: 0,
        hosts: {} as Record<string, { requests: number; errors: number; bytesIn: number; bytesOut: number; ms: number }>,
        models: {} as Record<string, { requests: number; tokens: number; ms: number }>,
        statuses: {} as Record<string, number>,
      }
      for (const record of records) {
        if (record.type === "retry") {
          total.retries += 1
          continue
        }
        if (record.type === "ws") {
          total.ws += 1
          total.reqBytes += firstNum(record.bytesOut) ?? 0
          total.resBytes += firstNum(record.bytesIn) ?? 0
          const usage = record.tokens as Usage | undefined
          total.tokensIn += usage?.input ?? 0
          total.tokensOut += usage?.output ?? 0
          total.cacheRead += usage?.cacheRead ?? 0
          continue
        }
        total.requests += 1
        const status = String(record.status ?? 0)
        total.statuses[status] = (total.statuses[status] ?? 0) + 1
        if (record.error) total.errors += 1
        const reqBytes = firstNum(record.reqBytes) ?? 0
        const resBytes = firstNum(record.resBytes) ?? 0
        const duration = firstNum(record.durationMs) ?? 0
        const usage = record.tokens as Usage | undefined
        total.reqBytes += reqBytes
        total.resBytes += resBytes
        total.tokensIn += usage?.input ?? 0
        total.tokensOut += usage?.output ?? 0
        total.cacheRead += usage?.cacheRead ?? 0
        total.durationMs += duration
        if (record.status) total.timed += 1
        const host = String(record.host ?? "unknown")
        const hostEntry = (total.hosts[host] ??= { requests: 0, errors: 0, bytesIn: 0, bytesOut: 0, ms: 0 })
        hostEntry.requests += 1
        hostEntry.errors += record.error ? 1 : 0
        hostEntry.bytesIn += reqBytes
        hostEntry.bytesOut += resBytes
        hostEntry.ms += duration
        const model = `${record.provider ?? "?"}/${record.model ?? "?"}`
        const modelEntry = (total.models[model] ??= { requests: 0, tokens: 0, ms: 0 })
        modelEntry.requests += 1
        modelEntry.tokens += tokenTotal(usage)
        modelEntry.ms += duration
      }
      return total
    }

    const summaryText = (records: Dict[]): string => {
      const stats = aggregate(records)
      const lines: string[] = []
      if (!stats.requests && !stats.ws && !stats.retries) {
        return `netmon: no traffic recorded yet (file: ${file})`
      }
      lines.push(
        `netmon — ${stats.requests} HTTP req, ${stats.ws} WS events, ${stats.retries} retries, ${stats.errors} errors`,
      )
      lines.push(
        `bytes: ↑ ${formatBytes(stats.reqBytes)}  ↓ ${formatBytes(stats.resBytes)}   tokens: in ${stats.tokensIn} / out ${stats.tokensOut} / cache ${stats.cacheRead}`,
      )
      const avg = stats.requests ? stats.durationMs / stats.requests : 0
      lines.push(`avg latency: ${formatMs(avg)}`)
      const statuses = Object.entries(stats.statuses as Record<string, number>)
        .map(([status, count]) => `${status}:${count}`)
        .join(" ")
      if (statuses) lines.push(`status: ${statuses}`)
      lines.push("")
      lines.push("hosts:")
      for (const [host, entry] of Object.entries(stats.hosts as Record<string, any>).sort(
        (a, b) => b[1].requests - a[1].requests,
      )) {
        lines.push(
          `  ${host}  ${entry.requests} req  ↑${formatBytes(entry.bytesIn)} ↓${formatBytes(entry.bytesOut)}  avg ${formatMs(entry.ms / entry.requests)}`,
        )
      }
      lines.push("")
      lines.push("models:")
      for (const [model, entry] of Object.entries(stats.models as Record<string, any>).sort(
        (a, b) => b[1].requests - a[1].requests,
      )) {
        lines.push(`  ${model}  ${entry.requests} req  ${entry.tokens} tok  avg ${formatMs(entry.ms / entry.requests)}`)
      }
      return lines.join("\n")
    }

    const tailText = (records: Dict[]): string => {
      if (!records.length) return "netmon: no traffic recorded yet"
      const lines = [
        "time      status  kind      model                     dur      ↑         ↓         session",
      ]
      for (const record of records) {
        if (record.type === "retry") {
          lines.push(
            `${String(record.ts ?? "").slice(11, 19)}  retry   ${String(record.kind ?? "").padEnd(8)}  ${String(record.model ?? "").slice(0, 24).padEnd(24)}  #${record.attempt} ${String((record.error as Dict | undefined)?.type ?? "")}`,
          )
          continue
        }
        if (record.type === "ws") {
          lines.push(
            `${String(record.ts ?? "").slice(11, 19)}  ws      ${String(record.kind ?? "").padEnd(8)}  ${String(record.model ?? "").slice(0, 24).padEnd(24)}  ${String(record.framesIn ?? 0)}↓/${String(record.framesOut ?? 0)}↑  ${formatBytes(firstNum(record.bytesOut) ?? 0)}  ${formatBytes(firstNum(record.bytesIn) ?? 0)}`,
          )
          continue
        }
        const usage = record.tokens as Usage | undefined
        const status = String(record.status ?? 0)
        lines.push(
          `${String(record.ts ?? "").slice(11, 19)}  ${status.padEnd(6)}  ${String(record.kind ?? "").padEnd(8)}  ${String(record.model ?? "").slice(0, 24).padEnd(24)}  ${formatMs(firstNum(record.durationMs) ?? 0).padEnd(7)}  ${formatBytes(firstNum(record.reqBytes) ?? 0).padEnd(8)}  ${formatBytes(firstNum(record.resBytes) ?? 0).padEnd(8)}  ${shortID(String(record.session ?? ""))}${usage ? `  ${usageText(usage)}` : ""}`,
        )
      }
      return lines.join("\n")
    }

    try {
      await ctx.tool.transform((editor: any) => {
        editor.add({
          name: "netmon",
          description:
            "Inspect network traffic captured by the netmon plugin: recent model API requests, latency, byte counts, token usage, retries and WebSocket activity.",
          input: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["summary", "tail", "stats", "clear"],
                description: "summary (default), tail (recent requests), stats (aggregates only), clear (truncate log)",
              },
              limit: {
                type: "integer",
                minimum: 1,
                maximum: 500,
                description: "How many recent records to inspect (default 100 for stats, 20 for tail)",
              },
              format: {
                type: "string",
                enum: ["text", "json"],
                description: "Return formatted text or raw JSON records",
              },
            },
            additionalProperties: false,
          },
          execute: async (input: any) => {
            const action = input?.action ?? "summary"
            const format = input?.format ?? "text"
            const limit = firstNum(input?.limit) ?? (action === "tail" ? 20 : 200)
            if (action === "clear") {
              ring.length = 0
              try {
                writeFileSync(file, "")
              } catch (error) {
                return { content: `netmon: failed to clear ${file}: ${error}` }
              }
              return { content: `netmon: cleared ${file}` }
            }
            const records = all(limit)
            if (format === "json") {
              return { content: JSON.stringify(records, null, 2) }
            }
            if (action === "tail") return { content: tailText(records) }
            if (action === "stats") {
              return { content: JSON.stringify(aggregate(records), null, 2) }
            }
            return { content: `${summaryText(records)}\n\nrecent:\n${tailText(records.slice(-20))}` }
          },
        })
      })
    } catch {
      // tool registration is optional
    }

    // --- cleanup ----------------------------------------------------------
    return async () => {
      clearInterval(sweep)
      for (const state of wsStates.values()) {
        if (state.framesIn + state.framesOut > state.emitted) wsFlush(state, true)
      }
      wsStates.clear()
      for (const item of [...pendingFallback]) {
        if (item.finalized) continue
        flushPending(item, {
          type: "request",
          status: 0,
          durationMs: Math.round(performance.now() - item.start),
          method: item.method,
          url: item.url,
          host: item.host,
          path: item.path,
          reqBytes: item.reqBytes,
          reqHeaders: item.reqHeaders,
          req: item.reqMeta,
          error: { type: "aborted", message: "plugin unloaded before response" },
        })
      }
      for (const registration of disposers) {
        try {
          await registration.dispose()
        } catch {
          // ignore
        }
      }
      disposers.length = 0
    }
  },
}
