import { config } from "../config/env.js";
import { sendWhatsappMessage } from "./whatsapp.service.js";
import { summarizeForHuman } from "./chat.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("escalation");
const escalationQueue = [];
const pendingEscalations = {};
const timers = new Map();
let isProcessingEscalation = false;
const escalationsLog = [];
let escalationIdCounter = 1;

const store = config.supabaseUrl
  ? await import("../data/botConfig.store.supabase.js")
  : await import("../data/botConfig.store.js");

function normalizePhone(value) { return String(value || "").replace(/\s+/g, ""); }
function fallbackTarget() { return config.humanAgentNumber ? [{ phone: normalizePhone(config.humanAgentNumber), label: "Numéro principal", priority: 1, enabled: true, start: "00:00", end: "23:59" }] : []; }
async function targetsNow() {
  try {
    if (config.supabaseUrl) {
      const cfg = await store.loadBotConfig();
      const minutes = new Date().getHours() * 60 + new Date().getMinutes();
      const toMin = s => { const [h,m] = String(s||"00:00").split(":").map(Number); return h*60+m; };
      const inWindow = (n) => { const a=toMin(n.start), b=toMin(n.end); return a<=b ? minutes>=a&&minutes<=b : minutes>=a||minutes<=b; };
      const arr=(cfg.escalations?.numbers||[]).filter(n=>n.enabled!==false&&n.phone&&inWindow(n)).sort((a,b)=>(a.priority||99)-(b.priority||99));
      return arr.length ? arr : fallbackTarget();
    }
    const arr = store.getEscalationTargets();
    return arr.length ? arr : fallbackTarget();
  } catch (err) { log.warn("Impossible de charger la configuration d'escalade", err); return fallbackTarget(); }
}

export async function getConfiguredHumanNumbers() {
  const fallback = fallbackTarget().map(x => x.phone);
  try { const cfg = await store.loadBotConfig(); return [...new Set([...fallback, ...(cfg.escalations?.numbers || []).map(n=>normalizePhone(n.phone)).filter(Boolean)])]; }
  catch { return fallback; }
}

export async function isHumanAgentNumber(phone) { return (await getConfiguredHumanNumbers()).includes(normalizePhone(phone)); }

export function isPending(from) {
  const item = pendingEscalations[from];
  if (!item) return false;
  if (item.expiresAt && Date.now() > item.expiresAt) { clearPending(from); return false; }
  return true;
}

function logEscalation(from, userMessage, targets) {
  const entry = { id:String(escalationIdCounter++), from, userMessage, status:"en_attente", createdAt:new Date().toISOString(), closedAt:null, targets, currentTargetIndex:0 };
  escalationsLog.push(entry); return entry;
}
export function closeEscalationLog(from) {
  const entry=[...escalationsLog].reverse().find(e=>e.from===from&&e.status==="en_attente");
  if(entry){entry.status="cloturee";entry.closedAt=new Date().toISOString();clearTimer(from);} return entry;
}
export function getEscalationsLog(){ return escalationsLog.slice().reverse(); }
export function findEscalation(id){ return escalationsLog.find(e=>e.id===String(id)); }
export function closeEscalationById(id){ const e=findEscalation(id); if(!e)return null; e.status="cloturee";e.closedAt=new Date().toISOString();delete pendingEscalations[e.from];clearTimer(e.from);return e; }
function clearTimer(from){ const t=timers.get(from); if(t) clearTimeout(t); timers.delete(from); }

async function notifyTarget(item, target, index) {
  const summary = await summarizeForHuman(item.from);
  const prefix = index === 0 ? "⚠️ Nouvelle escalade" : "🔁 Relance escalade — le premier contact n'a pas répondu dans le délai configuré";
  await sendWhatsappMessage(target.phone, `${prefix}\n\nClient : ${item.from}\n\nRésumé : ${summary}\n\nDernier message : "${item.userMessage}"\n\nPour répondre depuis WhatsApp : /repondre ${item.from} <message>\nPour clôturer : /resolu ${item.from}`);
  log.info("Escalade envoyée", { from:item.from, target:target.phone, index:index+1 });
}

function scheduleNext(from) {
  const item = pendingEscalations[from]; if(!item) return;
  clearTimer(from);
  const timeout = Math.max(1, Number(item.timeoutMinutes)||5) * 60 * 1000;
  timers.set(from, setTimeout(async () => {
    try {
      const current = pendingEscalations[from];
      if(!current) return;
      const dynamicTargets = await targetsNow();
      const alreadyTried = new Set(current.targets.slice(0, current.currentTargetIndex + 1).map(t => normalizePhone(t.phone)));
      const nextTarget = dynamicTargets.find(t => !alreadyTried.has(normalizePhone(t.phone))) || current.targets[current.currentTargetIndex + 1];
      const nextIndex = current.currentTargetIndex + 1;
      if (!nextTarget || nextIndex >= current.maxAttempts) {
        log.warn("Escalade arrivée à la fin des tentatives", { from });
        return;
      }
      current.targets = [...current.targets, ...dynamicTargets.filter(t => !current.targets.some(x => normalizePhone(x.phone) === normalizePhone(t.phone)))];
      current.currentTargetIndex = current.targets.findIndex(t => normalizePhone(t.phone) === normalizePhone(nextTarget.phone));
      const entry = findEscalation(current.logId); if(entry){entry.currentTargetIndex=current.currentTargetIndex;entry.targets=current.targets;}
      await notifyTarget(current, nextTarget, current.currentTargetIndex);
      scheduleNext(from);
    } catch(err){ log.error("Erreur lors de la relance d'escalade", err); scheduleNext(from); }
  }, timeout));
}

export async function enqueueEscalation(from, userMessage) {
  const targets = await targetsNow();
  if(!targets.length) { log.error("Aucun numéro d'escalade configuré"); return; }
  let cfg; try { cfg=await store.loadBotConfig(); } catch { cfg={escalations:{timeoutMinutes:5,maxAttempts:targets.length}}; }
  const entry=logEscalation(from,userMessage,targets);
  const item={from,userMessage,targets,currentTargetIndex:0,timeoutMinutes:cfg.escalations?.timeoutMinutes||5,maxAttempts:Math.min(Number(cfg.escalations?.maxAttempts)||targets.length,targets.length),logId:entry.id,expiresAt:Date.now()+24*60*60*1000};
  pendingEscalations[from]=item;
  escalationQueue.push(item);
  await sendWhatsappMessage(from,"Je transmets votre demande à un collaborateur, il revient vers vous très rapidement.");
  processEscalationQueue();
}

async function processEscalationQueue(){
  if(isProcessingEscalation||!escalationQueue.length)return;
  isProcessingEscalation=true; const item=escalationQueue.shift();
  try { if(pendingEscalations[item.from]) { await notifyTarget(item,item.targets[0],0); scheduleNext(item.from); } }
  catch(err){log.error("Erreur lors de l'escalade",err);} finally {isProcessingEscalation=false;processEscalationQueue();}
}

export function noteAgentResponse(agentPhone, clientNumber) {
  if (!clientNumber) return false;
  if (!pendingEscalations[clientNumber]) return false;
  clearPending(clientNumber); closeEscalationLog(clientNumber); log.info("Escalade clôturée par réponse humaine", { agentPhone, clientNumber }); return true;
}
export function clearPending(from){ delete pendingEscalations[from]; clearTimer(from); }
