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

// Liste de comptes (Mobile Money / Orange Money / MTN MoMo, etc.) — chacun
// avec un numéro et un nom de titulaire — dans lesquels les clients peuvent
// envoyer leur paiement. Stockée en JSON sous une seule clé "paiement_compte"
// du même tableau config_textes, pour éviter d'ajouter une table dédiée.
// Modifiable depuis l'interface admin, et transmise par le bot au client dès
// qu'il veut payer.
const DEFAULT_COMPTES = [];

// Compatibilité ascendante : les anciennes installations ont stocké un objet
// unique { numero, nom } plutôt qu'un tableau. On le normalise à la lecture.
function normalizeComptes(parsed) {
  if (Array.isArray(parsed)) {
    return parsed
      .map((c) => ({ numero: c?.numero || "", nom: c?.nom || "" }))
      .filter((c) => c.numero);
  }
  if (parsed && typeof parsed === "object" && parsed.numero) {
    return [{ numero: parsed.numero, nom: parsed.nom || "" }];
  }
  return DEFAULT_COMPTES;
}

export async function loadPaiementComptes() {
  const raw = await loadTexte("paiement_compte", "");
  if (!raw) return DEFAULT_COMPTES;
  try {
    return normalizeComptes(JSON.parse(raw));
  } catch {
    return DEFAULT_COMPTES;
  }
}

export async function savePaiementComptes(comptes) {
  const normalized = (comptes || [])
    .map((c) => ({ numero: (c.numero || "").trim(), nom: (c.nom || "").trim() }))
    .filter((c) => c.numero);
  await saveTexte("paiement_compte", JSON.stringify(normalized));
  return normalized;
}

// --- Compatibilité ascendante ---------------------------------------------
// Anciennes fonctions singulier, conservées pour tout code qui ne serait pas
// encore migré : renvoient/acceptent le premier compte de la liste.
export async function loadPaiementCompte() {
  const comptes = await loadPaiementComptes();
  return comptes[0] || { numero: "", nom: "" };
}

export async function savePaiementCompte({ numero, nom }) {
  const comptes = await savePaiementComptes([{ numero, nom }]);
  return comptes[0] || { numero: "", nom: "" };
}
