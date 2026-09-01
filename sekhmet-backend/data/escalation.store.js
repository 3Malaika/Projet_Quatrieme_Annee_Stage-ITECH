import { db, parseJson } from './sqlite.db.js';

export async function listEscalations() {
  return db.prepare('SELECT data FROM escalation_logs ORDER BY created_at DESC').all()
    .map(r => parseJson(r.data, null)).filter(Boolean);
}

export async function getEscalation(id) {
  const row = db.prepare('SELECT data FROM escalation_logs WHERE id = ?').get(String(id));
  return row ? parseJson(row.data, null) : null;
}

export async function saveEscalation(entry) {
  db.prepare(`INSERT INTO escalation_logs(id,data,created_at,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`)
    .run(String(entry.id), JSON.stringify(entry), entry.createdAt || new Date().toISOString(), new Date().toISOString());
  return entry;
}
