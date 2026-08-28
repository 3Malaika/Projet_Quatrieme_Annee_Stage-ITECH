/**
 * Store catalogue — version Supabase.
 * Même interface que catalogue.store.js (loadCatalogue / saveCatalogue).
 * Stratégie last-write-wins : updated_at est mis à jour à chaque écriture.
 */
import { supabase } from "./supabase.client.js";

export async function loadCatalogue() {
  const { data, error } = await supabase
    .from("produits")
    .select("*")
    .order("updated_at", { ascending: true });

  if (error) {
    console.error("Supabase loadCatalogue:", error.message);
    return [];
  }
  return data;
}

export async function saveProduit(produit) {
  const { id, ...fields } = produit;

  const { data, error } = await supabase
    .from("produits")
    .update({
      ...fields,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(error.message);

  return data;
}

export async function deleteProduit(id) {
  const { error } = await supabase.from("produits").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
