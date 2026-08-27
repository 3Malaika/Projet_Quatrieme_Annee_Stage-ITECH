import { config } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("usage");

// Bascule automatique JSON / Supabase — même pattern que le reste du code.
const usageStore = config.supabaseUrl
  ? await import("../data/usage.store.supabase.js")
  : await import("../data/usage.store.js");

/**
 * Enregistre la consommation de tokens d'un appel Groq : à la fois dans les
 * logs (visible immédiatement dans les logs Render/console) et dans le store
 * (pour les totaux affichés dans le dashboard admin).
 *
 * Volontairement non bloquant : un souci d'écriture sur ce fichier/cette
 * table ne doit jamais faire échouer une réponse au client — ce compteur est
 * un outil d'observation, pas une dépendance critique du flux WhatsApp.
 *
 * @param {string} type - "reponse" | "extraction_client" | "extraction_paiement" | "resume_escalade"
 * @param {string} model - nom du modèle Groq utilisé
 * @param {object} usage - le champ `usage` renvoyé par la réponse Groq (peut être absent)
 * @param {string} [phoneNumber] - numéro du client concerné, si pertinent
 */
export function recordUsage({ type, model, usage, phoneNumber }) {
  if (!usage) {
    log.warn("Appel Groq sans champ usage — impossible de comptabiliser", { type, model });
    return;
  }

  const entry = {
    type,
    model,
    prompt_tokens: usage.prompt_tokens ?? null,
    completion_tokens: usage.completion_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
    phone: phoneNumber || null,
    created_at: new Date().toISOString(),
  };

  // Visible dans les logs, immédiatement, sans attendre l'écriture du store.
  log.info("Consommation Groq", entry);

  Promise.resolve(usageStore.appendUsage(entry)).catch((e) =>
    log.error("Erreur enregistrement usage tokens", e)
  );
}

/**
 * Agrège la consommation pour le dashboard admin : totaux du jour, du mois,
 * et depuis toujours (dans la limite des MAX_ENTRIES entrées conservées).
 */
export async function getUsageSummary() {
  const all = await usageStore.loadUsage();

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const sumTokens = (rows) => rows.reduce((acc, r) => acc + (r.total_tokens || 0), 0);

  const today = all.filter((r) => r.created_at >= startOfDay);
  const thisMonth = all.filter((r) => r.created_at >= startOfMonth);

  return {
    appelsAujourdHui: today.length,
    tokensAujourdHui: sumTokens(today),
    appelsCeMois: thisMonth.length,
    tokensCeMois: sumTokens(thisMonth),
    tokensTotal: sumTokens(all),
  };
}
