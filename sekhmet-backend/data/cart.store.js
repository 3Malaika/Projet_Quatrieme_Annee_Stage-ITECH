import { db, parseJson } from "./sqlite.db.js";

export async function loadCarts() {
  return Object.fromEntries(db.prepare("SELECT phone,data FROM carts").all().map(r => [r.phone, parseJson(r.data, [])]));
}
export async function getCart(phone) {
  const r = db.prepare("SELECT data FROM carts WHERE phone = ?").get(phone);
  return r ? parseJson(r.data, []) : [];
}
export async function upsertCart(phone, items) {
  db.prepare(`INSERT INTO carts(phone,data,updated_at) VALUES(?,?,?)
    ON CONFLICT(phone) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`)
    .run(phone, JSON.stringify(Array.isArray(items) ? items : []), new Date().toISOString());
  return items;
}
export async function deleteCart(phone) { db.prepare("DELETE FROM carts WHERE phone = ?").run(phone); }
