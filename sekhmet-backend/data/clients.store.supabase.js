/**
 * Store clients — version Supabase.
 * Même interface publique que clients.store.js : { phone, nom, besoin,
 * besoinsHistorique, updatedAt }.
 *
 * En base, l'historique est conservé (un client peut avoir plusieurs
 * besoins dans le temps, chacun daté) :
 *   - besoins      JSONB  : liste des besoins exprimés, [{besoin, date}],
 *                           dans l'ordre chronologique
 *   - contacts_at  JSONB  : liste des dates de contact (une entrée par
 *                           upsertClient, donc à chaque fois qu'on apprend
 *                           quelque chose de nouveau sur ce client)
 *
 * Le reste du code (webhook, routes admin, chat.service) connaît surtout
 * `besoin` (le plus récent, rétrocompatible) : on le dérive de `besoins` à
 * la lecture. `besoinsHistorique` expose la liste complète pour l'admin.
 */
import { supabase } from "./supabase.client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("clients.store.supabase");

// Rétrocompatibilité : d'anciennes lignes peuvent contenir de simples
// chaînes dans `besoins` (avant l'ajout des dates) — on les normalise à la
// volée plutôt que d'exiger une migration SQL des données existantes.
function normaliseBesoinEntry(entry) {
  if (typeof entry === "string") return { besoin: entry, date: null };
  return entry;
}

function toClientView(row) {
  if (!row) return null;
  const besoins = (Array.isArray(row.besoins) ? row.besoins : []).map(normaliseBesoinEntry);
  return {
    ...row,
    besoin: besoins.length ? besoins[besoins.length - 1].besoin : null,
    besoinsHistorique: besoins,
  };
}

export async function loadClients() {
  const { data, error } = await supabase.from("clients").select("*");
  if (error) {
    log.error("Erreur loadClients", error);
    return {};
  }
  // Reconstitue le format { [phone]: client } attendu par le reste du code
  return Object.fromEntries(data.map((c) => [c.phone, toClientView(c)]));
}

export async function getClient(phone) {
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("phone", phone)
    .single();

  if (error) return null;
  return toClientView(data);
}

// `fields` garde l'interface historique : { nom?, besoin?, updatedAt? }.
// On traduit `besoin` (une valeur) vers un ajout daté dans l'historique
// `besoins` (sauf s'il est identique au dernier déjà enregistré, pour ne
// pas empiler des doublons à chaque message). `updatedAt` est ignoré :
// c'est le store qui gère `updated_at` lui-même.
export async function upsertClient(phone, fields) {
  const { besoin, updatedAt, ...rest } = fields;

  const { data: existing } = await supabase
    .from("clients")
    .select("besoins, contacts_at")
    .eq("phone", phone)
    .single();

  const besoins = (Array.isArray(existing?.besoins) ? existing.besoins : []).map(normaliseBesoinEntry);
  const contactsAt = Array.isArray(existing?.contacts_at) ? existing.contacts_at : [];
  const nowIso = new Date().toISOString();

  const dernier = besoins[besoins.length - 1]?.besoin;
  const nextBesoins = besoin && besoin !== dernier ? [...besoins, { besoin, date: nowIso }] : besoins;

  const { data, error } = await supabase
    .from("clients")
    .upsert({
      phone,
      ...rest,
      besoins: nextBesoins,
      contacts_at: [...contactsAt, nowIso],
      updated_at: nowIso,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return toClientView(data);
}
