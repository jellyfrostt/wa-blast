import Database from "better-sqlite3";
import { mkdirSync } from "fs";

export const dbPath = process.env.DB_PATH || "./data/wa-blast.db";
mkdirSync(dbPath.replace(/\/[^/]+$/, ""), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    status TEXT DEFAULT 'disconnected',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    jid TEXT NOT NULL,
    direction TEXT NOT NULL,
    content TEXT,
    message_id TEXT,
    status TEXT DEFAULT 'pending',
    blast_job_id TEXT,
    sender_name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_msg_session_jid ON messages(session_id, jid);
  CREATE INDEX IF NOT EXISTS idx_msg_message_id ON messages(message_id);
  CREATE INDEX IF NOT EXISTS idx_msg_blast_job ON messages(blast_job_id);

  CREATE TABLE IF NOT EXISTS send_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    session_id TEXT NOT NULL,
    session_name TEXT,
    session_phone TEXT,
    template TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    total INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS send_job_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    phone TEXT,
    content TEXT,
    status TEXT NOT NULL,
    error TEXT,
    message_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES send_jobs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS chat_insights (
    session_id TEXT NOT NULL,
    jid TEXT NOT NULL,
    intent TEXT NOT NULL,
    level TEXT NOT NULL,
    summary TEXT,
    profile TEXT,
    next_step TEXT,
    model TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    analyzed_at TEXT NOT NULL,
    PRIMARY KEY (session_id, jid),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS lid_map (
    session_id TEXT NOT NULL,
    lid TEXT NOT NULL,
    pn TEXT NOT NULL,
    PRIMARY KEY (session_id, lid),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_job_started ON send_jobs(started_at);
  CREATE INDEX IF NOT EXISTS idx_job_items_job ON send_job_items(job_id, idx);
`);

// Privacy: this app only keeps replies from numbers it has sent to. Remove anything else that was
// recorded (group chats, private chats) and hidden-id mappings that no longer point at a recipient.
// Messages under a hidden id ("@lid") may still be a recipient's reply waiting to be matched, so
// they get a short grace period; contacts.js merges or deletes them.
db.prepare(`
  DELETE FROM messages WHERE direction = 'incoming' AND jid NOT LIKE '%@lid' AND NOT EXISTS (
    SELECT 1 FROM messages o WHERE o.session_id = messages.session_id AND o.jid = messages.jid AND o.direction = 'outgoing'
  )
`).run();
db.prepare("DELETE FROM messages WHERE jid LIKE '%@lid' AND created_at < datetime('now', '-3 days')").run();
db.prepare(`
  DELETE FROM lid_map WHERE NOT EXISTS (
    SELECT 1 FROM messages o WHERE o.session_id = lid_map.session_id AND o.jid = lid_map.pn AND o.direction = 'outgoing'
  )
`).run();

// Nothing can be running at process start, so leftovers are jobs cut off by a restart.
db.prepare(
  "UPDATE send_jobs SET status = 'interrupted', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status = 'running'"
).run();

export default db;

// Numbers this session sent to in the last 14 days whose hidden id is not known yet.
const UNMAPPED_RECIPIENTS = `
  SELECT DISTINCT m.jid FROM messages m
  WHERE m.session_id = ? AND m.direction = 'outgoing' AND m.jid LIKE '%@s.whatsapp.net'
    AND m.created_at >= datetime('now', '-14 days')
    AND NOT EXISTS (SELECT 1 FROM lid_map l WHERE l.session_id = m.session_id AND l.pn = m.jid)`;

export const stmts = {
  insertSession: db.prepare("INSERT INTO sessions (id, name) VALUES (?, ?)"),
  // A removed number keeps its row (status 'removed') so its chats stay readable; late socket
  // events must not bring it back to life.
  updateSessionStatus: db.prepare("UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ? AND status != 'removed'"),
  updateSessionPhone: db.prepare("UPDATE sessions SET phone = ?, status = 'connected', updated_at = datetime('now') WHERE id = ? AND status != 'removed'"),
  getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
  getAllSessions: db.prepare("SELECT * FROM sessions WHERE status != 'removed' ORDER BY created_at"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
  archiveSession: db.prepare("UPDATE sessions SET status = 'removed', updated_at = datetime('now') WHERE id = ?"),
  sessionHasMessages: db.prepare("SELECT 1 FROM messages WHERE session_id = ? LIMIT 1"),
  getArchivedSessions: db.prepare(
    "SELECT id, name, phone, updated_at AS removed_at FROM sessions WHERE status = 'removed' ORDER BY updated_at DESC"
  ),

  insertMessage: db.prepare(
    "INSERT INTO messages (session_id, jid, direction, content, message_id, status, blast_job_id, sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  updateMessageStatus: db.prepare(
    "UPDATE messages SET status = ?, updated_at = datetime('now') WHERE message_id = ? AND session_id = ?"
  ),
  getChats: db.prepare(`
    SELECT c.*,
      i.intent AS insight_intent, i.level AS insight_level, i.summary AS insight_summary,
      i.profile AS insight_profile, i.next_step AS insight_next_step,
      i.analyzed_at AS insight_at, i.message_count AS insight_message_count
    FROM (
      SELECT jid,
        MAX(created_at) as last_message_at,
        MAX(CASE WHEN direction = 'incoming' THEN sender_name END) as contact_name,
        COUNT(*) as message_count,
        SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) as sent_count,
        SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) as received_count,
        SUM(CASE WHEN direction = 'outgoing' AND status = 'read' THEN 1 ELSE 0 END) as read_count,
        SUM(CASE WHEN direction = 'outgoing' AND status = 'delivered' THEN 1 ELSE 0 END) as delivered_count
      FROM messages WHERE session_id = ? AND jid LIKE ? AND jid LIKE '%@s.whatsapp.net'
      GROUP BY jid HAVING sent_count > 0 ORDER BY last_message_at DESC, jid LIMIT ? OFFSET ?
    ) c
    LEFT JOIN chat_insights i ON i.session_id = ? AND i.jid = c.jid
    ORDER BY c.last_message_at DESC, c.jid
  `),
  // Conversations this app started, oldest message first: the raw material for exports and analysis.
  transcriptRows: db.prepare(`
    SELECT jid, direction, content, status, sender_name, created_at FROM messages
    WHERE session_id = ? AND jid LIKE '%@s.whatsapp.net'
      AND jid IN (SELECT DISTINCT jid FROM messages WHERE session_id = ? AND direction = 'outgoing')
    ORDER BY jid, created_at, id
  `),
  recentMessages: db.prepare(`
    SELECT * FROM (
      SELECT id, direction, content, created_at FROM messages
      WHERE session_id = ? AND jid = ? ORDER BY created_at DESC, id DESC LIMIT ?
    ) ORDER BY created_at, id
  `),
  chatCounts: db.prepare(`
    SELECT jid, COUNT(*) AS n, SUM(direction = 'incoming') AS incoming, SUM(direction = 'outgoing') AS outgoing
    FROM messages WHERE session_id = ? AND jid LIKE '%@s.whatsapp.net' GROUP BY jid
  `),
  getInsight: db.prepare("SELECT * FROM chat_insights WHERE session_id = ? AND jid = ?"),
  getInsights: db.prepare("SELECT jid, message_count FROM chat_insights WHERE session_id = ?"),
  upsertInsight: db.prepare(`
    INSERT INTO chat_insights (session_id, jid, intent, level, summary, profile, next_step, model, message_count, analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, jid) DO UPDATE SET intent = excluded.intent, level = excluded.level,
      summary = excluded.summary, profile = excluded.profile, next_step = excluded.next_step,
      model = excluded.model, message_count = excluded.message_count, analyzed_at = excluded.analyzed_at
  `),
  getMessages: db.prepare(
    "SELECT * FROM messages WHERE session_id = ? AND jid = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
  ),
  getBlastMessages: db.prepare(
    "SELECT * FROM messages WHERE blast_job_id = ? ORDER BY created_at"
  ),
  getBlastStats: db.prepare(`
    SELECT blast_job_id,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'sent' OR status = 'delivered' OR status = 'read' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN status = 'read' THEN 1 ELSE 0 END) as read_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM messages WHERE blast_job_id = ? GROUP BY blast_job_id
  `),

  upsertLid: db.prepare(
    "INSERT INTO lid_map (session_id, lid, pn) VALUES (?, ?, ?) ON CONFLICT(session_id, lid) DO UPDATE SET pn = excluded.pn"
  ),
  getLid: db.prepare("SELECT pn FROM lid_map WHERE session_id = ? AND lid = ?"),
  relabelMessages: db.prepare("UPDATE messages SET jid = ? WHERE session_id = ? AND jid = ?"),
  hasOutgoing: db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND jid = ? AND direction = 'outgoing' LIMIT 1"),
  hasMessageId: db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND message_id = ? LIMIT 1"),
  unmappedRecipients: db.prepare(UNMAPPED_RECIPIENTS + " LIMIT 500"),
  hasUnmappedRecipient: db.prepare(UNMAPPED_RECIPIENTS + " LIMIT 1"),
  hasHiddenRows: db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND jid LIKE '%@lid' LIMIT 1"),
  deleteHiddenRows: db.prepare("DELETE FROM messages WHERE session_id = ? AND jid LIKE '%@lid'"),
  deleteOldHiddenRows: db.prepare("DELETE FROM messages WHERE session_id = ? AND jid LIKE '%@lid' AND created_at < datetime('now', '-3 days')"),

  insertJob: db.prepare(
    "INSERT INTO send_jobs (id, type, session_id, session_name, session_phone, template, total, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  insertJobItem: db.prepare(
    "INSERT INTO send_job_items (job_id, idx, phone, content, status, error, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  finishJob: db.prepare("UPDATE send_jobs SET status = ?, finished_at = ? WHERE id = ?"),
  getJob: db.prepare("SELECT * FROM send_jobs WHERE id = ?"),
  getJobs: db.prepare(`
    SELECT j.*,
      COALESCE(SUM(i.status = 'sent'), 0) AS sent,
      COALESCE(SUM(i.status = 'failed'), 0) AS failed,
      COALESCE(SUM(i.status = 'skipped'), 0) AS skipped,
      COALESCE(SUM(m.status = 'delivered'), 0) AS delivered,
      COALESCE(SUM(m.status = 'read'), 0) AS read_count
    FROM (SELECT * FROM send_jobs ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?) j
    LEFT JOIN send_job_items i ON i.job_id = j.id
    LEFT JOIN messages m ON m.message_id = i.message_id AND m.session_id = j.session_id
    GROUP BY j.id ORDER BY j.started_at DESC, j.id DESC
  `),
  getJobItems: db.prepare(`
    SELECT i.idx, i.phone, i.content, i.status, i.error, i.created_at, m.status AS delivery_status
    FROM send_job_items i
    LEFT JOIN messages m ON m.message_id = i.message_id AND m.session_id = ?
    WHERE i.job_id = ? ORDER BY i.idx LIMIT ? OFFSET ?
  `),
};
