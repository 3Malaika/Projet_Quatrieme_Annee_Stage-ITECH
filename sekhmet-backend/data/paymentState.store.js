import { db, parseJson } from "./sqlite.db.js";
export async function loadPaymentStates() { return Object.fromEntries(db.prepare("SELECT phone,data FROM payment_states").all().map(r => [r.phone, parseJson(r.data, {})])); }
export async function getPaymentState(phone) { const r = db.prepare("SELECT data FROM payment_states WHERE phone = ?").get(phone); return r ? parseJson(r.data, null) : null; }
export async function upsertPaymentState(phone, state) { db.prepare("INSERT INTO payment_states(phone,data,updated_at) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at").run(phone, JSON.stringify(state), new Date().toISOString()); return state; }
export async function deletePaymentState(phone) { db.prepare("DELETE FROM payment_states WHERE phone = ?").run(phone); }
