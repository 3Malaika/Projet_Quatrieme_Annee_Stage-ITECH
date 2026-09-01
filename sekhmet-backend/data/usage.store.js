import { db, parseJson } from "./sqlite.db.js";
const MAX_ENTRIES = 50000;
export function loadUsage() { return db.prepare("SELECT data FROM usage ORDER BY created_at DESC LIMIT ?").all(MAX_ENTRIES).map(r => parseJson(r.data, null)).filter(Boolean); }
export function appendUsage(entry) { db.prepare("INSERT INTO usage(data,created_at) VALUES(?,?)").run(JSON.stringify(entry), entry?.created_at || new Date().toISOString()); db.prepare("DELETE FROM usage WHERE id NOT IN (SELECT id FROM usage ORDER BY created_at DESC LIMIT ?)").run(MAX_ENTRIES); return true; }
