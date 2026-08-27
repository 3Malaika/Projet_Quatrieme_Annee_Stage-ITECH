import { supabase } from "./supabase.client.js";

export async function loadCommandes() {
  const { data, error } = await supabase
    .from("commandes")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Supabase loadCommandes:", error.message);
    return [];
  }
  return data;
}

export async function getCommande(id) {
  const { data, error } = await supabase.from("commandes").select("*").eq("id", id).single();
  if (error) return null;
  return data;
}

export async function createCommande(commande) {
  const { data, error } = await supabase.from("commandes").insert(commande).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateCommande(id, fields) {
  const { data, error } = await supabase
    .from("commandes")
    .update(fields)
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}
