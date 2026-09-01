import { supabase } from './supabase.client.js';
import { getDefaultBotConfig } from './botConfig.store.js';

const KEY = 'bot_config';

function mergeConfig(value) {
  const d = getDefaultBotConfig();
  const v = value && typeof value === 'object' ? value : {};
  return {
    ...d,
    ...v,
    setup: { ...d.setup, ...(v.setup || {}) },
    escalations: { ...d.escalations, ...(v.escalations || {}) },
    parcours: {
      ...d.parcours,
      ...(v.parcours || {}),
      quickOptions: { ...d.parcours.quickOptions, ...(v.parcours?.quickOptions || {}) },
      requiredBeforeOrder: { ...d.parcours.requiredBeforeOrder, ...(v.parcours?.requiredBeforeOrder || {}) },
    },
  };
}

export async function loadBotConfig() {
  const { data, error } = await supabase.from('bot_settings').select('value').eq('key', KEY).maybeSingle();
  if (error) throw new Error(error.message);
  return mergeConfig(data?.value);
}

export async function saveBotConfig(value) {
  const normalized = mergeConfig(value);
  const { data, error } = await supabase.from('bot_settings')
    .upsert({ key: KEY, value: normalized, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    .select('value').single();
  if (error) throw new Error(error.message);
  return mergeConfig(data.value);
}

export async function isInitialSetupComplete() {
  const cfg = await loadBotConfig();
  return cfg.setup?.completed === true;
}

export async function markInitialSetupComplete() {
  const cfg = await loadBotConfig();
  cfg.setup = { completed: true, completedAt: new Date().toISOString() };
  return saveBotConfig(cfg);
}
