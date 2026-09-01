import { supabase } from './supabase.client.js';
import { getDefaultBotConfig } from './botConfig.store.js';

const KEY = 'bot_config';
export async function loadBotConfig() {
  const { data, error } = await supabase.from('bot_settings').select('value').eq('key', KEY).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.value ? { ...getDefaultBotConfig(), ...data.value, escalations: { ...getDefaultBotConfig().escalations, ...(data.value.escalations || {}) }, parcours: { ...getDefaultBotConfig().parcours, ...(data.value.parcours || {}) } } : getDefaultBotConfig();
}
export async function saveBotConfig(value) {
  const { data, error } = await supabase.from('bot_settings').upsert({ key: KEY, value }, { onConflict: 'key' }).select('value').single();
  if (error) throw new Error(error.message);
  return data.value;
}
