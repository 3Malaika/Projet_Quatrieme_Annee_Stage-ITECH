import crypto from "crypto";
import { db, parseJson } from "./sqlite.db.js";

export function loadCatalogue() {
  return db.prepare("SELECT data FROM products ORDER BY rowid").all().map((r) => parseJson(r.data, null)).filter(Boolean);
}

export function saveCatalogue(catalogue) {
  try {
    db.exec("BEGIN");
    db.prepare("DELETE FROM products").run();
    const insert = db.prepare("INSERT INTO products(id,data,updated_at) VALUES(?,?,?)");
    const now = new Date().toISOString();
    for (const item of Array.isArray(catalogue) ? catalogue : []) {
      const id = String(item?.id ?? crypto.randomUUID());
      insert.run(id, JSON.stringify({ ...item, id }), item?.updated_at || now);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export const saveProduit = saveCatalogue;
export const deleteProduit = saveCatalogue;
