# WA Blast

WhatsApp bulk messaging service built with [Baileys](https://github.com/WhiskeySockets/Baileys) and Express. Supports multi-session login, bulk/single message sending, chat viewing, read receipt tracking, and reconnection handling.

## Tech Stack

- **Runtime:** Node.js 20+
- **WA Library:** @whiskeysockets/baileys 6.7.23
- **Server:** Express 4
- **Database:** SQLite via better-sqlite3 (message + session persistence)
- **File Parsing:** csv-parse, xlsx
- **Auth:** Multi-file auth state per session (`./auth_info/{sessionId}/`)

## Architecture

```
src/
  index.js        Express server + API routes
  db.js           SQLite database setup + prepared statements
  sessions.js     Multi-session WhatsApp manager (replaces wa-client.js)
  blast.js        Bulk send engine (session-aware, DB logging)
  history.js      Send history recorder (jobs + per-recipient items)
  phone.js        Phone number formatting (ID format)
  public/
    index.html    Single-page frontend (sidebar dashboard, vanilla JS)
```

### Multi-Session Design

Each WhatsApp account is a "session" with its own Baileys socket, auth directory, and QR code. Multiple sessions can be connected simultaneously for blasting from different numbers.

```
sessions (Map)
  "s_abc123" -> { sock, qr, reconnectAttempt, connectionLog }
  "s_def456" -> { sock, qr, reconnectAttempt, connectionLog }

auth_info/
  s_abc123/   -> creds.json, app-state-sync-key-*.json, ...
  s_def456/   -> creds.json, app-state-sync-key-*.json, ...

data/
  wa-blast.db -> sessions table, messages table (all sent/received/status)
```

### Connection Flow

1. Server starts -> `restoreSessions()` loads all sessions from DB and inits sockets
2. User creates a session via UI or `POST /api/sessions`
3. Scan QR or use pairing code to connect
4. Session credentials saved to `./auth_info/{sessionId}/`
5. On disconnect: exponential backoff reconnect (max 8 attempts, 5s-60s + jitter)
6. On logout (kicked by WA): clear session auth, restart for fresh QR
7. Legacy migration: existing `./auth_info/` files auto-migrated to `default` session

### Message Flow (Blast)

1. Select sender session from dropdown
2. Upload CSV/Excel via `/api/upload` -> returns an `uploadId` for that contact list
3. Compose template with `{{column_name}}` variables (case-insensitive)
4. Preview with `/api/preview`
5. Start blast via `/api/blast` with `sessionId` + `uploadId` -> runs async in background
6. All sent messages logged to SQLite with delivery status tracking
7. Read receipts tracked via Baileys `messages.update` events

Each message: 20s send timeout -> up to 2 retries on connection/timeout errors -> wait for reconnect if socket dies (30s max).

Each session runs at most one blast at a time, and different sessions can blast in parallel. Contact lists are kept per upload (in memory, 24h), so two people uploading at the same time do not overwrite each other.

### Message Tracking

Outgoing messages are stored in SQLite, together with the live chat that follows with each number they were sent to: replies, later topics, and messages the owner types on the phone, with no time cutoff. The Percakapan page refreshes the open conversation every 5 seconds. Nothing else is recorded: group chats, channels and private chats of the linked number are ignored, and chats this app did not start are neither listed nor readable through the API.

WhatsApp may deliver a reply under a hidden id (`...@lid`) instead of the phone number. Such a reply is matched to its recipient from the number attached to the message or, failing that, by asking WhatsApp for the hidden id of recent recipients (at most 50 numbers every 5 minutes per session). Until it is matched it stays unlisted, and it is deleted after 3 days or as soon as every recent recipient is known.

| Status | Meaning |
|--------|---------|
| `pending` | Message queued |
| `sent` | Server acknowledged |
| `delivered` | Delivered to recipient |
| `read` | Read by recipient |
| `failed` | Send failed after retries |
| `received` | Incoming message |

Status updates come from Baileys `messages.update` event (status enum: 2=sent, 3=delivered, 4=read).

## API Endpoints

### Session Management

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/sessions` | Create new session `{name}` (refused once `MAX_SESSIONS` is reached) |
| GET | `/api/limits` | Configured limits `{maxSessions}` |
| GET | `/api/sessions` | List all sessions |
| GET | `/api/sessions/:id` | Session detail + connection log |
| DELETE | `/api/sessions/:id` | Remove session (logout + clear auth) |
| GET | `/api/sessions/:id/qr` | Get QR data URL |
| POST | `/api/sessions/:id/pair` | Request pairing code `{phone}` |

### Chat & Messages

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions/:id/chats` | List conversations `?limit=50&offset=0&q=` (`q` filters by phone digits) |
| GET | `/api/sessions/:id/chats/:jid/messages` | Get messages `?limit=50&offset=0` |
| GET | `/api/blast/:jobId/stats` | Blast delivery stats (sent/delivered/read) |

### Messaging

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/send` | Send single message `{phone, message, sessionId?}` |
| POST | `/api/quick-send` | Send a message N times `{phone, message, count, sessionId?}`; the final stream line carries the history `jobId` |
| POST | `/api/blast` | Start bulk blast `{template, sessionId?, uploadId?, delayMin, delayMax}` |
| GET | `/api/status` | Blast job status for a session (polling) `?sessionId=` |
| POST | `/api/cancel` | Cancel a session's running blast `{sessionId?}` |
| GET | `/api/history` | Send history (blasts + quick sends), newest first `?limit=50&offset=0` |
| GET | `/api/history/:id` | One history job with its recipients `?limit=200&offset=0` |

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | All sessions status + contact count |
| GET | `/qr` | QR page (legacy, shows all pending QRs) |
| POST | `/api/upload` | Upload CSV/Excel contacts, returns `uploadId` |
| POST | `/api/preview` | Preview template rendering `{template, uploadId?}` |
| POST | `/api/disconnect` | Disconnect session `{sessionId?}` |
| GET | `/api/connection-log` | Connection event log `?sessionId=` |
| POST | `/api/clear` | Clear uploaded contacts `{uploadId?}` |

All send endpoints accept optional `sessionId`. If omitted, uses the first connected session. If `uploadId` is omitted, the most recent upload is used; without `sessionId`, status and cancel apply to the most recently started blast.

## Frontend

Sidebar dashboard in plain Indonesian, aimed at non-technical users. Pages are deep-linkable (`#kirim`, `#nomor`, `#cepat`, `#percakapan`, `#riwayat`, `#bantuan`).

1. **Kirim Pesan** - guided 5-step blast: pick sender number, write message, upload contacts, review with preview, then send with live progress, a confirmation before sending and a result dialog when done. Reopening the page re-attaches to a blast that is still running.
2. **Nomor WhatsApp** - add/remove WhatsApp numbers, scan QR with step-by-step instructions, or use a pairing code
3. **Kirim Cepat** - send a message to a single number
4. **Percakapan** - read-only conversations per number with delivery status, number search and load-more paging
5. **Riwayat** - every blast and quick send with sender, start/finish time and delivery breakdown, 20 per page; cards start collapsed and expand to show the message and each recipient. The result dialog shown after a send links straight to its card
6. **Bantuan** - getting-started guide and searchable FAQ

## Reliability Features

### Reconnection (sessions.js)
- Max 8 reconnect attempts per session with exponential backoff (5s increments, capped at 60s + random jitter)
- Logged out detection: clears session files, restarts with fresh QR
- Connection log maintained per session (last 200 events)

### Blast Resilience (blast.js)
- **Send timeout:** 20s per message (prevents socket hangs)
- **Auto-retry:** 2 retries on connection/timeout errors with backoff
- **Reconnect wait:** If socket dies mid-blast, waits up to 30s for reconnection with 2s stability check
- **Rate limit handling:** 30-45s cooldown on rate limit detection, retries after
- **Consecutive error guard:** 5 errors -> 30s cooldown, 10 errors -> auto-stop
- **Ban detection:** Immediate stop if banned/blocked detected
- **Error classification:** rate_limit, banned, invalid_number, timeout, connection, auth
- **DB logging:** Every sent/failed message stored in SQLite for tracking

### Pacing (Quick Send)
- Messages are sent exactly as typed, with no added greeting or variation
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
docker run -p 3001:3001 \
  -v ./auth_info:/app/auth_info \
  -v ./data:/app/data \
  wa-blast
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `LOG_LEVEL` | `info` | Pino log level (debug, info, warn, error) |
| `DB_PATH` | `./data/wa-blast.db` | SQLite database file path |
| `MAX_SESSIONS` | `10` | Maximum WhatsApp numbers that can be added; the dashboard shows this limit |

### Railway

Add a volume for `/app/data` to persist the SQLite database between deployments. The existing `/app/auth_info` volume continues to store per-session auth files.

## Data Storage

### SQLite Database (`./data/wa-blast.db`)
- **sessions** — id, name, phone, status, timestamps
- **messages** — session_id, jid, direction, content, message_id, status, blast_job_id, sender_name, timestamps
- **send_jobs** — id, type (blast/quick), session_id, session_name, session_phone, template, status, total, started_at, finished_at
- **send_job_items** — job_id, idx, phone, content, status, error, message_id, created_at
- **lid_map** — session_id, lid, pn: the hidden id (`...@lid`) of numbers this app has sent to, so their replies are filed under the right number

History keeps its own copy of the sender name/phone and recipients, so it survives removing a session. A job still marked `running` when the server starts is set to `interrupted`.

### JSON Logs (`./logs/`)
- Blast results saved as `blast-{timestamp}.json` (legacy, kept for backup)
- Contains job metadata, per-message results, error breakdown

### In-Memory
- Uploaded contact lists (per upload, 24h)
- Live progress of each session's current blast
- Connection logs per session (last 200 events)
