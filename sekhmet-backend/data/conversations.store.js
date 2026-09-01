import { db, parseJson } from "./sqlite.db.js";

export function loadConversations() {
  return Object.fromEntries(db.prepare("SELECT phone,data FROM conversations").all().map(({ phone, data }) => [phone, parseJson(data, [])]));
}
export async function saveConversations(conversations) {
  try {
    db.exec("BEGIN");
    const upsert = db.prepare("INSERT INTO conversations(phone,data,updated_at) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at");
    const now = new Date().toISOString();
    for (const [phone, history] of Object.entries(conversations || {})) upsert.run(phone, JSON.stringify(history), now);
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
}
export function deleteConversation(phone) { db.prepare("DELETE FROM conversations WHERE phone = ?").run(phone); }
