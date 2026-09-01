import crypto from "crypto";
import { db, parseJson } from "./sqlite.db.js";

export function loadCommandes() {
  return db.prepare("SELECT data FROM orders ORDER BY created_at DESC").all().map((r) => parseJson(r.data, null)).filter(Boolean);
}

export function getCommande(id) {
  const row = db.prepare("SELECT data FROM orders WHERE id = ?").get(String(id));
  return row ? parseJson(row.data, null) : null;
}

export function createCommande(commande) {
  const record = { id: commande.id || crypto.randomUUID(), created_at: commande.created_at || new Date().toISOString(), statut: "paiement_confirme", ...commande };
  db.prepare("INSERT INTO orders(id,data,created_at) VALUES(?,?,?)").run(String(record.id), JSON.stringify(record), record.created_at);
  return record;
}

export function updateCommande(id, fields) {
  const existing = getCommande(id);
  if (!existing) return null;
  const updated = { ...existing, ...fields, id: existing.id };
  db.prepare("UPDATE orders SET data = ?, created_at = ? WHERE id = ?").run(JSON.stringify(updated), updated.created_at || existing.created_at || new Date().toISOString(), String(id));
  return updated;
}
