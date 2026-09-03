import { config } from "../config/env.js";
import { sendWhatsappMessage, sendWhatsappTemplate } from "./whatsapp.service.js";
import { summarizeForHuman } from "./chat.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("escalation");
const escalationQueue = [];
const pendingEscalations = {};
const timers = new Map();
let isProcessingEscalation = false;
let escalationIdCounter = 1;

// Dernier message entrant reçu depuis chaque numéro de collaborateur.
// WhatsApp autorise alors les messages texte libres pendant 24 h.
const humanAgentLastInboundAt = new Map();
// Verrou de création : un même client ne peut avoir qu'une seule escalade active.
const escalationCreationLocks = new Map();
const HUMAN_24H_MS = 24 * 60 * 60 * 1000;

export function noteHumanAgentInbound(phone, timestamp = Date.now()) {
  const normalized = normalizePhone(phone);
  if (!normalized) return;
  humanAgentLastInboundAt.set(normalized, Number(timestamp) || Date.now());
}

function hasOpenHuman24hWindow(phone) {
  const last = humanAgentLastInboundAt.get(normalizePhone(phone));
  return Boolean(last && Date.now() - last < HUMAN_24H_MS);
}

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
function inWindow(minutes, start, end) {
  const toMin = s => { const [h,m] = String(s || "00:00").split(":").map(Number); return h * 60 + m; };
  const a = toMin(start), b = toMin(end);
  return a <= b ? minutes >= a && minutes <= b : minutes >= a || minutes <= b;
}
// Les agents humains sont désormais gérés EXCLUSIVEMENT via l'interface
// d'administration (Configuration -> Escalades -> numéros), qui supporte
// déjà plusieurs agents avec priorité et plage horaire chacun. La variable
// d'environnement HUMAN_AGENT_NUMBER n'est plus utilisée ici : un seul
// numéro "en dur" au niveau du déploiement ne peut pas représenter
// plusieurs agents, et créait un risque de confusion avec un numéro
// ajouté légitimement via le GUI (voir historique de ce fichier).
async function targetsNow() {
  try {
    const cfg = await cfgStore.loadBotConfig();
    const minutes = new Date().getHours() * 60 + new Date().getMinutes();
    return (cfg.escalations?.numbers || [])
      .filter(n => n.enabled !== false && n.phone && inWindow(minutes, n.start, n.end))
      .sort((a,b) => (a.priority || 99) - (b.priority || 99));
  } catch (err) {
    log.warn("Impossible de charger la configuration d'escalade", err);
    return [];
  }
}


/** Envoie un message métier au premier numéro d'escalade actuellement actif,
 * tel que configuré dans l'admin (Configuration -> Escalades).
 */
export async function sendToConfiguredHuman(message) {
  const targets = await targetsNow();
  if (!targets.length) {
    throw new Error("Aucun agent humain configuré ou actif dans la fenêtre horaire actuelle. Ajoutez au moins un numéro dans Configuration -> Escalades.");
  }
  let lastError = null;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    try {
      const result = await sendWhatsappMessage(normalizePhone(target.phone), message);
      log.info("Message métier envoyé au collaborateur", {
        target: normalizePhone(target.phone),
        label: target.label,
        index: i + 1,
        messageId: result?.messages?.[0]?.id || null,
      });
      return { target, result };
    } catch (err) {
      lastError = err;
      log.error("Échec d'envoi au collaborateur configuré", {
        target: normalizePhone(target.phone),
        error: err?.message || String(err),
      });
    }
  }
  throw lastError || new Error("Impossible d'envoyer le message aux collaborateurs configurés.");
}

