import { mkdirSync, readdirSync, unlinkSync, existsSync, statSync } from "fs";
import { dirname, join } from "path";
import db, { dbPath } from "./db.js";

// Daily snapshots next to the database. They protect against a bad deploy, a corrupt file or an
// accidental delete, not against losing the volume itself: for that, pull /api/backup off-site.

const KEEP = Math.max(0, parseInt(process.env.BACKUP_KEEP ?? "7") || 0);
const NAME = /^wa-blast-\d{4}-\d{2}-\d{2}\.db$/;
export const backupDir = join(dirname(dbPath), "backups");
const fileFor = (date) => join(backupDir, `wa-blast-${date.toISOString().slice(0, 10)}.db`);

function prune() {
  const files = readdirSync(backupDir).filter((f) => NAME.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) unlinkSync(join(backupDir, f));
}

export async function createBackup(date = new Date()) {
  mkdirSync(backupDir, { recursive: true });
  const target = fileFor(date);
  await db.backup(target);
  prune();
  return target;
}

// A consistent copy for download; the caller deletes it when done.
export async function createSnapshot() {
  mkdirSync(backupDir, { recursive: true });
  for (const f of readdirSync(backupDir).filter((n) => n.startsWith("download-"))) {
    const file = join(backupDir, f);
    try { if (Date.now() - statSync(file).mtimeMs > 60 * 60 * 1000) unlinkSync(file); } catch {}
  }
  const target = join(backupDir, `download-${Date.now()}.tmp`);
  await db.backup(target);
  return target;
}

export function startBackups(logger) {
  if (KEEP === 0) return;
  const tick = async () => {
    try {
      if (existsSync(fileFor(new Date()))) return;
      const file = await createBackup();
      logger.info({ file, keep: KEEP }, "Database backup written");
    } catch (err) {
      logger.error({ err: err.message }, "Database backup failed");
    }
  };
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 6 * 60 * 60 * 1000).unref();
}
