/**
 * Suivi de consommation Groq dans Supabase.
 * Si la table n'existe pas encore, le dashboard le signale clairement au lieu
 * d'afficher de faux zéros.
 */
import { supabase } from "./supabase.client.js";

let tableAvailable = null;
let warnedMissingTable = false;

function isMissingTable(error) {
  const text = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return error?.code === "PGRST205" || text.includes("token_usage") || text.includes("schema cache");
}

export async function appendUsage(entry) {
  if (tableAvailable === false) return false;
  const { error } = await supabase.from("token_usage").insert(entry);
  if (error) {
    if (isMissingTable(error)) {
      tableAvailable = false;
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        console.error("Suivi Groq indisponible : la table public.token_usage n'existe pas encore dans Supabase.");
      }
    } else {
      console.error("Supabase appendUsage:", error.message);
    }
    return false;
  }
  tableAvailable = true;
  return true;
}

export async function loadUsage() {
  const { data, error } = await supabase
    .from("token_usage")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) {
    if (isMissingTable(error)) {
      tableAvailable = false;
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        console.error("Suivi Groq indisponible : la table public.token_usage n'existe pas encore dans Supabase.");
      }
      return { rows: [], available: false };
    }
    console.error("Supabase loadUsage:", error.message);
    return { rows: [], available: false, error: error.message };
  }

  tableAvailable = true;
  return { rows: data || [], available: true };
}
