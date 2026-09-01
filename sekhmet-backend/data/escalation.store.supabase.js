import { supabase } from './supabase.client.js';

export async function listEscalations() {
  const { data, error } = await supabase.from('escalation_logs').select('data').order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(r => r.data).filter(Boolean);
}

export async function getEscalation(id) {
  const { data, error } = await supabase.from('escalation_logs').select('data').eq('id', String(id)).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.data || null;
}

export async function saveEscalation(entry) {
  const now = new Date().toISOString();
  const { error } = await supabase.from('escalation_logs').upsert({
    id: String(entry.id),
    data: entry,
    created_at: entry.createdAt || now,
    updated_at: now,
  }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
  return entry;
}
