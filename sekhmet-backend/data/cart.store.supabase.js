import { supabase } from "./supabase.client.js";

export async function loadCarts() {
  const { data, error } = await supabase.from("carts").select("phone,items");
  if (error) throw new Error(error.message);
  return Object.fromEntries((data || []).map(r => [r.phone, Array.isArray(r.items) ? r.items : []]));
}
export async function getCart(phone) {
  const { data, error } = await supabase.from("carts").select("items").eq("phone", phone).maybeSingle();
  if (error) throw new Error(error.message);
  return Array.isArray(data?.items) ? data.items : [];
}
export async function upsertCart(phone, items) {
  const { error } = await supabase.from("carts").upsert({ phone, items: Array.isArray(items) ? items : [], updated_at: new Date().toISOString() }, { onConflict: "phone" });
  if (error) throw new Error(error.message);
  return items;
}
export async function deleteCart(phone) {
  const { error } = await supabase.from("carts").delete().eq("phone", phone);
  if (error) throw new Error(error.message);
}
