/**
 * Store des logs importants (Groq / Meta / Système) — version Supabase.
 * Même interface que systemLogs.store.js.
 */
import { supabase } from "./supabase.client.js";

export async function appendLog(entry) {
  const { error } = await supabase.from("system_logs").insert(entry);
  if (error) console.error("Supabase appendLog:", error.message);
}

export async function loadLogs(limit = 50) {
  const { data, error } = await supabase
    .from("system_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("Supabase loadLogs:", error.message);
    return [];
  }
  return data;
}
