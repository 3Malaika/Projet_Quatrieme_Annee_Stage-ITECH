import fs from "fs";
import crypto from "crypto";

const COMMANDES_PATH = "./commandes.json";

// Mêmes noms de champs (snake_case) que la version Supabase, pour que le
// reste du code n'ait jamais à se soucier du mode de stockage actif.

function readAll() {
  try {
    const raw = fs.readFileSync(COMMANDES_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeAll(commandes) {
  fs.writeFileSync(COMMANDES_PATH, JSON.stringify(commandes, null, 2));
}

export function loadCommandes() {
  return readAll().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export function getCommande(id) {
  return readAll().find((c) => c.id === id) || null;
}

export function createCommande(commande) {
  const commandes = readAll();
  const record = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    statut: "paiement_confirme",
    ...commande,
  };
  commandes.push(record);
  writeAll(commandes);
  return record;
}

export function updateCommande(id, fields) {
  const commandes = readAll();
  const index = commandes.findIndex((c) => c.id === id);
  if (index === -1) return null;
  commandes[index] = { ...commandes[index], ...fields };
  writeAll(commandes);
  return commandes[index];
}
