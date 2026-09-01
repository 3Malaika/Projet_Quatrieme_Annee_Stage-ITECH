import { config } from "../config/env.js";
import { sendWhatsappMessage } from "./whatsapp.service.js";
import { summarizeForHuman } from "./chat.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("escalation");
const escalationQueue = [];
const pendingEscalations = {};
const timers = new Map();
let isProcessingEscalation = false;
let escalationIdCounter = 1;

const cfgStore = config.supabaseUrl
  ? await import("../data/botConfig.store.supabase.js")
  : await import("../data/botConfig.store.js");
const escalationStore = config.supabaseUrl
  ? await import("../data/escalation.store.supabase.js")
  : await import("../data/escalation.store.js");

function normalizePhone(value) {
  let phone = String(value || "").trim().replace(/[^0-9+]/g, "");
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.startsWith("+")) phone = phone.slice(1);
  return phone;
}
function fallbackTarget() {
  return config.humanAgentNumber
    ? [{ phone: normalizePhone(config.humanAgentNumber), label: "Numéro principal", priority: 1, enabled: true, start: "00:00", end: "23:59" }]
    : [];
}
function inWindow(minutes, start, end) {
  const toMin = s => { const [h,m] = String(s || "00:00").split(":").map(Number); return h * 60 + m; };
  const a = toMin(start), b = toMin(end);
  return a <= b ? minutes >= a && minutes <= b : minutes >= a || minutes <= b;
}
async function targetsNow() {
  try {
    const cfg = await cfgStore.loadBotConfig();
    const minutes = new Date().getHours() * 60 + new Date().getMinutes();
    const arr = (cfg.escalations?.numbers || [])
      .filter(n => n.enabled !== false && n.phone && inWindow(minutes, n.start, n.end))
      .sort((a,b) => (a.priority || 99) - (b.priority || 99));
    return arr.length ? arr : fallbackTarget();
  } catch (err) {
    log.warn("Impossible de charger la configuration d'escalade", err);
    return fallbackTarget();
  }
}

export async function getConfiguredHumanNumbers() {
  const fallback = fallbackTarget().map(x => x.phone);
  try {
    const cfg = await cfgStore.loadBotConfig();
    return [...new Set([...fallback, ...(cfg.escalations?.numbers || []).map(n => normalizePhone(n.phone)).filter(Boolean)])];
  } catch { return fallback; }
}
export async function isHumanAgentNumber(phone) { return (await getConfiguredHumanNumbers()).includes(normalizePhone(phone)); }

export async function isPending(from) {
  let item = pendingEscalations[from];
  if (!item) {
    const entries = await escalationStore.listEscalations();
    const entry = entries.find(e => e.from === from && e.status === "en_attente");
    if (entry) {
      item = {
        from: entry.from,
        userMessage: entry.userMessage,
        targets: entry.targets || [],
        currentTargetIndex: entry.currentTargetIndex || 0,
        timeoutMinutes: entry.timeoutMinutes || 5,
        maxAttempts: entry.maxAttempts || (entry.targets || []).length,
        logId: entry.id,
        expiresAt: entry.expiresAt || (Date.now() + 24 * 60 * 60 * 1000),
      };
      pendingEscalations[from] = item;
      scheduleNext(from);
    }
  }
  if (!item) return false;
  if (item.expiresAt && Date.now() > item.expiresAt) { clearPending(from); return false; }
  return true;
}

async function persist(entry) {
  try { await escalationStore.saveEscalation(entry); }
  catch (err) { log.error("Impossible de persister l'escalade", { error: err?.message || String(err), id: entry?.id }); }
}

async function findEntry(id) { return escalationStore.getEscalation(id); }

