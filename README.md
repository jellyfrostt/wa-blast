# WA Blast

WhatsApp bulk messaging service built with [Baileys](https://github.com/WhiskeySockets/Baileys) and Express. Several WhatsApp numbers can be linked at once; each can run a bulk blast, and the conversations that follow are recorded, shown live, exportable and optionally analysed with Claude.

Team-facing documentation in Indonesian: [docs/DOKUMENTASI.md](docs/DOKUMENTASI.md). Plans: [docs/ROADMAP.md](docs/ROADMAP.md).

## Tech stack

- **Runtime:** Node.js 22 (Dockerfile uses `node:22-slim`; better-sqlite3 13 needs it)
- **WhatsApp:** @whiskeysockets/baileys 6.7.23
- **Server:** Express 4, no authentication on any endpoint
- **Database:** SQLite via better-sqlite3 (WAL mode)
- **File parsing:** csv-parse, xlsx
- **Frontend:** one HTML file, vanilla JS

## Source layout

```
src/
  index.js      Express app and all HTTP routes
  db.js         SQLite schema, startup cleanup, prepared statements
  sessions.js   One Baileys socket per linked number, reconnect logic
  blast.js      Bulk send engine, one job per number
  history.js    Send history recorder (jobs and per-recipient items)
  contacts.js   Which chats are recorded, and hidden-id (@lid) matching
  insights.js   Customer-intent analysis with the Claude API
  backup.js     Daily database snapshots and download snapshot
  phone.js      Indonesian phone number normalisation
  wa-client.js  Legacy single-number client, no longer imported
  public/index.html   Dashboard (sidebar, six pages)
```

## How it works

### Numbers (sessions)

Each linked WhatsApp number is a session with its own socket and auth directory `./auth_info/{sessionId}/`. Sessions are restored from the database at startup. On disconnect the socket retries up to 8 times (attempt x 5 s, capped at 60 s, plus up to 3 s jitter); after that it stops and the dashboard offers a manual reconnect. If WhatsApp logs the device out, the auth files are cleared and a fresh QR is shown.

At most `MAX_SESSIONS` numbers can exist. Removing a number that has chats archives it (`status = 'removed'`) so its conversations stay readable; a number without chats is deleted.

### Sending

- **Blast** (`/api/blast`): contacts come from an upload (`uploadId`), the template uses `{{column}}` placeholders (case-insensitive, spaces allowed). One blast per number at a time; different numbers blast in parallel. Per message: 20 s send timeout, up to 2 retries on connection, timeout or rate-limit errors (5 s then 10 s backoff), 30 s wait for a reconnect. A rate limit adds a 30-45 s cooldown. Five consecutive failures pause 30 s, ten stop the blast, a ban error stops it immediately. Numbers with fewer than 9 digits, or rows without a phone column, are skipped.
- **Quick send** (`/api/quick-send`): the same message 1-200 times to one number, streamed as NDJSON. 3-8 s between messages and a 30-60 s pause every 10th.
- **Reply** (`POST /api/sessions/:id/chats/:jid/messages`): a single message inside an existing conversation.

Messages are sent exactly as written. Delays are clamped to 0-600 s.

### What is recorded

Outgoing messages are stored, together with the live chat that follows with each number that was successfully sent to: replies, later topics, and messages the owner types on the phone, with no time cutoff. Nothing else is recorded: group chats, channels and chats with numbers this app never sent to are ignored, and a chat is neither listed nor readable through the API unless this app started it. A failed send does not start a conversation. Media is stored as `[media]` or its caption only.

WhatsApp may deliver a message under a hidden id (`...@lid`) instead of the phone number. It is matched to its recipient from the number attached to the message, from a remembered mapping, or by asking WhatsApp for the hidden id of recent recipients (`sock.onWhatsApp`, at most 50 numbers every 5 minutes per number, recipients of the last 14 days). An unmatched incoming message is kept unlisted while any recent recipient is still unmatched, and deleted after 3 days or once every recent recipient is known. This lookup has not yet been verified against live WhatsApp traffic.

Delivery status comes from Baileys `messages.update` (2 sent, 3 delivered, 4 and 5 read).

### Send history

Every blast and quick send is a row in `send_jobs` with one `send_job_items` row per recipient. History keeps its own copy of sender name, number and recipients, so it survives removing a number. A job still `running` at startup is marked `interrupted`. Replies sent from the conversation view are not history jobs.

### Customer-intent analysis

Off unless `ANTHROPIC_API_KEY` is set. For one conversation, the last 80 messages (1500 characters each) are sent to the Claude Messages API with a forced tool call, and the answer is stored in `chat_insights`: intent (`jual_lm`, `beli_lm`, `jual_dan_beli`, `tidak_tertarik`, `belum_jelas`), level (`tinggi`, `sedang`, `rendah`), summary, profile, next step. Only conversations with a customer reply are analysed. The API call is covered by tests with a fake HTTP client only; it has not been run against the real API.

### Backups

A snapshot `backups/wa-blast-YYYY-MM-DD.db` is written next to the database once per UTC day (first check 60 s after start, then every 6 h) and the newest `BACKUP_KEEP` are kept. They sit on the same volume as the database. `GET /api/backup` returns a fresh consistent copy for off-site storage, only when `BACKUP_TOKEN` is set.

## API

All endpoints are unauthenticated.

### Numbers

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/sessions` | Add a number `{name}`; 400 once `MAX_SESSIONS` is reached |
| GET | `/api/sessions` | Numbers that are not removed, with `connected`, `hasQr`, `canReconnect` |
| GET | `/api/sessions/archived` | Removed numbers that still have chats |
| GET | `/api/sessions/:id` | Detail and connection log |
| DELETE | `/api/sessions/:id` | Remove a number; cancels its running blast; chats and history are kept |
| GET | `/api/sessions/:id/qr` | QR as data URL |
| POST | `/api/sessions/:id/pair` | Pairing code `{phone}` |
| POST | `/api/sessions/:id/reconnect` | Reconnect after the automatic retries were used up; 409 otherwise |
| GET | `/api/limits` | `{maxSessions}` |
| POST | `/api/disconnect` | Legacy: removes the session `{sessionId?}` |

### Conversations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions/:id/chats` | Conversations `?limit=50&offset=0&q=` (`q` matches phone digits), with analysis fields |
| GET | `/api/sessions/:id/chats/:jid/messages` | Messages, newest first `?limit=50&offset=0` |
| POST | `/api/sessions/:id/chats/:jid/messages` | Reply `{message}`; 404 if not a conversation this app started, 409 if the number is not connected |
| GET | `/api/sessions/:id/transcripts` | All conversations as JSON, or `?format=csv` (UTF-8 with BOM, formula-safe, times in UTC) |
| GET | `/api/insights/status` | `{enabled, model}` |
| POST | `/api/sessions/:id/chats/:jid/insight` | Analyse one conversation |
| POST | `/api/sessions/:id/insights` | Analyse up to 10 conversations that need it; returns `{analyzed, failed, remaining}` |

### Sending

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/upload` | CSV/Excel contacts (10 MB, first sheet), returns `uploadId`; optional `replaces` |
| POST | `/api/preview` | Render the template for the first 3 rows `{template, uploadId?}` |
| POST | `/api/blast` | Start a blast `{template, sessionId?, uploadId?, delayMin, delayMax}` |
| GET | `/api/status` | Blast job for a number `?sessionId=`, with the latest 100 results |
| POST | `/api/cancel` | Cancel a number's blast `{sessionId?}` |
| POST | `/api/clear` | Drop an upload `{uploadId?}` |
| POST | `/api/quick-send` | `{phone, message, count, sessionId?}`; the final stream line carries the history `jobId` |
| POST | `/api/send` | One message `{phone, message, sessionId?}` |

Without `sessionId`, the first connected number is used (or the first number of any state). Without `uploadId`, the most recent upload is used. Without `sessionId`, status and cancel apply to the most recently started blast.

### History and system

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/history` | Send history, newest first `?limit=50&offset=0` |
| GET | `/api/history/:id` | One job with its recipients `?limit=200&offset=0` |
| GET | `/api/blast/:jobId/stats` | Delivery counts for a blast |
| GET | `/api/connection-log` | Connection events `?sessionId=` |
| GET | `/api/backup` | Database copy; needs `BACKUP_TOKEN` and `Authorization: Bearer <token>` |
| GET | `/health` | 200 when at least one number is connected, else 503 |
| GET | `/qr` | Legacy page listing pending QR codes |

## Data

### SQLite (`DB_PATH`)

- **sessions** — id, name, phone, status (`removed` for archived numbers), timestamps
- **messages** — session_id, jid, direction, content, message_id, status (`sent`, `delivered`, `read`, `failed`, `received`), blast_job_id, sender_name, timestamps
- **send_jobs** — id, type (`blast`/`quick`), session_id, session_name, session_phone, template, status, total, started_at, finished_at
- **send_job_items** — job_id, idx, phone, content, status, error, message_id, created_at
- **lid_map** — session_id, lid, pn: hidden ids of numbers this app sent to
- **chat_insights** — session_id, jid, intent, level, summary, profile, next_step, model, message_count, analyzed_at

At startup the database deletes incoming messages of chats this app did not start, hidden-id messages older than 3 days and stale `lid_map` rows, and marks leftover running jobs `interrupted`.

### Not in the database

- `./auth_info/{sessionId}/` — WhatsApp credentials per number
- `backups/` next to the database — daily snapshots
- `./logs/blast-*.json` — one JSON log per finished blast, relative to the working directory (not on the Railway volume)
- In memory only: uploaded contact lists (24 h, dropped at the next upload after expiry), live blast progress, connection logs (200 events per number), QR and pairing codes

## Setup

```bash
cp .env.example .env
npm install
npm start        # production
npm run dev      # node --watch
```

### Docker

```bash
docker build -t wa-blast .
docker run -p 3001:3001 -v ./auth_info:/app/auth_info -v ./data:/app/data wa-blast
```

The Dockerfile copies `package.json` only and runs `npm install`, so builds are not pinned to `package-lock.json`.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `LOG_LEVEL` | `info` | Pino log level |
| `DB_PATH` | `./data/wa-blast.db` | SQLite file; backups are written to `backups/` beside it |
| `MAX_SESSIONS` | `10` | Maximum numbers that can be added |
| `BACKUP_KEEP` | `7` | Daily snapshots to keep (`0` disables them) |
| `BACKUP_TOKEN` | unset | Enables `GET /api/backup` |
| `ANTHROPIC_API_KEY` | unset | Enables customer-intent analysis |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Model used for analysis |
| `INSIGHT_CONTEXT` | LM (gold bullion) buy/sell | Business context given to the model |

### Railway

The service is deployed with `railway up` from the working directory; nothing ties it to a git branch. There is one volume, mounted at `/app/auth_info`, and `DB_PATH=/app/auth_info/_data/wa-blast.db` keeps the database (and its backups) on that volume. A deploy restarts the server: numbers reconnect by themselves, a running blast is interrupted.

## Known limits

- No login: anyone with the URL can read every conversation, send, reply, remove numbers and download transcripts.
- Load-tested only locally with fake WhatsApp sockets (up to 500 numbers blasting in parallel). Memory per real WhatsApp connection and the Railway container's capacity are unmeasured.
- The tests replace WhatsApp with fake sockets. Nothing in the suite talks to real WhatsApp or the real Claude API.

## Tests

```bash
npm test
```

`test/run.mjs` starts the real server once per suite (Node's `--experimental-test-module-mocks` swaps `src/sessions.js` for fake connected numbers), on port 3999, with the database in a temporary folder. Suites: parallel blasts, send history, list paging and search, the number limit, what is recorded and hidden-id matching, archived numbers and backups, reply/transcripts/analysis, and input hardening.
