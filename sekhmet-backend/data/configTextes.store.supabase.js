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

// Numéro (Mobile Money / Orange Money / MTN MoMo, etc.) et nom du titulaire
// du compte dans lequel les clients doivent envoyer leur paiement. Stocké en
// JSON sous une seule clé "paiement_compte" du même tableau config_textes,
// pour éviter d'ajouter une table dédiée. Modifiable depuis l'interface
// admin, et transmis par le bot au client dès qu'il veut payer.
const DEFAULT_COMPTE = { numero: "", nom: "" };

export async function loadPaiementCompte() {
  const raw = await loadTexte("paiement_compte", "");
  if (!raw) return DEFAULT_COMPTE;
  try {
    const parsed = JSON.parse(raw);
    return { numero: parsed.numero || "", nom: parsed.nom || "" };
  } catch {
    return DEFAULT_COMPTE;
  }
}

export async function savePaiementCompte({ numero, nom }) {
  const compte = { numero: numero || "", nom: nom || "" };
  await saveTexte("paiement_compte", JSON.stringify(compte));
  return compte;
}
