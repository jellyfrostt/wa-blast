import Database from "better-sqlite3";
import { mkdirSync } from "fs";

const dbPath = process.env.DB_PATH || "./data/wa-blast.db";
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
`);

export default db;

export const stmts = {
  insertSession: db.prepare("INSERT INTO sessions (id, name) VALUES (?, ?)"),
  updateSessionStatus: db.prepare('UPDATE sessions SET status = ?, updated_at = datetime("now") WHERE id = ?'),
  updateSessionPhone: db.prepare('UPDATE sessions SET phone = ?, status = \'connected\', updated_at = datetime("now") WHERE id = ?'),
  getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
  getAllSessions: db.prepare("SELECT * FROM sessions ORDER BY created_at"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),

  insertMessage: db.prepare(
    "INSERT INTO messages (session_id, jid, direction, content, message_id, status, blast_job_id, sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  updateMessageStatus: db.prepare(
    'UPDATE messages SET status = ?, updated_at = datetime("now") WHERE message_id = ? AND session_id = ?'
  ),
  getChats: db.prepare(`
    SELECT jid,
      MAX(created_at) as last_message_at,
      COUNT(*) as message_count,
      SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) as sent_count,
      SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) as received_count,
      SUM(CASE WHEN direction = 'outgoing' AND status = 'read' THEN 1 ELSE 0 END) as read_count,
      SUM(CASE WHEN direction = 'outgoing' AND status = 'delivered' THEN 1 ELSE 0 END) as delivered_count
    FROM messages WHERE session_id = ?
    GROUP BY jid ORDER BY last_message_at DESC LIMIT ? OFFSET ?
  `),
  getMessages: db.prepare(
    "SELECT * FROM messages WHERE session_id = ? AND jid = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
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
};
