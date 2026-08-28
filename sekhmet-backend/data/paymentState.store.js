import fs from "fs";

// Persiste l'état transitoire du cycle de paiement, PAR CLIENT :
//   - pendingPayment : demande de vérification en attente ({userMessage, compteMobileMoney, timestamp} | null)
//   - awaitingDelaiCommandeId : id de la commande payée en attente d'un délai de livraison (string | null)
//   - selections : quantités choisies par le client, pas encore rattachées à une commande ([] par défaut)
//
// AVANT ce fichier, ces trois informations vivaient uniquement dans des
// objets JS en mémoire (voir payment.service.js) : un redémarrage du
// serveur (crash, redéploiement) les effaçait purement et simplement,
// avec le risque de "perdre" une commande en cours (paiement en attente
// de vérification jamais relancé, quantité choisie par le client jamais
// rattachée à une commande, etc). Ce store les rend persistants, avec le
// même bascule JSON local / Supabase que le reste du projet.

const PAYMENT_STATE_PATH = "./payment-state.json";

function readAll() {
  try {
    const raw = fs.readFileSync(PAYMENT_STATE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeAll(states) {
  fs.writeFileSync(PAYMENT_STATE_PATH, JSON.stringify(states, null, 2));
}

export async function loadPaymentStates() {
  return readAll();
}

export async function getPaymentState(phone) {
  const all = readAll();
  return all[phone] || null;
}

export async function upsertPaymentState(phone, state) {
  const all = readAll();
  all[phone] = state;
  writeAll(all);
  return all[phone];
}

export async function deletePaymentState(phone) {
  const all = readAll();
  delete all[phone];
  writeAll(all);
}
