import fs from "fs";

const CLIENTS_PATH = "./clients.json";

// Normalise une entrée de `besoins` : les données créées avant ce correctif
// stockaient de simples chaînes ("formation", "produits finis"...) sans
// date. On les convertit à la volée pour ne jamais planter sur d'anciennes
// données, sans avoir besoin d'une migration manuelle du fichier JSON.
function normaliseBesoinEntry(entry) {
  if (typeof entry === "string") return { besoin: entry, date: null };
  return entry;
}

// Même modèle interne que clients.store.supabase.js, pour que le
// comportement soit identique avec ou sans Supabase : `besoins` garde
// l'historique daté ({besoin, date}[]), `besoin` (exposé, rétrocompatible)
// est toujours le libellé du plus récent.
function toClientView(row) {
  if (!row) return null;
  const besoins = (Array.isArray(row.besoins) ? row.besoins : []).map(normaliseBesoinEntry);
  return {
    ...row,
    besoin: besoins.length ? besoins[besoins.length - 1].besoin : null,
    besoinsHistorique: besoins,
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
// `besoin` (une valeur) est ajouté à l'historique `besoins` (avec sa date)
// plutôt que d'écraser — sauf s'il est identique au dernier déjà enregistré,
// pour ne pas empiler des doublons à chaque message du client.
export function upsertClient(phone, fields) {
  const { besoin, updatedAt, ...rest } = fields;
  const raw = readRaw();
  const existing = raw[phone] || {};
  const besoins = (Array.isArray(existing.besoins) ? existing.besoins : []).map(normaliseBesoinEntry);
  const contactsAt = Array.isArray(existing.contactsAt) ? existing.contactsAt : [];
  const nowIso = new Date().toISOString();

  const dernier = besoins[besoins.length - 1]?.besoin;
  const nextBesoins = besoin && besoin !== dernier ? [...besoins, { besoin, date: nowIso }] : besoins;

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
