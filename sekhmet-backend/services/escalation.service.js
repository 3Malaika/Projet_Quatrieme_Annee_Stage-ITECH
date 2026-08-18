import { config } from "../config/env.js";
import { sendWhatsappMessage } from "./whatsapp.service.js";
import { summarizeForHuman } from "./chat.service.js";

// File d'attente d'escalade (tâche de fond). Plusieurs clients peuvent
// déclencher une escalade en même temps : on les transmet au collaborateur
// UN PAR UN, dans l'ordre d'arrivée, sans bloquer le reste de leur conversation.
const escalationQueue = [];
const pendingEscalations = {}; // { "237...": timestamp } -> demande en cours pour CE client
let isProcessingEscalation = false;

// Historique persistant de toutes les escalades, consultable via l'API.
const escalationsLog = []; // { id, from, userMessage, status, createdAt, closedAt }
let escalationIdCounter = 1;

export function isPending(from) {
  const ts = pendingEscalations[from];
  if (!ts) return false;
  if (Date.now() - ts > config.escalationTimeoutMs) {
    delete pendingEscalations[from]; // expiré : nettoyage automatique
    return false;
  }
  return true;
}

function logEscalation(from, userMessage) {
  const entry = {
    id: String(escalationIdCounter++),
    from,
    userMessage,
    status: "en_attente", // ou "cloturee"
    createdAt: new Date().toISOString(),
    closedAt: null,
  };
  escalationsLog.push(entry);
  return entry;
}

export function closeEscalationLog(from) {
  const entry = [...escalationsLog]
    .reverse()
    .find((e) => e.from === from && e.status === "en_attente");
  if (entry) {
    entry.status = "cloturee";
    entry.closedAt = new Date().toISOString();
  }
  return entry;
}

export function getEscalationsLog() {
  return escalationsLog.slice().reverse(); // les plus récentes en premier
}

export function findEscalation(id) {
  return escalationsLog.find((e) => e.id === id);
}

export function closeEscalationById(id) {
  const entry = findEscalation(id);
  if (!entry) return null;
  entry.status = "cloturee";
  entry.closedAt = new Date().toISOString();
  delete pendingEscalations[entry.from];
  return entry;
}

export async function enqueueEscalation(from, userMessage) {
  pendingEscalations[from] = Date.now();
  escalationQueue.push({ from, userMessage });
  logEscalation(from, userMessage);

  await sendWhatsappMessage(
    from,
    "Je transmets votre demande à un collaborateur, il revient vers vous très rapidement."
  );

  processEscalationQueue(); // tâche de fond : ne bloque pas la réponse au client
}

async function processEscalationQueue() {
  if (isProcessingEscalation) return; // un traitement est déjà en cours
  if (escalationQueue.length === 0) return;

  isProcessingEscalation = true;
  const { from, userMessage } = escalationQueue.shift(); // premier arrivé, premier traité

  try {
    const summary = await summarizeForHuman(from);
    await sendWhatsappMessage(
      config.humanAgentNumber,
      `⚠️ Nouvelle escalade — client ${from}\n\nRésumé : ${summary}\n\nDernier message : "${userMessage}"`
    );
  } catch (err) {
    console.error("Erreur lors de l'escalade:", err.message);
  }

  isProcessingEscalation = false;
  processEscalationQueue(); // on enchaîne sur la suivante s'il y en a
}

export function clearPending(from) {
  delete pendingEscalations[from];
}
