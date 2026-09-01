import { db, parseJson } from "./sqlite.db.js";
const MAX_ENTRIES = 500;
export function loadLogs() { return db.prepare("SELECT id,data FROM system_logs ORDER BY created_at DESC LIMIT ?").all(MAX_ENTRIES).map(r => ({ id: r.id, ...parseJson(r.data, {}) })); }
export function appendLog(entry) { db.prepare("INSERT INTO system_logs(data,created_at) VALUES(?,?)").run(JSON.stringify(entry), entry?.created_at || new Date().toISOString()); db.prepare("DELETE FROM system_logs WHERE id NOT IN (SELECT id FROM system_logs ORDER BY created_at DESC LIMIT ?)").run(MAX_ENTRIES); return true; }
