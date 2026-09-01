import { db, getSetting, setSetting } from './sqlite.db.js';

const DEFAULT = {
  escalations: {
    timeoutMinutes: 5,
    maxAttempts: 3,
    numbers: [],
  },
  parcours: {
    quickOptions: {
      enabled: true,
      afterSimpleGreetingOnly: true,
      afterGreetingDelaySeconds: 0,
    },
    requiredBeforeOrder: {
      name: true,
      need: true,
    },
  },
};

function merge(base, value) {
  if (!value || typeof value !== 'object') return structuredClone(base);
  const out = structuredClone(base);
  if (value.escalations) out.escalations = { ...out.escalations, ...value.escalations };
  if (value.parcours) {
    out.parcours = { ...out.parcours, ...value.parcours };
    if (value.parcours.quickOptions) out.parcours.quickOptions = { ...out.parcours.quickOptions, ...value.parcours.quickOptions };
    if (value.parcours.requiredBeforeOrder) out.parcours.requiredBeforeOrder = { ...out.parcours.requiredBeforeOrder, ...value.parcours.requiredBeforeOrder };
  }
  return out;
}

export function loadBotConfig() {
  const raw = getSetting('bot_config', null);
  if (!raw) return structuredClone(DEFAULT);
  try { return merge(DEFAULT, JSON.parse(raw)); } catch { return structuredClone(DEFAULT); }
}

export function saveBotConfig(config) {
  const normalized = merge(DEFAULT, config);
  normalized.escalations.timeoutMinutes = Math.max(1, Math.min(1440, Number(normalized.escalations.timeoutMinutes) || 5));
  normalized.escalations.maxAttempts = Math.max(1, Math.min(10, Number(normalized.escalations.maxAttempts) || 3));
  normalized.escalations.numbers = (Array.isArray(normalized.escalations.numbers) ? normalized.escalations.numbers : [])
    .map((n, i) => ({
      id: String(n.id || `${Date.now()}-${i}`),
      label: String(n.label || `Numéro ${i + 1}`).trim(),
      phone: normalizePhone(n.phone),
      priority: Math.max(1, Number(n.priority) || i + 1),
      enabled: n.enabled !== false,
      start: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(n.start)) ? n.start : '00:00',
      end: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(n.end)) ? n.end : '23:59',
    }))
    .filter(n => n.phone);
  setSetting('bot_config', normalized);
  return normalized;
}

export function getEscalationTargets(now = new Date()) {
  const cfg = loadBotConfig();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const active = cfg.escalations.numbers.filter(n => n.enabled && n.phone && inWindow(minutes, n.start, n.end));
  return active.sort((a, b) => a.priority - b.priority);
}

function inWindow(minutes, start, end) {
  const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
  const a = toMin(start); const b = toMin(end);
  return a <= b ? minutes >= a && minutes <= b : minutes >= a || minutes <= b;
}

function normalizePhone(value) {
  let phone = String(value || '').trim().replace(/[^0-9+]/g, '');
  if (phone.startsWith('00')) phone = phone.slice(2);
  if (phone.startsWith('+')) phone = phone.slice(1);
  return phone;
}

export function getDefaultBotConfig() { return structuredClone(DEFAULT); }
