/**
 * Store conversations — version Supabase.
 * Même interface que conversations.store.js.
 */
import { supabase } from "./supabase.client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("conversations-store");

// ---------------------------------------------------------------------------
// Retry sur erreurs transitoires (correctif)
// ---------------------------------------------------------------------------
// "Gateway Timeout" (et autres erreurs réseau/504-like) sont typiquement des
// incidents ponctuels côté infrastructure Supabase, pas des erreurs de
// données. Sans retry, un seul timeout fait perdre silencieusement la
// sauvegarde d'un message (l'appelant ne fait qu'un .catch() de log, sans
// jamais réessayer — voir persistHistory() dans chat.service.js).
const TRANSIENT_ERROR_PATTERNS = [
  /timeout/i,
  /gateway/i,
  /fetch failed/i,
  /econnreset/i,
  /network/i,
  /too many connections/i,
  /service unavailable/i,
];

function isTransientError(message) {
  const text = String(message || "");
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(text));
}

async function withRetry(fn, { label, context = {}, retries = 2, baseDelayMs = 500 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { error } = await fn();
    if (!error) return { error: null };
    lastError = error;
    if (attempt < retries && isTransientError(error.message)) {
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      log.warn(`Erreur transitoire Supabase (${label}), nouvelle tentative`, {
        ...context,
        attempt: attempt + 1,
        delayMs,
        error: error.message,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    break;
  }
  return { error: lastError };
}

export async function loadConversations() {
  const { data, error } = await supabase.from("conversations").select("*");
  if (error) {
    log.error("Échec loadConversations", { error: error.message });
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

  const { error } = await withRetry(
    () => supabase.from("conversations").upsert(rows),
    { label: "saveConversations", context: { nombreConversations: rows.length } }
  );

  if (error) {
    log.error("Échec saveConversations (après tentatives)", {
      error: error.message,
      nombreConversations: rows.length,
    });
  }
}

export async function saveConversation(phone, messages) {
  // Sauvegarde d'une seule conversation (plus efficace qu'un upsert global)
  const payloadSize = safePayloadSize(messages);

  const { error } = await withRetry(
    () =>
      supabase.from("conversations").upsert({
        phone,
        messages,
        updated_at: new Date().toISOString(),
      }),
    { label: "saveConversation", context: { phone, nombreMessages: messages?.length, payloadSize } }
  );

  if (error) {
    // On journalise la taille du payload et le nombre de messages : si ce
    // chiffre grossit continuellement pour un même client au fil du temps,
    // c'est le signe que l'historique jamais tronqué est la cause des
    // timeouts (plutôt qu'un simple incident réseau ponctuel), et qu'un
    // mécanisme de troncature/archivage de l'historique serait à envisager.
    log.error("Échec saveConversation (après tentatives)", {
      phone,
      error: error.message,
      nombreMessages: messages?.length,
      payloadSize,
    });
  }
}

function safePayloadSize(messages) {
  try {
    return JSON.stringify(messages || []).length;
  } catch {
    return null;
  }
}

/**
 * Efface l'historique d'un client précis (utilisé par le bouton "Effacer
 * l'historique" de l'admin).
 */
export async function deleteConversation(phone) {
  const { error } = await supabase.from("conversations").delete().eq("phone", phone);
  if (error) {
    log.error("Échec deleteConversation", { phone, error: error.message });
    throw new Error(error.message);
  }
}