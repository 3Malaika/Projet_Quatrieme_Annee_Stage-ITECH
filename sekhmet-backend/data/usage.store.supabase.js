/**
 * Store usage (consommation de tokens Groq) — version Supabase.
 * Même interface que usage.store.js.
 */
import { supabase } from "./supabase.client.js";

export async function appendUsage(entry) {
  const { error } = await supabase.from("token_usage").insert(entry);
  if (error) console.error("Supabase appendUsage:", error.message);
}

// limit(5000) : cohérent avec le plafond du store JSON, pour que
// getUsageSummary() se comporte pareil quel que soit le mode de stockage.
export async function loadUsage() {
  const { data, error } = await supabase
    .from("token_usage")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) {
    console.error("Supabase loadUsage:", error.message);
    return [];
  }
  return data;
}