// Liste TOUS les numéros d'agents enregistrés via le GUI, indépendamment de
// leur plage horaire ou de leur statut activé/désactivé — un message reçu
// d'un agent doit être reconnu comme tel même hors de sa plage horaire ou
// s'il est temporairement désactivé pour les nouvelles escalades entrantes.
export async function getConfiguredHumanNumbers() {
  try {
    const cfg = await cfgStore.loadBotConfig();
    return [...new Set((cfg.escalations?.numbers || []).map(n => normalizePhone(n.phone)).filter(Boolean))];
  } catch { return []; }
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

async function createEntry(from, userMessage, targets, cfg, options = {}) {
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
    agentMessage: options.agentMessage || null,
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

async function sendEscalationTemplate(target, item) {
  if (!config.escalationTemplateName) return null;
  const title = item.agentMessage?.toLowerCase().includes("paiement")
    ? "Paiement à vérifier"
    : "Nouvelle demande";
  const result = await sendWhatsappTemplate(
    normalizePhone(target.phone),
    config.escalationTemplateName,
    config.escalationTemplateLanguage,
    [item.from, title],
  );
  return result;
}

async function notifyTarget(item, target, index) {
  const phone = normalizePhone(target.phone);
  if (!phone || phone.length < 8) throw new Error(`Numéro d'escalade invalide: ${target.phone}`);
  const summary = item.agentMessage ? null : await summarizeForHuman(item.from);
  const prefix = index === 0 ? "Nouvelle escalade" : "Relance escalade — le premier contact n'a pas répondu dans le délai configuré";
  const message = item.agentMessage
    ? `${item.agentMessage}\n\nPour répondre depuis WhatsApp : /repondre ${item.from} <message>\nPour clôturer : /resolu ${item.from}`
    : `${prefix}\n\nClient : ${item.from}\n\nRésumé : ${summary}\n\nDernier message : "${item.userMessage}"\n\nPour répondre depuis WhatsApp : /repondre ${item.from} <message>\nPour clôturer : /resolu ${item.from}`;
  try {
    // Si un template approuvé est configuré, on l'utilise directement : cela
    // évite l'échec différé Meta 131047 lorsque le collaborateur n'a pas ouvert
    // de fenêtre de conversation 24 h avec le compte WhatsApp Business.
    // Si le collaborateur a écrit au numéro WhatsApp Business dans les 24 h,
    // sa fenêtre de service est ouverte : on envoie le vrai message métier en
    // texte libre. Le template n'est utilisé que lorsque cette fenêtre n'est
    // pas ouverte (ou qu'aucun template n'est configuré).
    const open24h = hasOpenHuman24hWindow(phone);
    const result = open24h || !config.escalationTemplateName
      ? await sendWhatsappMessage(phone, message)
      : await sendEscalationTemplate(target, item);
    const entry = await findEntry(item.logId);
    if (entry) {
      entry.deliveries = [...(entry.deliveries || []), {
        target: phone,
        label: target.label,
        index,
        status: config.escalationTemplateName ? "template_envoye" : "envoye",
        sentAt: new Date().toISOString(),
        messageId: result?.messages?.[0]?.id || null,
      }];
      entry.lastDeliveryError = null;
      entry.currentTargetIndex = index;
      await persist(entry);
    }
    log.info("Escalade envoyée", { from:item.from, target:phone, index:index+1, mode:open24h ? "texte_24h" : (config.escalationTemplateName ? "template" : "texte"), messageId:result?.messages?.[0]?.id });
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

export async function enqueueEscalation(from, userMessage, options = {}) {
  const normalizedFrom = normalizePhone(from);
  if (!normalizedFrom) throw new Error("Numéro client invalide pour l'escalade.");

  // Une seule escalade active par numéro client. Cette vérification porte sur
  // la mémoire ET le stockage persistant afin de rester vraie après un
  // redémarrage du serveur.
  const existing = pendingEscalations[normalizedFrom]
    ? await findEntry(pendingEscalations[normalizedFrom].logId)
    : (await escalationStore.listEscalations()).find(e =>
        normalizePhone(e?.from) === normalizedFrom && e?.status === "en_attente"
      );
  if (existing) {
    pendingEscalations[normalizedFrom] ||= {
      from: normalizedFrom,
      userMessage: existing.userMessage,
      targets: existing.targets || [],
      currentTargetIndex: existing.currentTargetIndex || 0,
      timeoutMinutes: existing.timeoutMinutes || 5,
      maxAttempts: existing.maxAttempts || (existing.targets || []).length,
      logId: existing.id,
      expiresAt: existing.expiresAt || (Date.now() + 24 * 60 * 60 * 1000),
      agentMessage: existing.agentMessage || null,
    };
    log.info("Escalade déjà active pour ce numéro — nouvelle escalade refusée", {
      from: normalizedFrom,
      existingEscalationId: existing.id,
    });
    if (options.notifyClient !== false) {
      await sendWhatsappMessage(normalizedFrom, "Votre demande est déjà en cours de traitement par notre équipe. Nous vous recontactons dès qu'elle est résolue.");
    }
    return existing;
  }

  // Évite deux créations simultanées pour le même numéro dans le même
  // processus (double webhook, double clic, etc.).
  while (escalationCreationLocks.has(normalizedFrom)) {
    await escalationCreationLocks.get(normalizedFrom);
  }
  let releaseLock;
  const lock = new Promise(resolve => { releaseLock = resolve; });
  escalationCreationLocks.set(normalizedFrom, lock);

  try {
    // Re-vérification après attente du verrou.
    const concurrent = (await escalationStore.listEscalations()).find(e =>
      normalizePhone(e?.from) === normalizedFrom && e?.status === "en_attente"
    );
    if (concurrent) {
      pendingEscalations[normalizedFrom] ||= {
        from: normalizedFrom, userMessage: concurrent.userMessage,
        targets: concurrent.targets || [], currentTargetIndex: concurrent.currentTargetIndex || 0,
        timeoutMinutes: concurrent.timeoutMinutes || 5, maxAttempts: concurrent.maxAttempts || (concurrent.targets || []).length,
        logId: concurrent.id, expiresAt: concurrent.expiresAt || (Date.now() + 24 * 60 * 60 * 1000),
        agentMessage: concurrent.agentMessage || null,
      };
      if (options.notifyClient !== false) {
        await sendWhatsappMessage(normalizedFrom, "Votre demande est déjà en cours de traitement par notre équipe. Nous vous recontactons dès qu'elle est résolue.");
      }
      return concurrent;
    }

    const targets = await targetsNow();
    if (!targets.length) {
      // Ne plus échouer silencieusement : sans ça, l'appelant (ex.
      // escalatePaymentVerification) ne déclenchait jamais son propre
      // catch, donc ni le client ni personne n'était informé qu'aucun
      // agent n'était disponible — cause fréquente de "l'escalade n'a
      // jamais notifié personne" alors que la fenêtre WhatsApp 24h de
      // l'agent était pourtant ouverte : ce qui bloque ici, c'est la
      // plage horaire/l'activation de l'agent configurée dans l'admin
      // (Configuration -> Escalades), pas la fenêtre de conversation
      // WhatsApp.
      log.error("Aucun agent humain actif pour cette escalade — vérifiez Configuration -> Escalades (numéro activé + plage horaire couvrant l'heure actuelle)", { from: normalizedFrom });
      throw new Error("Aucun agent humain configuré ou actif dans la fenêtre horaire actuelle. Vérifiez Configuration -> Escalades.");
    }
    let cfg; try { cfg = await cfgStore.loadBotConfig(); } catch { cfg = { escalations:{timeoutMinutes:5,maxAttempts:targets.length} }; }
    const entry = await createEntry(normalizedFrom, userMessage, targets, cfg, options);
    const item = { from:normalizedFrom, userMessage, targets, currentTargetIndex:0, timeoutMinutes:entry.timeoutMinutes, maxAttempts:entry.maxAttempts, logId:entry.id, expiresAt:entry.expiresAt, agentMessage: options.agentMessage || null };
    pendingEscalations[normalizedFrom] = item;
    escalationQueue.push(item);
    if (options.notifyClient !== false) {
      await sendWhatsappMessage(normalizedFrom, "Je transmets votre demande à un collaborateur, il revient vers vous très rapidement.");
    }
    processEscalationQueue();
    return entry;
  } finally {
    escalationCreationLocks.delete(normalizedFrom);
    releaseLock();
  }
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

export async function handleWhatsappEscalationStatus(status) {
  const messageId = status?.id;
  if (!messageId) return false;
  const entries = await escalationStore.listEscalations();
  const entry = entries.find((candidate) =>
    (candidate.deliveries || []).some((delivery) => delivery.messageId === messageId)
  );
  if (!entry) return false;

  const delivery = [...(entry.deliveries || [])].reverse().find((item) => item.messageId === messageId);
  if (!delivery) return false;

  delivery.status = status.status || delivery.status;
  delivery.statusAt = new Date().toISOString();
  if (status.errors?.length) {
    delivery.errorCode = status.errors[0]?.code || null;
    delivery.errorTitle = status.errors[0]?.title || null;
    delivery.errorMessage = status.errors[0]?.message || null;
  }
  await persist(entry);

  // Meta peut accepter le POST initial puis le refuser ensuite avec 131047
  // lorsque le collaborateur n'a pas de fenêtre 24 h ouverte. Dans ce cas,
  // si un template approuvé est configuré, on le renvoie automatiquement.
  const code = Number(status.errors?.[0]?.code);
  if (status.status === "failed" && code === 131047 && config.escalationTemplateName) {
    try {
      const target = entry.targets?.[delivery.index];
      if (!target?.phone) throw new Error("Cible d'escalade introuvable pour la relance template.");
      const retry = await sendEscalationTemplate(target, entry);
      const retryId = retry?.messages?.[0]?.id || null;
      entry.deliveries = [
        ...(entry.deliveries || []),
        {
          target: normalizePhone(target.phone),
          label: target.label,
          index: delivery.index,
          status: "template_envoye",
          sentAt: new Date().toISOString(),
          messageId: retryId,
          fallbackFor: messageId,
        },
      ];
      entry.lastDeliveryError = null;
      await persist(entry);
      log.info("Escalade relancée avec le template WhatsApp après erreur 131047", {
        from: entry.from,
        target: normalizePhone(target.phone),
        messageId: retryId,
      });
    } catch (err) {
      entry.lastDeliveryError = err?.message || String(err);
      await persist(entry);
      log.error("Impossible de relancer l'escalade avec le template WhatsApp", {
        from: entry.from,
        error: entry.lastDeliveryError,
      });
    }
  }

  return true;
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
      maxAttempts: entry.maxAttempts || (entry.targets || []).length, logId: entry.id, agentMessage: entry.agentMessage || null,
      expiresAt: entry.expiresAt || (Date.now() + 24 * 60 * 60 * 1000),
    };
    scheduleNext(entry.from);
  }
} catch (err) {
  log.warn("Impossible de restaurer les escalades persistantes au démarrage", err);
}