/**
 * Store clients — version Supabase.
 * Même interface que clients.store.js.
 */
import { supabase } from "./supabase.client.js";

export async function loadClients() {
  const { data, error } = await supabase.from("clients").select("*");
  if (error) {
    console.error("Supabase loadClients:", error.message);
    return {};
  }
  // Reconstitue le format { [phone]: client } attendu par le reste du code
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
  const { data, error } = await supabase
    .from("clients")
    .upsert({ phone, ...fields, updated_at: new Date().toISOString() })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}
