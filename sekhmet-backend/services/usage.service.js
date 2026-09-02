import { config } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("usage");

// Tarifs Groq en $ par million de tokens (input/output), pour les deux
// modèles utilisés par l'agent. À mettre à jour si le modèle change ou si
// Groq ajuste ses prix — voir https://groq.com/pricing/
const PRICING = {
  "openai/gpt-oss-20b": { input: 0.075, output: 0.30 },
  "openai/gpt-oss-120b": { input: 0.15, output: 0.60 },
};
// Tarif par défaut si jamais un modèle inconnu apparaît, pour ne pas casser
// le calcul (estimation prudente, plutôt haute).
const DEFAULT_PRICING = { input: 0.20, output: 0.80 };

function estimateCost(row) {
  const pricing = PRICING[row.model] || DEFAULT_PRICING;
  const inputCost = ((row.prompt_tokens || 0) / 1_000_000) * pricing.input;
  const outputCost = ((row.completion_tokens || 0) / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

// Bascule automatique JSON / Supabase — même pattern que le reste du code.
const usageStore = config.supabaseUrl
  ? await import("../data/usage.store.supabase.js")
  : await import("../data/usage.store.js");

/**
 * Enregistre la consommation de tokens d'un appel Groq : à la fois dans les
 * logs (visible immédiatement dans les logs Render/console) et dans le store
 * (pour les totaux affichés dans le dashboard admin).
 *
 * L'écriture est attendue avant de retourner au traitement appelant. Un souci
 * d'écriture ne fait toutefois pas échouer la réponse WhatsApp : la fonction
 * retourne false et laisse le flux continuer. Cela évite de perdre une
 * consommation lors d'un redémarrage juste après la réponse Groq.
 *
 * @param {string} type - "reponse" | "extraction_client" | "extraction_paiement" | "resume_escalade"
 * @param {string} model - nom du modèle Groq utilisé
 * @param {object} usage - le champ `usage` renvoyé par la réponse Groq (peut être absent)
 * @param {string} [phoneNumber] - numéro du client concerné, si pertinent
 */
export async function recordUsage({ type, model, usage, phoneNumber }) {
  if (!usage) {
    log.warn("Appel Groq sans données de consommation", { type, model });
    return;
  }

  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? (promptTokens + completionTokens));

  const entry = {
    type,
    model,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    phone: phoneNumber || null,
    created_at: new Date().toISOString(),
  };

  // La consommation fournie par Groq est la source de vérité pour cet appel.
  // On l'enregistre AVANT de considérer l'appel comme terminé afin qu'un
  // redémarrage Render juste après la réponse ne fasse pas perdre le compteur.
  log.info("Consommation Groq", entry);

  try {
    const saved = await usageStore.appendUsage(entry);
    if (!saved) {
      log.error("Consommation Groq non persistée", { type, model, phoneNumber });
    }
    return saved;
  } catch (e) {
    // Le suivi ne doit jamais empêcher la réponse WhatsApp, mais l'erreur est
    // maintenant attendue et visible au lieu d'être lancée en arrière-plan.
    log.error("Erreur enregistrement usage tokens", e);
    return false;
  }
}

/**
 * Agrège la consommation pour le dashboard admin : totaux du jour, du mois,
 * et depuis le début du suivi. Chaque ligne correspond à un appel Groq et les
 * valeurs viennent directement du champ response.usage fourni par Groq.
 */
export async function getUsageSummary() {
  const usageResult = await usageStore.loadUsage();
  const all = Array.isArray(usageResult) ? usageResult : (usageResult.rows || []);
  const available = Array.isArray(usageResult) ? true : usageResult.available !== false;

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const sumTokens = (rows) => rows.reduce((acc, r) => acc + (r.total_tokens || 0), 0);
  const sumCost = (rows) => rows.reduce((acc, r) => acc + estimateCost(r), 0);
  // Arrondi à 4 décimales : les montants Groq sont petits (souvent < 1$/jour
  // sur ce genre de volume), 2 décimales masqueraient toute variation.
  const roundCost = (n) => Math.round(n * 10000) / 10000;

  const today = all.filter((r) => r.created_at >= startOfDay);
  const thisMonth = all.filter((r) => r.created_at >= startOfMonth);

  // Répartition du coût du mois par modèle, utile pour voir si le modèle
  // 120b (réponses) ou 20b (extractions/résumés) pèse le plus dans la facture.
  const parModele = {};
  for (const r of thisMonth) {
    const key = r.model || "inconnu";
    parModele[key] = (parModele[key] || 0) + estimateCost(r);
  }
  const coutParModeleCeMois = Object.fromEntries(
    Object.entries(parModele).map(([model, cost]) => [model, roundCost(cost)])
  );

  return {
    appelsAujourdHui: today.length,
    tokensAujourdHui: sumTokens(today),
    appelsCeMois: thisMonth.length,
    tokensCeMois: sumTokens(thisMonth),
    tokensTotal: sumTokens(all),
    coutEstimeAujourdHui: roundCost(sumCost(today)),
    coutEstimeCeMois: roundCost(sumCost(thisMonth)),
    coutEstimeTotal: roundCost(sumCost(all)),
    coutParModeleCeMois,
    suiviDisponible: available,
  };
}
