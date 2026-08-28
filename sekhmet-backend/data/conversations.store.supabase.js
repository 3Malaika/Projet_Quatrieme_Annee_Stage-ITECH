/**
 * Store conversations — version Supabase.
 * Même interface que conversations.store.js.
 */
import { supabase } from "./supabase.client.js";

export async function loadConversations() {
  const { data, error } = await supabase.from("conversations").select("*");
  if (error) {
    console.error("Supabase loadConversations:", error.message);
    return {};
  }
  // Reconstitue { [phone]: messages[] }
  return Object.fromEntries(data.map((c) => [c.phone, c.messages]));
}

export async function saveConversations(conversations) {
  // Upsert toutes les conversations modifiées
  const rows = Object.entries(conversations).map(([phone, messages]) => ({
    phone,
    messages,
    updated_at: new Date().toISOString(),
  }));

  if (rows.length === 0) return;

  const { error } = await supabase.from("conversations").upsert(rows);
  if (error) console.error("Supabase saveConversations:", error.message);
}

export async function saveConversation(phone, messages) {
  // Sauvegarde d'une seule conversation (plus efficace qu'un upsert global)
  const { error } = await supabase.from("conversations").upsert({
    phone,
    messages,
    updated_at: new Date().toISOString(),
  });
  if (error) console.error("Supabase saveConversation:", error.message);
}

/**
 * Efface l'historique d'un client précis (utilisé par le bouton "Effacer
 * l'historique" de l'admin).
 */
export async function deleteConversation(phone) {
  const { error } = await supabase.from("conversations").delete().eq("phone", phone);
  if (error) throw new Error(error.message);
}
