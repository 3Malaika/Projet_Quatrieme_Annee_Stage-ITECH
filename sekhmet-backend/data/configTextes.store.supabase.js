/**
 * Store textes de configuration (bienfaits, procédures, message d'ouverture) — version Supabase.
 * Remplace bienfaits.store.js, procedures.store.js et openingMessage.store.js.
 */
import { supabase } from "./supabase.client.js";

async function loadTexte(cle, fallback = "") {
  const { data, error } = await supabase
    .from("config_textes")
    .select("contenu")
    .eq("cle", cle)
    .single();

  if (error) return fallback;
  return data.contenu || fallback;
}

async function saveTexte(cle, contenu) {
  const { error } = await supabase
    .from("config_textes")
    .upsert({ cle, contenu, updated_at: new Date().toISOString() });

  if (error) throw new Error(error.message);
}

export const loadBienfaits = () => loadTexte("bienfaits", "");
export const saveBienfaits = (c) => saveTexte("bienfaits", c);

export const loadProcedures = () =>
  loadTexte("procedures", "Aucune procédure spécifique enregistrée.");
export const saveProcedures = (c) => saveTexte("procedures", c);

export const loadOpeningMessage = () =>
  loadTexte(
    "message_ouverture",
    "Bonjour 👋 et merci de nous avoir contactés ! Un conseiller va prendre en charge votre demande."
  );
export const saveOpeningMessage = (c) => saveTexte("message_ouverture", c);
