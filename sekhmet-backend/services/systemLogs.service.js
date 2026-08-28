import { config } from "../config/env.js";
import { onImportantLog } from "../utils/logger.js";

// Bascule automatique JSON / Supabase — même pattern que le reste du code.
const store = config.supabaseUrl
  ? await import("../data/systemLogs.store.supabase.js")
  : await import("../data/systemLogs.store.js");

// Filet de secours en mémoire : utile juste après un déploiement (avant la
// première écriture réussie côté store) ou si le store est momentanément
// indisponible. Volontairement petit — ce n'est qu'un complément, la source
// de vérité reste le store persistant.
const MAX_MEMORY = 30;
const memoryBuffer = [];

const SOURCE_LABELS = {
  groq: "Assistant IA",
  meta: "WhatsApp",
  systeme: "Système",
};

// Classification volontairement simple (mots-clés) : elle couvre tous les
// log.error() existants (voir whatsapp.service.js, chat.service.js,
// webhook.routes.js) sans avoir à modifier chaque site d'appel un par un.
function classifySource(context, message) {
  const text = `${context} ${message}`.toLowerCase();
  if (text.includes("groq")) return "groq";
  if (text.includes("whatsapp") || text.includes("meta")) return "meta";
  return "systeme";
}

// Le dashboard n'est pas un journal technique. On ne remonte que les
// incidents susceptibles d'empêcher une fonction métier importante :
// indisponibilité de Groq ou problème de communication avec Meta/WhatsApp.
// Les erreurs CRUD, Supabase, PDF, statistiques, etc. restent dans les logs
// techniques du serveur et ne polluent pas l'écran d'accueil.
function isCriticalIntegrationLog(context, message) {
  const text = `${context} ${message}`.toLowerCase();
  const groq = text.includes("groq") && (
    text.includes("échec") ||
    text.includes("erreur") ||
    text.includes("échoué") ||
    text.includes("réseau") ||
    text.includes("network") ||
    text.includes("timeout") ||
    text.includes("quota") ||
    text.includes("rate limit") ||
    text.includes("429") ||
    text.includes("401") ||
    text.includes("403") ||
    text.includes("indisponible")
  );
  const meta = (text.includes("whatsapp") || text.includes("meta")) && (
    text.includes("échec") ||
    text.includes("erreur") ||
    text.includes("échoué") ||
    text.includes("réseau") ||
    text.includes("network") ||
    text.includes("timeout") ||
    text.includes("401") ||
    text.includes("403") ||
    text.includes("404") ||
    text.includes("429") ||
    text.includes("indisponible")
  );
  return groq || meta;
}

function humanizeLog(source, message) {
  const text = String(message || "").toLowerCase();
  if (source === "groq") {
    if (text.includes("réseau") || text.includes("network") || text.includes("timeout") || text.includes("timed out")) {
      return "L’assistant IA ne répond pas pour le moment.";
    }
    if (text.includes("quota") || text.includes("rate limit") || text.includes("429")) {
      return "Le service IA a atteint sa limite momentanée.";
    }
    return "Le service IA rencontre actuellement un problème.";
  }
  if (source === "meta") {
    if (text.includes("réseau") || text.includes("network") || text.includes("timeout") || text.includes("timed out")) {
      return "WhatsApp ne répond pas pour le moment.";
    }
    if (text.includes("401") || text.includes("403") || text.includes("token")) {
      return "La connexion à WhatsApp doit être vérifiée.";
    }
    return "L’envoi ou la réception des messages WhatsApp rencontre un problème.";
  }
  return "Un problème important a été détecté.";
}

function shortDetail(extra) {
  if (!extra) return null;
  if (extra instanceof Error) return extra.message;
  try {
    const s = JSON.stringify(extra);
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch {
    return String(extra);
  }
}

function handleImportantLog({ level, context, message, extra }) {
  const source = classifySource(context, message);
  if (level !== "error" || !isCriticalIntegrationLog(context, message)) return;

  const entry = {
    level,
    source,
    context,
    message: humanizeLog(source, message),
    detail: null,
    created_at: new Date().toISOString(),
  };

  memoryBuffer.push(entry);
  if (memoryBuffer.length > MAX_MEMORY) memoryBuffer.shift();

  // Non bloquant, à l'image de usage.service.js : un souci d'écriture ici ne
  // doit jamais perturber le flux principal (webhook WhatsApp, appel Groq...).
  Promise.resolve(store.appendLog(entry)).catch((e) =>
    console.error("[systemLogs] échec d'enregistrement du log", e?.message || e)
  );
}

onImportantLog(handleImportantLog);

/**
 * Retourne les logs importants les plus récents, en version simplifiée pour
 * le dashboard admin (pas de stack trace complète — juste de quoi repérer
 * un souci Groq ou Meta/WhatsApp en un coup d'œil).
 */
export async function getRecentImportantLogs(limit = 8) {
  let rows = [];
  try {
    rows = (await store.loadLogs(limit)) || [];
  } catch {
    rows = [];
  }

  // Si le store ne renvoie rien (juste après un déploiement, par ex.), on
  // retombe sur le buffer mémoire du process en cours.
  const pool = rows.length > 0 ? rows : memoryBuffer;

  const criticalPool = pool.filter((r) => r.source === "groq" || r.source === "meta");
  const sorted = [...criticalPool].sort((a, b) =>
    (b.created_at || "").localeCompare(a.created_at || "")
  );

  return sorted.slice(0, limit).map((r) => ({
    id: r.id ?? `${r.created_at}-${r.context}`,
    source: SOURCE_LABELS[r.source] || "Système",
    level: r.level,
    message: humanizeLog(r.source, r.message),
    detail: null,
    createdAt: r.created_at,
  }));
}
