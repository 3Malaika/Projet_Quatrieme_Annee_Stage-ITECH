import { db, parseJson } from "./sqlite.db.js";

function normaliseBesoinEntry(entry) { return typeof entry === "string" ? { besoin: entry, date: null } : entry; }
function toClientView(row) {
  if (!row) return null;
  const besoins = (Array.isArray(row.besoins) ? row.besoins : []).map(normaliseBesoinEntry);
  return { ...row, besoin: besoins.length ? besoins[besoins.length - 1].besoin : null, besoinsHistorique: besoins };
}

export function loadClients() {
  return Object.fromEntries(db.prepare("SELECT phone,data FROM clients").all().map(({ phone, data }) => [phone, toClientView(parseJson(data, {}))]));
}
export function getClient(phone) {
  const row = db.prepare("SELECT data FROM clients WHERE phone = ?").get(phone);
  return row ? toClientView(parseJson(row.data, {})) : null;
}
export function upsertClient(phone, fields) {
  const { besoin, updatedAt, ...rest } = fields;
  const existing = getClient(phone) || {};
  const besoins = (Array.isArray(existing.besoins) ? existing.besoins : []).map(normaliseBesoinEntry);
  const nowIso = new Date().toISOString();
  const dernier = besoins[besoins.length - 1]?.besoin;
  const nextBesoins = besoin && besoin !== dernier ? [...besoins, { besoin, date: nowIso }] : besoins;
  const record = { ...existing, ...rest, phone, besoins: nextBesoins, contactsAt: [...(Array.isArray(existing.contactsAt) ? existing.contactsAt : []), nowIso], updatedAt: nowIso };
  db.prepare("INSERT INTO clients(phone,data,updated_at) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at").run(phone, JSON.stringify(record), nowIso);
  return toClientView(record);
}
