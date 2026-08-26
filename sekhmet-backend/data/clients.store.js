import fs from "fs";

const CLIENTS_PATH = "./clients.json";

// Même modèle interne que clients.store.supabase.js, pour que le
// comportement soit identique avec ou sans Supabase : `besoins` garde
// l'historique, `besoin` (exposé) est toujours le plus récent.
function toClientView(row) {
  if (!row) return null;
  const besoins = Array.isArray(row.besoins) ? row.besoins : [];
  return {
    ...row,
    besoin: besoins.length ? besoins[besoins.length - 1] : null,
  };
}

function readRaw() {
  try {
    const raw = fs.readFileSync(CLIENTS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

function writeRaw(clients) {
  fs.writeFileSync(CLIENTS_PATH, JSON.stringify(clients, null, 2));
}

export function loadClients() {
  const raw = readRaw();
  return Object.fromEntries(Object.entries(raw).map(([phone, c]) => [phone, toClientView(c)]));
}

export function getClient(phone) {
  return toClientView(readRaw()[phone]) || null;
}

// Fusionne les nouvelles infos avec ce qui existe déjà pour ce client.
// `besoin` (une valeur) est ajouté à l'historique `besoins` plutôt que
// d'écraser (sauf s'il est identique au dernier déjà enregistré).
export function upsertClient(phone, fields) {
  const { besoin, updatedAt, ...rest } = fields;
  const raw = readRaw();
  const existing = raw[phone] || {};
  const besoins = Array.isArray(existing.besoins) ? existing.besoins : [];
  const contactsAt = Array.isArray(existing.contactsAt) ? existing.contactsAt : [];
  const nowIso = new Date().toISOString();

  const nextBesoins =
    besoin && besoin !== besoins[besoins.length - 1] ? [...besoins, besoin] : besoins;

  raw[phone] = {
    ...existing,
    ...rest,
    phone,
    besoins: nextBesoins,
    contactsAt: [...contactsAt, nowIso],
    updatedAt: nowIso,
  };
  writeRaw(raw);
  return toClientView(raw[phone]);
}
