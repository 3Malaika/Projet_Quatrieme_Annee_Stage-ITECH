import { supabase } from "./supabase.client.js";

// Équivalent Supabase de paymentState.store.js — même contrat (mêmes
// noms de champs en camelCase côté appelant), stocké dans la table
// `payment_state` (une ligne par client, clé = phone). Voir
// supabase_schema.sql pour la définition de la table.
//
// NOUVEAU (adresse de livraison) : nécessite deux colonnes supplémentaires
// sur la table `payment_state`, à créer une fois via une migration :
//
//   ALTER TABLE payment_state
//     ADD COLUMN IF NOT EXISTS delivery_address text,
//     ADD COLUMN IF NOT EXISTS awaiting_delivery_address boolean NOT NULL DEFAULT false;
//
// Tant que cette migration n'est pas appliquée, upsertPaymentState échouera
// avec une erreur explicite de colonne manquante (voir env SUPABASE_URL).

function rowToState(row) {
  return {
    pendingPayment: row.pending_payment || null,
    awaitingDelaiCommandeId: row.awaiting_delai_commande_id || null,
    selections: row.selections || [],
    awaitingDeliveryConfirmation: row.awaiting_delivery_confirmation || null,
    deliveryAddress: row.delivery_address || null,
    awaitingDeliveryAddress: Boolean(row.awaiting_delivery_address),
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
    delivery_address: state.deliveryAddress ?? null,
    awaiting_delivery_address: Boolean(state.awaitingDeliveryAddress),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return state;
}

export async function deletePaymentState(phone) {
  const { error } = await supabase.from("payment_state").delete().eq("phone", phone);
  if (error) throw new Error(error.message);
}