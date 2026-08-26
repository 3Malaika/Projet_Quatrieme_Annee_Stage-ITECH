/**
 * Store clients — version Supabase.
 * Même interface publique que clients.store.js : { phone, nom, besoin, updatedAt }.
 *
 * En base, l'historique est conservé (un client peut avoir plusieurs besoins
 * dans le temps) :
 *   - besoins      JSONB  : liste des besoins exprimés, dans l'ordre
 *   - contacts_at  JSONB  : liste des dates de contact (une entrée par
 *                           upsertClient, donc à chaque fois qu'on apprend
 *                           quelque chose de nouveau sur ce client)
 *
 * Le reste du code (webhook, routes admin, chat.service) ne connaît que
 * `besoin` (le plus récent) : on le dérive de `besoins` à la lecture.
 */
import { supabase } from "./supabase.client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("clients.store.supabase");

function toClientView(row) {
  if (!row) return null;
  const besoins = Array.isArray(row.besoins) ? row.besoins : [];
  return {
    ...row,
    besoin: besoins.length ? besoins[besoins.length - 1] : null,
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
// On traduit `besoin` (une valeur) vers un ajout dans l'historique `besoins`
// (sauf s'il est identique au dernier déjà enregistré, pour ne pas empiler
// des doublons à chaque message). `updatedAt` est ignoré : c'est le store
// qui gère `updated_at` lui-même.
export async function upsertClient(phone, fields) {
  const { besoin, updatedAt, ...rest } = fields;

  const { data: existing } = await supabase
    .from("clients")
    .select("besoins, contacts_at")
    .eq("phone", phone)
    .single();

  const besoins = Array.isArray(existing?.besoins) ? existing.besoins : [];
  const contactsAt = Array.isArray(existing?.contacts_at) ? existing.contacts_at : [];
  const nowIso = new Date().toISOString();

  const nextBesoins =
    besoin && besoin !== besoins[besoins.length - 1] ? [...besoins, besoin] : besoins;

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
