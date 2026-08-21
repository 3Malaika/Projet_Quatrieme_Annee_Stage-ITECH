/**
 * Store catégories — version Supabase.
 * Même interface que categories.store.js.
 */
import { supabase } from "./supabase.client.js";

const DEFAULT_CATEGORIES = [
  "poudres","farines","sels","graines","grignotages","assaisonnements",
  "produits_sales","laitiers_boissons","patisseries","boissons_naturelles",
  "packs_amincissant","pains","suivi","livraisons","autres",
];

export async function loadCategories() {
  const { data, error } = await supabase
    .from("categories")
    .select("name")
    .order("name", { ascending: true });

  if (error) {
    console.error("Supabase loadCategories:", error.message);
    return DEFAULT_CATEGORIES;
  }
  return data.map((r) => r.name);
}

export async function saveCategories(categories) {
  // Remplace toutes les catégories : supprime les absentes, insère les nouvelles
  const { error: delError } = await supabase
    .from("categories")
    .delete()
    .not("name", "in", `(${categories.map((c) => `"${c}"`).join(",")})`);
  if (delError) throw new Error(delError.message);

  const { error: upsertError } = await supabase
    .from("categories")
    .upsert(categories.map((name) => ({ name })));
  if (upsertError) throw new Error(upsertError.message);
}

export async function addCategory(name) {
  const { error } = await supabase.from("categories").insert({ name });
  if (error) throw new Error(error.message);
}

export async function renameCategory(oldName, newName) {
  const { error } = await supabase
    .from("categories")
    .update({ name: newName })
    .eq("name", oldName);
  if (error) throw new Error(error.message);
}

export async function deleteCategory(name) {
  const { error } = await supabase.from("categories").delete().eq("name", name);
  if (error) throw new Error(error.message);
}
