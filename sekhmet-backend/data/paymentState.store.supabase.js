import { supabase } from "./supabase.client.js";

// Équivalent Supabase de paymentState.store.js — même contrat (mêmes
// noms de champs en camelCase côté appelant), stocké dans la table
// `payment_state` (une ligne par client, clé = phone). Voir
// supabase_schema.sql pour la définition de la table.

function rowToState(row) {
  return {
    pendingPayment: row.pending_payment || null,
    awaitingDelaiCommandeId: row.awaiting_delai_commande_id || null,
    selections: row.selections || [],
    awaitingDeliveryConfirmation: row.awaiting_delivery_confirmation || null,
    // Ces champs manquaient ici : ils étaient bien lus/écrits en mémoire par
    // payment.service.js mais jamais réellement persistés côté Supabase, donc
    // perdus au moindre redémarrage du serveur.
    awaitingCartAbandonConfirmation: row.awaiting_cart_abandon_confirmation || false,
    awaitingPaymentAccountInfo: row.awaiting_payment_account_info || null,
    awaitingCartValidationConfirmation: row.awaiting_cart_validation_confirmation || false,
    awaitingDeliveryAddress: row.awaiting_delivery_address || false,
    deliveryAddress: row.delivery_address || null,
  };
}

export async function loadPaymentStates() {
  const { data, error } = await supabase.from("payment_state").select("*");
  if (error) {
    console.error("Supabase loadPaymentStates:", error.message);
    return {};
  }
  const result = {};
  for (const row of data) {
    result[row.phone] = rowToState(row);
  }
  return result;
}

export async function getPaymentState(phone) {
  const { data, error } = await supabase
    .from("payment_state")
    .select("*")
    .eq("phone", phone)
    .single();
  if (error) return null;
  return rowToState(data);
}

export async function upsertPaymentState(phone, state) {
  const { error } = await supabase.from("payment_state").upsert({
    phone,
    pending_payment: state.pendingPayment ?? null,
    awaiting_delai_commande_id: state.awaitingDelaiCommandeId ?? null,
    selections: state.selections ?? [],
    awaiting_delivery_confirmation: state.awaitingDeliveryConfirmation ?? null,
    awaiting_cart_abandon_confirmation: state.awaitingCartAbandonConfirmation ?? false,
    awaiting_payment_account_info: state.awaitingPaymentAccountInfo ?? null,
    awaiting_cart_validation_confirmation: state.awaitingCartValidationConfirmation ?? false,
    awaiting_delivery_address: state.awaitingDeliveryAddress ?? false,
    delivery_address: state.deliveryAddress ?? null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return state;
}

export async function deletePaymentState(phone) {
  const { error } = await supabase.from("payment_state").delete().eq("phone", phone);
  if (error) throw new Error(error.message);
}