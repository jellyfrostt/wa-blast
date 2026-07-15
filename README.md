# WA Blast

WhatsApp bulk messaging service built with [Baileys](https://github.com/WhiskeySockets/Baileys) and Express. Supports single/bulk message sending with auto-variation, reconnection handling, and template variables from CSV/Excel imports.

## Tech Stack

- **Runtime:** Node.js 20+
- **WA Library:** @whiskeysockets/baileys 6.7.23
- **Server:** Express 4
- **File Parsing:** csv-parse, xlsx
- **Auth:** Multi-file auth state (persisted in `./auth_info/`)

## Architecture

```
src/
  index.js        Express server + API routes
  wa-client.js    Baileys socket management + reconnection logic
  blast.js        Bulk send engine (retry, timeout, error classification)
  phone.js        Phone number formatting (ID format)
  public/
    index.html    Single-page frontend (vanilla JS)
```

### Connection Flow

1. Server starts -> `initWhatsApp()` creates Baileys socket
2. User scans QR at `/qr` or uses pairing code at `/pair?phone=628xxx`
3. Session credentials saved to `./auth_info/`
4. On disconnect: exponential backoff reconnect (max 8 attempts, 5s-60s + jitter)
5. On logout (kicked by WA): clear session, restart for fresh QR

### Message Flow (Blast)

1. Upload CSV/Excel via `/api/upload`
2. Compose template with `{{column_name}}` variables (case-insensitive)
3. Preview with `/api/preview`
4. Start blast via `/api/blast` -> runs async in background
5. Poll status via `/api/status`

Each message: 20s send timeout -> up to 2 retries on connection/timeout errors -> wait for reconnect if socket dies (30s max).

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/qr` | QR code page for WhatsApp login |
| GET | `/pair?phone=628xxx` | Get pairing code |
| GET | `/health` | Connection status + sender info |
| POST | `/api/disconnect` | Disconnect + clear session (to switch sender) |
| POST | `/api/upload` | Upload CSV/Excel contacts |
| POST | `/api/preview` | Preview template rendering |
| POST | `/api/send` | Send single message |
| POST | `/api/quick-send` | Send N varied messages to one number |
| POST | `/api/blast` | Start bulk blast |
| GET | `/api/status` | Blast job status (polling) |
| POST | `/api/cancel` | Cancel running blast |
| GET | `/api/history` | Past blast job history |
| GET | `/api/connection-log` | WA connection event log |
| POST | `/api/clear` | Clear uploaded contacts |

## Reliability Features

### Reconnection (wa-client.js)
- Max 8 reconnect attempts with exponential backoff (5s increments, capped at 60s + random jitter)
- Logged out detection: clears session files, restarts with fresh QR
- Connection log maintained (last 200 events)

### Blast Resilience (blast.js)
- **Send timeout:** 20s per message (prevents socket hangs)
- **Auto-retry:** 2 retries on connection/timeout errors with backoff
- **Reconnect wait:** If socket dies mid-blast, waits up to 30s for reconnection with 2s stability check
- **Rate limit handling:** 30-45s cooldown on rate limit detection, retries after
- **Consecutive error guard:** 5 errors -> 30s cooldown, 10 errors -> auto-stop
- **Ban detection:** Immediate stop if banned/blocked detected
- **Error classification:** rate_limit, banned, invalid_number, timeout, connection, auth

### Anti-Detection (Quick Send)
- Random greeting prefixes (Halo, Hai, Hi, Assalamualaikum, etc.)
- Punctuation variation (periods, double periods)
- Invisible character insertion (ZWSP, ZWNJ)
- Random closing lines
- Configurable delay between messages (default 3-8s, +30-60s pause every 10 messages)

## Template Variables

Templates use `{{column_name}}` syntax. Lookup is **case-insensitive** and supports column names with spaces.

```
Halo {{nama}}, terima kasih sudah order {{produk}}!
```

If the Excel column is `Nama` and template uses `{{nama}}`, it will resolve correctly.

## Phone Number Format

Accepts Indonesian formats and normalizes to international:
- `08123456789` -> `628123456789@s.whatsapp.net`
- `8123456789` -> `628123456789@s.whatsapp.net`
- `628123456789` -> `628123456789@s.whatsapp.net`

Numbers with fewer than 9 digits are skipped during blast.

## Setup

```bash
cp .env.example .env
npm install
npm start        # production
npm run dev      # dev with --watch
```

### Docker

```bash
docker build -t wa-blast .
docker run -p 3001:3001 -v ./auth_info:/app/auth_info wa-blast
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `LOG_LEVEL` | `info` | Pino log level (debug, info, warn, error) |

## Logs

Blast results are saved as JSON in `./logs/blast-{timestamp}.json` containing:
- Job metadata (id, status, duration, timestamps)
- Per-message results (phone, status, send time, retries)
- Error breakdown by type
- Rate limit hit count
- Max consecutive errors

Job history (last 50 jobs) is kept in-memory and available via `/api/history`.