async function createEntry(from, userMessage, targets, cfg) {
  const entry = {
    id: String(Date.now()) + "-" + String(escalationIdCounter++),
    from,
    userMessage,
    status: "en_attente",
    createdAt: new Date().toISOString(),
    closedAt: null,
    targets,
    currentTargetIndex: 0,
    deliveries: [],
    timeoutMinutes: Number(cfg.escalations?.timeoutMinutes) || 5,
    maxAttempts: Math.min(Number(cfg.escalations?.maxAttempts) || targets.length, targets.length),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  await persist(entry);
  return entry;
}

export async function closeEscalationLog(from) {
  const entries = await escalationStore.listEscalations();
  const entry = entries.find(e => e.from === from && e.status === "en_attente");
  if (entry) {
    entry.status = "cloturee";
    entry.closedAt = new Date().toISOString();
    await persist(entry);
    clearPending(from);
  }
  return entry || null;
}

export async function getEscalationsLog() { return escalationStore.listEscalations(); }
export async function findEscalation(id) { return findEntry(id); }

export async function closeEscalationById(id) {
  const e = await findEntry(id);
  if (!e) return null;
  e.status = "cloturee";
  e.closedAt = new Date().toISOString();
  await persist(e);
  clearPending(e.from);
  return e;
}
function clearTimer(from) { const t = timers.get(from); if (t) clearTimeout(t); timers.delete(from); }

async function notifyTarget(item, target, index) {
  const phone = normalizePhone(target.phone);
  if (!phone || phone.length < 8) throw new Error(`Numéro d'escalade invalide: ${target.phone}`);
  const summary = await summarizeForHuman(item.from);
  const prefix = index === 0 ? "Nouvelle escalade" : "Relance escalade — le premier contact n'a pas répondu dans le délai configuré";
  const message = `${prefix}\n\nClient : ${item.from}\n\nRésumé : ${summary}\n\nDernier message : "${item.userMessage}"\n\nPour répondre depuis WhatsApp : /repondre ${item.from} <message>\nPour clôturer : /resolu ${item.from}`;
  try {
    const result = await sendWhatsappMessage(phone, message);
    const entry = await findEntry(item.logId);
    if (entry) {
      entry.deliveries = [...(entry.deliveries || []), { target: phone, label: target.label, index, status: "envoye", sentAt: new Date().toISOString(), messageId: result?.messages?.[0]?.id || null }];
      entry.lastDeliveryError = null;
      entry.currentTargetIndex = index;
      await persist(entry);
    }
    log.info("Escalade envoyée", { from:item.from, target:phone, index:index+1, messageId:result?.messages?.[0]?.id });
    return true;
  } catch (err) {
    const entry = await findEntry(item.logId);
    if (entry) {
      entry.deliveries = [...(entry.deliveries || []), { target: phone, label: target.label, index, status: "echec", sentAt: new Date().toISOString(), error: err?.message || String(err) }];
      entry.lastDeliveryError = err?.message || String(err);
      await persist(entry);
    }
    log.error("Impossible d'envoyer l'escalade au numéro configuré", { from:item.from, target:phone, index:index+1, error:err?.message || String(err) });
    throw err;
  }
}

function scheduleNext(from) {
  const item = pendingEscalations[from]; if (!item) return;
  clearTimer(from);
  const timeout = Math.max(1, Number(item.timeoutMinutes) || 5) * 60 * 1000;
  timers.set(from, setTimeout(async () => {
    try {
      const current = pendingEscalations[from]; if (!current) return;
      const dynamicTargets = await targetsNow();
      const tried = new Set(current.targets.slice(0, current.currentTargetIndex + 1).map(t => normalizePhone(t.phone)));
      const nextTarget = dynamicTargets.find(t => !tried.has(normalizePhone(t.phone))) || current.targets[current.currentTargetIndex + 1];
      const nextIndex = current.currentTargetIndex + 1;
      if (!nextTarget || nextIndex >= current.maxAttempts) return;
      current.targets = [...current.targets, ...dynamicTargets.filter(t => !current.targets.some(x => normalizePhone(x.phone) === normalizePhone(t.phone)))];
      current.currentTargetIndex = current.targets.findIndex(t => normalizePhone(t.phone) === normalizePhone(nextTarget.phone));
      const entry = await findEntry(current.logId);
      if (entry) { entry.currentTargetIndex = current.currentTargetIndex; entry.targets = current.targets; await persist(entry); }
      await notifyTarget(current, nextTarget, current.currentTargetIndex);
      scheduleNext(from);
    } catch (err) { log.error("Erreur lors de la relance d'escalade", err); scheduleNext(from); }
  }, timeout));
}

export async function enqueueEscalation(from, userMessage) {
  const targets = await targetsNow();
  if (!targets.length) { log.error("Aucun numéro d'escalade configuré"); return; }
  let cfg; try { cfg = await cfgStore.loadBotConfig(); } catch { cfg = { escalations:{timeoutMinutes:5,maxAttempts:targets.length} }; }
  const entry = await createEntry(from, userMessage, targets, cfg);
  const item = { from, userMessage, targets, currentTargetIndex:0, timeoutMinutes:entry.timeoutMinutes, maxAttempts:entry.maxAttempts, logId:entry.id, expiresAt:entry.expiresAt };
  pendingEscalations[from] = item;
  escalationQueue.push(item);
  await sendWhatsappMessage(from, "Je transmets votre demande à un collaborateur, il revient vers vous très rapidement.");
  processEscalationQueue();
}

async function processEscalationQueue() {
  if (isProcessingEscalation || !escalationQueue.length) return;
  isProcessingEscalation = true;
  const item = escalationQueue.shift();
  try {
    if (!pendingEscalations[item.from]) return;
    let sent = false;
    for (let i=0; i<item.targets.length && i<item.maxAttempts; i++) {
      if (!pendingEscalations[item.from]) break;
      item.currentTargetIndex = i;
      const entry = await findEntry(item.logId); if (entry) { entry.currentTargetIndex = i; await persist(entry); }
      try { await notifyTarget(item, item.targets[i], i); sent = true; break; }
      catch (err) { log.error("Échec d'envoi au contact d'escalade, tentative suivante", { from:item.from, target:normalizePhone(item.targets[i]?.phone), attempt:i+1, error:err?.message || String(err) }); }
    }
    if (sent) scheduleNext(item.from);
    else {
      const entry = await findEntry(item.logId);
      if (entry) { entry.status="echec_envoi"; entry.closedAt=new Date().toISOString(); await persist(entry); }
      clearPending(item.from);
      await sendWhatsappMessage(item.from, "Je n'ai pas réussi à joindre notre équipe pour le moment. Votre demande n'a pas été perdue ; veuillez réessayer dans quelques instants.");
    }
  } catch (err) { log.error("Erreur lors du traitement de l'escalade", err); }
  finally { isProcessingEscalation=false; processEscalationQueue(); }
}

export async function noteAgentResponse(agentPhone, clientNumber) {
  if (!clientNumber || !pendingEscalations[clientNumber]) return false;
  clearPending(clientNumber); await closeEscalationLog(clientNumber);
  log.info("Escalade clôturée par réponse humaine", { agentPhone, clientNumber });
  return true;
}
export function clearPending(from) { delete pendingEscalations[from]; clearTimer(from); }

// Au démarrage, recharger les escalades en attente depuis SQLite/Supabase.
try {
  const entries = await escalationStore.listEscalations();
  for (const entry of entries.filter(e => e.status === "en_attente")) {
    pendingEscalations[entry.from] = {
      from: entry.from, userMessage: entry.userMessage, targets: entry.targets || [],
      currentTargetIndex: entry.currentTargetIndex || 0, timeoutMinutes: entry.timeoutMinutes || 5,
      maxAttempts: entry.maxAttempts || (entry.targets || []).length, logId: entry.id,
      expiresAt: entry.expiresAt || (Date.now() + 24 * 60 * 60 * 1000),
    };
    scheduleNext(entry.from);
  }
} catch (err) {
  log.warn("Impossible de restaurer les escalades persistantes au démarrage", err);
}
