import { getSocket } from "./wa-client.js";
import { formatPhone, displayPhone } from "./phone.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let currentJob = null;

export function getJobStatus() {
  return currentJob;
}

export function cancelJob() {
  if (currentJob && currentJob.status === "running") {
    currentJob.status = "cancelled";
  }
}

function renderTemplate(template, row) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return row[key] ?? `{{${key}}}`;
  });
}

export async function startBlast(contacts, template, delayMin, delayMax, logger) {
  if (currentJob?.status === "running") {
    throw new Error("Blast sedang berjalan");
  }

  const sock = getSocket();
  if (!sock?.user) {
    throw new Error("WhatsApp belum terhubung");
  }

  currentJob = {
    status: "running",
    total: contacts.length,
    sent: 0,
    failed: 0,
    current: 0,
    results: [],
    startedAt: new Date().toISOString(),
  };

  (async () => {
    for (let i = 0; i < contacts.length; i++) {
      if (currentJob.status === "cancelled") {
        logger.info("Blast cancelled by user");
        break;
      }

      const row = contacts[i];
      const phoneCol = findPhoneColumn(row);
      if (!phoneCol) {
        currentJob.results.push({ index: i, phone: "?", status: "skipped", error: "No phone column" });
        currentJob.failed++;
        currentJob.current = i + 1;
        continue;
      }

      const phone = row[phoneCol];
      const message = renderTemplate(template, row);
      const jid = formatPhone(phone);
      const display = displayPhone(phone);

      try {
        await sock.sendMessage(jid, { text: message });
        currentJob.results.push({ index: i, phone: display, status: "sent" });
        currentJob.sent++;
        logger.info({ index: i, phone: display }, "Message sent");
      } catch (err) {
        currentJob.results.push({ index: i, phone: display, status: "failed", error: err.message });
        currentJob.failed++;
        logger.error({ index: i, phone: display, err: err.message }, "Send failed");
      }

      currentJob.current = i + 1;

      if (i < contacts.length - 1 && currentJob.status === "running") {
        const delay = Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin;
        await sleep(delay * 1000);
      }
    }

    if (currentJob.status === "running") {
      currentJob.status = "done";
    }
    currentJob.finishedAt = new Date().toISOString();
    logger.info({ sent: currentJob.sent, failed: currentJob.failed }, "Blast finished");
  })();

  return currentJob;
}

function findPhoneColumn(row) {
  const keys = Object.keys(row);
  const phoneAliases = ["phone", "hp", "no_hp", "nohp", "no_telp", "notelp", "nomor", "wa", "whatsapp", "telepon", "telp", "mobile", "handphone"];
  for (const k of keys) {
    if (phoneAliases.includes(k.toLowerCase().trim())) return k;
  }
  return null;
}
