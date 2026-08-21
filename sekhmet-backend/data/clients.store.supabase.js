/**
 * Store clients — version Supabase.
 * Même interface que clients.store.js.
 */
import { supabase } from "./supabase.client.js";
import { generateClientId } from "../utils/clientId.js";

export async function loadClients() {
  const { data, error } = await supabase.from("clients").select("*");
  if (error) {
    console.error("Supabase loadClients:", error.message);
    return {};
  }
  return Object.fromEntries(data.map((c) => [c.phone, c]));
}

export async function getClient(phone) {
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("phone", phone)
    .single();
  if (error) return null;
  return data;
}

export async function upsertClient(phone, fields) {
  const existing = await getClient(phone);

  let client_id = existing?.client_id;
  if (!client_id && (fields.nom || existing?.nom)) {
    const nom = fields.nom || existing.nom;
    const { count } = await supabase
      .from("clients")
      .select("*", { count: "exact", head: true });
    const ordre = (count ?? 0) + (existing ? 0 : 1);
    client_id = generateClientId(nom, ordre);
  }

  // besoins est un tableau — on ajoute le nouveau besoin s'il n'existe pas déjà
  const besoinsExistants = Array.isArray(existing?.besoins) ? existing.besoins : [];
  const contactsAt = Array.isArray(existing?.contacts_at) ? existing.contacts_at : [];

  let besoins = besoinsExistants;
  let contacts_at = contactsAt;

  if (fields.besoin && !besoinsExistants.includes(fields.besoin)) {
    besoins = [...besoinsExistants, fields.besoin];
    contacts_at = [...contactsAt, new Date().toISOString()];
  }

  const { besoin, ...restFields } = fields; // on retire besoin (string) du payload

  const { data, error } = await supabase
    .from("clients")
    .upsert({
      phone,
      ...restFields,
      besoins,
      contacts_at,
      ...(client_id ? { client_id } : {}),
      // updated_at géré par le trigger PostgreSQL
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}
