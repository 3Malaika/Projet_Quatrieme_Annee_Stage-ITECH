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
  groq: "Groq",
  meta: "Meta / WhatsApp",
  systeme: "Système",
};

// Classification volontairement simple (mots-clés) : elle couvre tous les
// log.error() existants (voir whatsapp.service.js, chat.service.js,
// webhook.routes.js) sans avoir à modifier chaque site d'appel un par un.
function classifySource(context, message) {
  const text = `${context} ${message}`.toLowerCase();
  if (text.includes("groq")) return "groq";
  if (text.includes("whatsapp") || text.includes("meta")) return "meta";
  // Le webhook gère la réception ET l'envoi des messages WhatsApp : à défaut
  // d'un mot-clé explicite, on le rattache par défaut à Meta/WhatsApp.
  if (context === "webhook") return "meta";
  return "systeme";
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
  const entry = {
    level,
    source: classifySource(context, message),
    context,
    message,
    detail: shortDetail(extra),
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

  const sorted = [...pool].sort((a, b) =>
    (b.created_at || "").localeCompare(a.created_at || "")
  );

  return sorted.slice(0, limit).map((r) => ({
    id: r.id ?? `${r.created_at}-${r.context}`,
    source: SOURCE_LABELS[r.source] || "Système",
    level: r.level,
    context: r.context,
    message: r.message,
    detail: r.detail || null,
    createdAt: r.created_at,
  }));
}
