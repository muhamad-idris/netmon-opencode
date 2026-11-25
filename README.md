# netmon — pemantau trafik jaringan OpenCode

Plugin server OpenCode yang mencatat trafik model API langsung dari dalam proses
server, tanpa proxy dan tanpa membongkar TLS.

Plugin memakai hook `session.hook("http.request" | "http.response")` serta hook
WebSocket eksperimental (`experimental.ws.*`) pada OpenCode 2.2.x. Setiap request
model dicatat: host, path, status, latensi, jumlah byte, token usage, retry, dan
error.

## Cakupan

Yang terlihat:

- request model ke provider (agent loop, title, compaction, generate)
- request ulang/retry dan kegagalannya
- trafik WebSocket provider, jika provider memakai WebSocket

Yang **tidak** terlihat (bukan bagian dari transport sesi):

- `webfetch` dan pencarian web
- koneksi MCP (lokal maupun remote)
- instalasi plugin/paket
- trafik proses lain di sistem

Untuk trafik tingkat proses di luar cakupan itu, tetap perlu alat OS seperti
`ss`, `nethogs`, atau `bpftrace`. Plugin ini tidak membaca paket jaringan dan
tidak menyadap koneksi.

## Data

Lokasi default mengikuti direktori data OpenCode:

- Linux/macOS: `~/.local/share/opencode/netmon/traffic.jsonl`
- Windows: `%APPDATA%\opencode\netmon\traffic.jsonl`
- Jika `XDG_DATA_HOME` diset: `$XDG_DATA_HOME/opencode/netmon/traffic.jsonl`
- Override: env `NETMON_FILE` atau opsi `file`

Isi record request:

```json
{
  "type": "request",
  "ts": "2026-11-25T02:16:56.431Z",
  "session": "ses_...",
  "agent": "build",
  "kind": "primary",
  "provider": "opencode",
  "model": "deepseek-v4.1-flash-free",
  "method": "POST",
  "url": "https://opencode.ai/inference/openai/v1/chat/completions",
  "host": "opencode.ai",
  "path": "/inference/openai/v1/chat/completions",
  "status": 200,
  "durationMs": 3590,
  "ttfbMs": 2469,
  "reqBytes": 353583,
  "resBytes": 10167,
  "tokens": { "input": 88485, "output": 179, "cacheRead": 88064, "reasoning": 38 },
  "req": { "model": "deepseek-v4.1-flash-free", "stream": true, "messages": 124, "tools": 12 }
}
```

Yang tidak disimpan:

- isi prompt, isi respons, argumen tool
- nilai header `authorization`, `api-key`, `cookie` (diganti `[redacted]`)

Yang disimpan: URL, nama model, jumlah pesan/tool, ukuran byte, token usage,
status HTTP, dan sebagian header non-rahasia (content-type, request-id,
rate-limit, versi API provider).

## Viewer

Linux/macOS:

```bash
~/.config/opencode/plugins/netmon/netmon              # 20 request terakhir
~/.config/opencode/plugins/netmon/netmon --stats      # agregat
~/.config/opencode/plugins/netmon/netmon --follow     # live
~/.config/opencode/plugins/netmon/netmon --json       # record mentah
~/.config/opencode/plugins/netmon/netmon --clear      # kosongkan log
```

Windows (cmd):

```bat
"%APPDATA%\opencode\plugins\netmon\netmon.cmd"
"%APPDATA%\opencode\plugins\netmon\netmon.cmd" --stats
"%APPDATA%\opencode\plugins\netmon\netmon.cmd" --follow
```

Windows (PowerShell), jika Python ada di PATH:

```powershell
py -3 "$env:APPDATA\opencode\plugins\netmon\netmon" --stats
```

Viewer membutuhkan Python 3. Tidak ada dependensi pihak ketiga.

Tambahkan symlink ke `~/.local/bin` (Linux/macOS) bila ingin memanggilnya
sebagai `netmon`:

```bash
ln -s ~/.config/opencode/plugins/netmon/netmon ~/.local/bin/netmon
```

## Tool untuk agent

Plugin mendaftarkan tool `netmon`. Contoh prompt:

- "tampilkan ringkasan trafik jaringan OpenCode"
- "tail 50 request terakhir dari netmon"
- "berapa token yang dipakai 10 menit terakhir menurut netmon?"

Aksi yang tersedia: `summary`, `tail`, `stats`, `clear`.

## Opsi

Plugin dimuat otomatis dari folder `plugins` di direktori konfigurasi OpenCode:

- Linux/macOS: `~/.config/opencode/plugins/netmon`
- Windows: `%APPDATA%\opencode\plugins\netmon`

Jalankan `opencode debug paths` dan lihat baris `config` bila ragu. Untuk memberi
opsi, daftarkan path absolut folder plugin di `opencode.json` milik direktori itu:

```jsonc
{
  "plugins": [
    {
      "package": "/home/tamsis/.config/opencode/plugins/netmon",
      "options": {
        "file": "~/.local/share/opencode/netmon/traffic.jsonl",
        "maxMemory": 5000,
        "maxFileBytes": 33554432,
        "headers": true
      }
    }
  ]
}
```

- `file` — lokasi JSONL
- `maxMemory` — jumlah record di ring buffer (untuk tool)
- `maxFileBytes` — rotasi ke `<file>.1` saat ukuran terlampaui
- `headers` — catat header non-rahasia

Jika didaftarkan eksplisit **dan** folder plugin tetap berada di
`<config>/plugins/`, OpenCode dapat memuatnya dua kali. Pilih salah satu: biarkan
auto-load, atau pindahkan folder lalu daftarkan path-nya.

## Windows

Plugin ini berjalan di OpenCode Windows karena seluruh hook-nya ada di server
OpenCode dan kode hanya memakai API lintas platform (`node:fs`, `node:path`,
`node:os`, `fetch`, `crypto`, `TextEncoder`). Tidak ada shell, symlink, atau
perintah Unix yang dipakai saat runtime.

1. Salin folder `netmon` ke `%APPDATA%\opencode\plugins\netmon` (atau ke
   `<config>\plugins\netmon` sesuai output `opencode debug paths`).
2. Pastikan `%APPDATA%\opencode\plugins\netmon\index.ts` ada, lalu jalankan
   `/reload` di OpenCode. Tidak perlu restart service.
3. Log default: `%APPDATA%\opencode\netmon\traffic.jsonl`.
4. Viewer: jalankan `netmon.cmd`, atau minta agent memakai tool `netmon`.
   Python 3 dibutuhkan hanya untuk viewer, bukan untuk plugin.

Bila auto-load tidak jalan di build Windows Anda, daftarkan path absolut dengan
garis miring ganda atau garis miring biasa di `opencode.json`:

```jsonc
{
  "plugins": [
    {
      "package": "C:/Users/you/AppData/Roaming/opencode/plugins/netmon"
    }
  ]
}
```

Batasan yang sama tetap berlaku di Windows: hanya trafik model lewat transport
sesi OpenCode. Untuk melihat trafik seluruh proses, gunakan alat OS seperti
`netsh trace`, Wireshark, atau `Get-NetTCPConnection` — bukan plugin ini.

## Catatan

- Hook WebSocket masih eksperimental di OpenCode; bila runtime tidak
  mendukungnya, plugin tetap berjalan dan hanya bagian WS yang tidak aktif.
- Plugin tidak memblokir request: pembacaan body dilakukan pada salinan
  (`clone()`) dan berjalan di latar belakang.
- Log bisa memuat session ID dan URL internal. Jangan bagikan file log tanpa
  memeriksanya.
