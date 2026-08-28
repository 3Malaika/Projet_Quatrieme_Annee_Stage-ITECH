import fs from "fs";

const LOGS_PATH = "./system_logs.json";

// Comme usage.store.js : pas fait pour un historique illimité, on garde les
// entrées les plus récentes, largement suffisant pour le panneau "Logs
// importants" du dashboard admin.
const MAX_ENTRIES = 500;

export function loadLogs() {
  try {
    const raw = fs.readFileSync(LOGS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function appendLog(entry) {
  const all = loadLogs();
  all.push(entry);
  const trimmed = all.length > MAX_ENTRIES ? all.slice(-MAX_ENTRIES) : all;
  fs.writeFileSync(LOGS_PATH, JSON.stringify(trimmed, null, 2));
}
