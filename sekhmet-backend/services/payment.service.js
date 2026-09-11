import { config } from "../config/env.js";
import { sendWhatsappMessage, sendWhatsappPdf } from "./whatsapp.service.js";
import { formatMontantFcfa } from "./catalogueFormatter.service.js";
import { generateInvoicePdfBuffer, generateNumeroFacture } from "./invoice.service.js";
import { createLogger } from "../utils/logger.js";
import { sendToConfiguredHuman, enqueueEscalation, closeEscalationLog } from "./escalation.service.js";

const log = createLogger("payment");

function extractPaymentAccountName(text) {
  const patterns = [
    /(?:au nom de|nom du compte|compte au nom de)\s*[:=]?\s*([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,80})/i,
    /(?:j['’]ai payé avec|j['’]ai paye avec|payé sur|paye sur)\s*([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim().replace(/[.!?,;:]+$/, "");
    }
  }
  return null;
}

function extractPaymentAccountNumber(text) {
  const withPrefix = text.match(/(?:\+|00)?237[\s.-]?[0-9]{9}/);
  if (withPrefix) return withPrefix[0].replace(/[^0-9]/g, "").replace(/^00/, "");
  const local = text.match(/\b6[\s.-]?[0-9](?:[\s.-]?[0-9]){7}\b/);
  if (local) return "237" + local[0].replace(/[^0-9]/g, "");
  return null;
}

function extractPaymentInfo(userMessage) {
  const text = String(userMessage || "");
  return {
    compteMobileMoney: extractPaymentAccountName(text),
    numeroCompteMobileMoney: extractPaymentAccountNumber(text),
  };
}

const commandesStore = config.supabaseUrl
  ? await import("../data/commandes.store.supabase.js")
  : await import("../data/commandes.store.js");

const clientsStore = config.supabaseUrl
  ? await import("../data/clients.store.supabase.js")
  : await import("../data/clients.store.js");

const paymentStateStore = config.supabaseUrl
  ? await import("../data/paymentState.store.supabase.js")
  : await import("../data/paymentState.store.js");

const cartStore = config.supabaseUrl
  ? await import("../data/cart.store.supabase.js")
  : await import("../data/cart.store.js");

const carts = await cartStore.loadCarts().catch((err) => {
  log.error("Impossible de charger les paniers persistants", err);
  return {};
});

const paymentStates = await paymentStateStore.loadPaymentStates();
log.info("État de paiement chargé au démarrage", { clientsEnCours: Object.keys(paymentStates).length });

function getState(phone) {
  return (
    paymentStates[phone] || {
      pendingPayment: null,
      awaitingDelaiCommandeId: null,
      awaitingDeliveryConfirmation: null,
      selections: [],
      awaitingCartAbandonConfirmation: false,
      awaitingPaymentAccountInfo: null,
      deliveryAddress: null,
      awaitingDeliveryAddress: false,
      awaitingClientName: false,
    }
  );
}

export function getPendingPaymentClients() {
  return Object.entries(paymentStates)
    .filter(([, state]) => Boolean(state?.pendingPayment))
    .map(([phone, state]) => ({
      phone,
      ...state.pendingPayment,
      total: getCartTotal(phone),
      adresseLivraison: state.deliveryAddress || null,
    }));
}

async function persistState(phone, state) {
  const isEmpty =
    !state.pendingPayment && !state.awaitingDelaiCommandeId && !state.awaitingDeliveryConfirmation && !state.awaitingCartAbandonConfirmation && !state.awaitingPaymentAccountInfo && !state.deliveryAddress && !state.awaitingDeliveryAddress && !state.awaitingClientName && state.selections.length === 0;

  if (isEmpty) {
    delete paymentStates[phone];
    await paymentStateStore.deletePaymentState(phone).catch((err) =>
      log.error("Erreur suppression état de paiement persistant", { phone, err })
    );
    return;
  }

  paymentStates[phone] = state;
  await paymentStateStore.upsertPaymentState(phone, state).catch((err) =>
    log.error("Erreur sauvegarde état de paiement persistant", { phone, err })
  );
}

export async function recordProductSelection(from, selection) {
  const state = getState(from);
  const item = { ...selection, timestamp: Date.now() };
  const currentCart = Array.isArray(carts[from]) ? carts[from] : [];

  // Fusion par produitId : si le produit est déjà dans le panier, on cumule
  // la quantité et le total plutôt que d'ajouter une ligne en double.
  // Cela évite les doublons quand Groq appelle ajout_panier plusieurs fois
  // pour le même produit (reformulation, boucle de confirmation, etc.).
  const existingIndex = currentCart.findIndex((i) => i.produitId && i.produitId === item.produitId);
  let merged;
  if (existingIndex >= 0) {
    const existing = currentCart[existingIndex];
    const newQte = (existing.quantite || 0) + (item.quantite || 0);
    const newTotal = item.prixUnitaire ? item.prixUnitaire * newQte : null;
    merged = [
      ...currentCart.slice(0, existingIndex),
      { ...existing, quantite: newQte, total: newTotal, timestamp: Date.now() },
      ...currentCart.slice(existingIndex + 1),
    ];
    log.info("Quantité cumulée pour produit déjà au panier", { from, produitId: item.produitId, newQte });
  } else {
    merged = [...currentCart, item];
  }

  carts[from] = merged;
  await cartStore.upsertCart(from, merged);
  state.selections = merged;
  await persistState(from, state);
  log.info("Sélection de quantité mémorisée en attente de paiement", { from, selection });
}

export function getPendingSelections(from) {
  return Array.isArray(carts[from]) ? carts[from] : getState(from).selections;
}

export function getCart(from) {
  return normalizeSelections(Array.isArray(carts[from]) ? carts[from] : getState(from).selections);
}

export function getCartTotal(from) {
  return getCart(from).reduce((sum, item) => sum + (Number(item.total) || 0), 0);
}

export function getCartCount(from) {
  return getCart(from).reduce((sum, item) => sum + (Number(item.quantite) || 0), 0);
}

export function formatCart(from) {
  const items = getCart(from);
  if (!items.length) return "Votre panier est vide.";
  const lines = items.map((item) =>
    `• ${item.quantite} x *${item.nom}* — ${formatMontantFcfa(Number(item.total) || 0)}`
  );
  const total = getCartTotal(from);
  return `🛍️ *Votre commande*\n\n${lines.join("\n")}\n\n*Total : ${formatMontantFcfa(total)}*`;
}

export function getAllActiveCarts() {
  return Object.entries(paymentStates)
    .map(([phone, state]) => {
      const selections = normalizeSelections(state?.selections || []);
      if (!selections.length) return null;
      const rawSelections = Array.isArray(state?.selections) ? state.selections : [];
      const updatedAt = rawSelections.reduce((latest, item) => {
        const ts = Number(item?.timestamp) || 0;
        return ts > latest ? ts : latest;
      }, 0);
      return {
        phone,
        items: selections,
        total: selections.reduce((sum, item) => sum + (Number(item.total) || 0), 0),
        count: selections.reduce((sum, item) => sum + (Number(item.quantite) || 0), 0),
        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
}

export function isAwaitingCartAbandonConfirmation(from) {
  return Boolean(getState(from).awaitingCartAbandonConfirmation);
}

export async function requestCartAbandonConfirmation(from) {
  const state = getState(from);
  if (!getCart(from).length) return false;
  state.awaitingCartAbandonConfirmation = true;
  await persistState(from, state);
  return true;
}

export async function cancelCartAbandonConfirmation(from) {
  const state = getState(from);
  state.awaitingCartAbandonConfirmation = false;
  await persistState(from, state);
}

export async function confirmCartAbandonment(from) {
  const state = getState(from);
  if (!state.awaitingCartAbandonConfirmation) return false;
  state.awaitingCartAbandonConfirmation = false;
  state.selections = [];
  delete carts[from];
  await cartStore.deleteCart(from);
  await persistState(from, state);
  return true;
}

export async function clearCart(from) {
  const state = getState(from);
  state.selections = [];
  delete carts[from];
  await cartStore.deleteCart(from);
  await persistState(from, state);
}

function normalizeSelections(selections) {
  const byProduct = new Map();
  for (const raw of Array.isArray(selections) ? selections : []) {
    const key = String(raw.produitId ?? raw.nom ?? "produit");
    const qty = Number(raw.quantite) || 0;
    const unit = Number(raw.prixUnitaire ?? raw.prix ?? 0) || 0;
    if (!qty) continue;
    const prev = byProduct.get(key);
    if (prev) {
      prev.quantite += qty;
      prev.total = prev.quantite * prev.prixUnitaire;
    } else {
      byProduct.set(key, { ...raw, quantite: qty, prixUnitaire: unit, total: unit * qty });
    }
  }
  return [...byProduct.values()];
}

function describeSelections(selections) {
  return normalizeSelections(selections).map((s) => `${s.quantite} x ${s.nom}`).join(", ");
}

export function hasDeliveryAddress(from) {
  return Boolean(getState(from).deliveryAddress);
}

export function getDeliveryAddress(from) {
  return getState(from).deliveryAddress || null;
}

export function isAwaitingDeliveryAddress(from) {
  return Boolean(getState(from).awaitingDeliveryAddress);
}

export async function cancelDeliveryAddressRequest(from) {
  const state = getState(from);
  state.awaitingDeliveryAddress = false;
  await persistState(from, state);
}

export async function requestDeliveryAddress(from) {
  const state = getState(from);
  state.awaitingDeliveryAddress = true;
  await persistState(from, state);
  log.info("Adresse de livraison demandée avant l'envoi des modalités de paiement", { from });
  await sendWhatsappMessage(
    from,
    "Avant de vous donner les modalités de paiement, quelle est votre adresse de livraison (quartier, ville, repère) ?"
  );
}

export async function provideDeliveryAddress(from, address) {
  const trimmed = String(address || "").trim();
  if (!trimmed) return false;
  const state = getState(from);
  state.deliveryAddress = trimmed;
  state.awaitingDeliveryAddress = false;
  await persistState(from, state);
  log.info("Adresse de livraison enregistrée", { from, adresse: trimmed });
  return true;
}

export function isAwaitingClientName(from) {
  return Boolean(getState(from).awaitingClientName);
}

export async function requestClientName(from) {
  const state = getState(from);
  state.awaitingClientName = true;
  await persistState(from, state);
  log.info("Nom du client demandé avant de valider la commande", { from });
  await sendWhatsappMessage(from, "Avant de valider votre commande, quel est votre nom ?");
}

export async function clearAwaitingClientName(from) {
  const state = getState(from);
  state.awaitingClientName = false;
  await persistState(from, state);
}

async function escalatePaymentVerification(from, userMessage, { compteMobileMoney, numeroCompteMobileMoney }) {
  const state = getState(from);

  // Garde-fou (dernier rempart) : ne jamais escalader une "confirmation de
  // paiement" pour un panier vide. requestPaymentConfirmation() a déjà un
  // garde-fou similaire en amont, mais provideMobileMoneyAccountInfo()
  // (déclenché par le raccourci "confirmation simple détectée côté code"
  // dans webhook.routes.js dès que awaitingPaymentAccountInfo est actif,
  // sur un simple "oui" qui peut répondre à toute autre question) appelle
  // aussi cette fonction SANS repasser par ce garde-fou amont — c'est
  // exactement le chemin qui a produit l'escalade fantôme vue dans les
  // logs (panier vide, montant 0). On coupe donc ici aussi, au point de
  // passage unique des 3 appelants.
  if (!getCart(from).length) {
    state.awaitingPaymentAccountInfo = null;
    state.pendingPayment = null;
    await persistState(from, state);
    log.warn("Confirmation de paiement ignorée : panier vide", { from, userMessage });
    await sendWhatsappMessage(
      from,
      "Je ne trouve pas de commande en cours pour vous en ce moment. Si vous souhaitez commander, dites-moi ce qui vous intéresse 🙂"
    );
    return;
  }

  state.awaitingPaymentAccountInfo = null;
  state.pendingPayment = { userMessage, compteMobileMoney, numeroCompteMobileMoney, timestamp: Date.now() };
  await persistState(from, state);

  const cart = formatCart(from);
  const total = getCartTotal(from);
  const client = await clientsStore.getClient(from).catch(() => null);
  const nomClient = client?.nom || null;
  const adresse = getDeliveryAddress(from);

  log.info("Demande de confirmation de paiement (en attente du collaborateur)", {
    from, compteMobileMoney, numeroCompteMobileMoney, total, lignes: getCart(from).length
  });

  await sendWhatsappMessage(
    from,
    `Merci ! Je vérifie la réception de votre paiement, un instant 🙏\n\n${cart}`
  );

  const compteLigne = [
    `Numéro du compte de paiement (clé unique) : ${numeroCompteMobileMoney}`,
    compteMobileMoney ? `Nom attendu sur ce compte : ${compteMobileMoney}` : null,
  ].filter(Boolean).join("\n");

  try {
    await enqueueEscalation(from, userMessage, {
      notifyClient: false,
      agentMessage: `💰 Paiement à vérifier — conversation ${from}${nomClient ? ` (client : ${nomClient})` : ""}\n\nPanier${nomClient ? ` de ${nomClient}` : ""} :\n${cart}\n\nMontant à recevoir : ${formatMontantFcfa(total)}\n${compteLigne}\nAdresse de livraison : ${adresse || "non renseignée"}\n\nDernier message : "${userMessage}"\n\nSi reçu :\n/paiement_recu ${from} <montant>\n(les différents produits et quantités du panier seront repris automatiquement)\n\nSi non reçu :\n/paiement_refuse ${from} [raison]`,
    });
  } catch (err) {
    log.error("Impossible de transmettre la vérification de paiement au collaborateur", { from, error: err?.message || String(err) });
    await sendWhatsappMessage(from, "Votre demande est bien enregistrée. Je rencontre toutefois un problème pour joindre le collaborateur chargé de vérifier le paiement.");
  }
}

export function isAwaitingPaymentAccountInfo(from) {
  return Boolean(getState(from).awaitingPaymentAccountInfo);
}

// Détection oui/non déterministe — partagée par tous les court-circuits
// d'état d'attente pour éviter de passer par Groq sur des réponses binaires.
const POSITIVE_RESPONSES = ["oui", "c'est ça", "c'est bien ça", "oui c'est ça", "oui c'est bien ça", "yes", "c'est bon", "c'est exact", "exactement", "je l'ai fait", "c'est fait", "c'est ok", "ok", "d'accord", "affirmatif", "yep", "bien sûr", "tout à fait"];
const NEGATIVE_RESPONSES = ["non", "no", "nope", "pas du tout", "négatif", "jamais", "nan"];
export function isPositiveResponse(text) {
  const t = String(text || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return POSITIVE_RESPONSES.some(w => {
    const wn = w.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return t === wn || t.startsWith(wn + " ") || t.endsWith(" " + wn);
  });
}
export function isNegativeResponse(text) {
  const t = String(text || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return NEGATIVE_RESPONSES.some(w => {
    const wn = w.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return t === wn || t.startsWith(wn + " ") || t.endsWith(" " + wn);
  });
}

export function getAwaitingState(from) {
  const s = getState(from);
  return {
    awaitingDeliveryAddress:          Boolean(s.awaitingDeliveryAddress),
    awaitingPaymentAccountInfo:       Boolean(s.awaitingPaymentAccountInfo),
    awaitingCartAbandonConfirmation:  Boolean(s.awaitingCartAbandonConfirmation),
    awaitingDeliveryConfirmation:     Boolean(s.awaitingDeliveryConfirmation),
    awaitingClientName:               Boolean(s.awaitingClientName),
  };
}

export async function cancelPaymentAccountInfoRequest(from) {
  const state = getState(from);
  state.awaitingPaymentAccountInfo = null;
  await persistState(from, state);
}

export async function provideMobileMoneyAccountInfo(from, userMessage) {
  const state = getState(from);
  const awaiting = state.awaitingPaymentAccountInfo;
  
  log.info("provideMobileMoneyAccountInfo appelé", { from, hasAwaiting: Boolean(awaiting), userMessage });
  
  if (!awaiting) {
    log.warn("provideMobileMoneyAccountInfo: aucun état d'attente", { from });
    return false;
  }

  const { compteMobileMoney, numeroCompteMobileMoney } = extractPaymentInfo(userMessage);
  const originalMessage = awaiting.originalMessage || userMessage;

  const isConfirmed = isPositiveResponse(userMessage);

  log.info("Vérification confirmation", { from, userResponse: userMessage, isConfirmed, numeroCompteMobileMoney });

  if (isConfirmed && !numeroCompteMobileMoney) {
    const numeroWhatsApp = from;
    log.info("Confirmation détectée, utilisation du numéro WhatsApp", { from, numeroWhatsApp });
    state.awaitingPaymentAccountInfo = null;
    await persistState(from, state);
    await escalatePaymentVerification(from, originalMessage, {
      compteMobileMoney: compteMobileMoney || "NOM NON FOURNI",
      numeroCompteMobileMoney: numeroWhatsApp,
    });
    return true;
  }

  if (!numeroCompteMobileMoney) {
    if (awaiting.attempts >= 1) {
      log.info("Deuxième tentative sans numéro, escalade quand même", { from });
      state.awaitingPaymentAccountInfo = null;
      await persistState(from, state);
      await escalatePaymentVerification(from, originalMessage, {
        compteMobileMoney,
        numeroCompteMobileMoney: "NON COMMUNIQUÉ",
      });
      return true;
    }
    state.awaitingPaymentAccountInfo = { originalMessage, attempts: (awaiting.attempts || 0) + 1, timestamp: Date.now() };
    await persistState(from, state);
    log.info("Numéro non trouvé, demande à nouveau", { from, attempts: state.awaitingPaymentAccountInfo.attempts });
    await sendWhatsappMessage(
      from,
      "Je n'ai pas trouvé de numéro. Pouvez-vous m'envoyer le numéro du compte Mobile Money qui a servi à payer, au format 6XXXXXXXX (et le nom du compte si possible) ?"
    );
    return true;
  }

  log.info("Numéro trouvé, escalade", { from, numeroCompteMobileMoney });
  state.awaitingPaymentAccountInfo = null;
  await persistState(from, state);
  await escalatePaymentVerification(from, originalMessage, { compteMobileMoney, numeroCompteMobileMoney });
  return true;
}

export async function requestPaymentConfirmation(from, userMessage) {
  const guardState = getState(from);
  if (!getCart(from).length && !guardState.pendingPayment) {
    log.warn("Signalement de paiement ignoré : aucun panier ni vérification en cours pour ce client", { from, userMessage });
    await sendWhatsappMessage(
      from,
      "Je ne trouve pas de commande en attente de paiement pour vous en ce moment 🙏 Si vous voulez passer une commande ou avez une autre question, je suis là !"
    );
    return;
  }

  const { compteMobileMoney, numeroCompteMobileMoney } = extractPaymentInfo(userMessage);

  if (!numeroCompteMobileMoney) {
    const state = getState(from);
    state.awaitingPaymentAccountInfo = { originalMessage: userMessage, attempts: 0, timestamp: Date.now() };
    await persistState(from, state);
    
    const whatsappNumber = from.replace(/^237/, '');
    
    await sendWhatsappMessage(
      from,
      `Merci 🙏 Pour vérifier votre paiement, est-ce que c'est le numéro *${whatsappNumber}* que vous avez utilisé ?`
    );
    return;
  }

  await escalatePaymentVerification(from, userMessage, { compteMobileMoney, numeroCompteMobileMoney });
}

export async function confirmPayment(from, montant, produitsDescription, numeroCompteMobile) {
  const state = getState(from);

  const compte = String(numeroCompteMobile || "").trim();
  if (!/^237[0-9]{9}$/.test(compte)) {
    throw new Error("Le numéro du compte Mobile Money ayant reçu le paiement est obligatoire avant de créer la commande. Indiquez-le au format 237XXXXXXXXX.");
  }

  state.pendingPayment = null;
  await closeEscalationLog(from).catch(() => {});

  const client = await clientsStore.getClient(from);
  const selections = normalizeSelections(state.selections);
  const produits = produitsDescription || (selections.length ? describeSelections(selections) : null);
  const totalSelection = selections.reduce((sum, item) => sum + (Number(item.total) || 0), 0);
  const montantFinal = Number(montant) || totalSelection;
  const montantMismatch = Boolean(
    selections.length && totalSelection > 0 && Number.isFinite(Number(montant)) && Number(montant) !== totalSelection
  );
  if (montantMismatch) {
    log.warn("Écart entre montant confirmé et total des produits sélectionnés", { from, montantConfirme: montant, totalSelection });
  }

  if (!produits) {
    await persistState(from, state);
    throw new Error(
      "Aucune description de produits fournie et aucune sélection de quantité en attente pour ce client."
    );
  }

  const commande = await commandesStore.createCommande({
    phone: from,
    nom_client: client?.nom || null,
    produits,
    montant_total: montantFinal,
    compte_mobile_money: compte,
    statut: "paiement_confirme",
  });

  state.selections = [];
  delete carts[from];
  await cartStore.deleteCart(from);
  state.awaitingDelaiCommandeId = commande.id;
  state.awaitingDeliveryConfirmation = null;
  await persistState(from, state);

  log.info("Paiement confirmé, en attente du délai de livraison", {
    from,
    commandeId: commande.id,
    selectionsPersistees: selections.length,
  });

  await sendWhatsappMessage(
    from,
    `✅ Votre paiement de ${formatMontantFcfa(montantFinal)} a bien été reçu et votre commande est confirmée. Je reviens vers vous dans un instant avec le délai de livraison 🙏`
  ).catch((err) => log.error("Échec de la notification de paiement confirmé au client", { from, error: err?.message || String(err) }));

  const adresse = getDeliveryAddress(from);
  const mismatchLigne = montantMismatch
    ? `\n⚠️ Attention : le montant indiqué (${formatMontantFcfa(Number(montant))}) ne correspond pas au total du panier (${formatMontantFcfa(totalSelection)}). Vérifiez avant de continuer.`
    : "";

  await sendToConfiguredHuman(
    `✅ Paiement confirmé pour ${from} (${formatMontantFcfa(montantFinal)}). Escalade clôturée automatiquement.${mismatchLigne}\n\nCommande : ${produits}\nAdresse de livraison : ${adresse || "non renseignée"}\n\nQuel est le délai de livraison ? Répondez simplement (ex: "2 heures", "demain matin"), ou avec /delai ${from} <texte>. Je transmettrai le délai au client et lui enverrai directement sa facture.`,
    from
  );

  return commande;
}

export async function rejectPayment(from, raison) {
  const state = getState(from);
  state.pendingPayment = null;
  await persistState(from, state);
  await closeEscalationLog(from).catch(() => {});

  log.info("Paiement refusé/non trouvé", { from, raison });

  await sendWhatsappMessage(
    from,
    "Nous n'avons pas encore reçu votre paiement de notre côté. Pourriez-vous vérifier et réessayer, ou nous envoyer une capture de la transaction ?"
  );
}

export function getPendingDeliveryClients() {
  return Object.entries(paymentStates)
    .filter(([, state]) => Boolean(state?.awaitingDelaiCommandeId))
    .map(([phone]) => phone);
}

export async function getPendingDeliveryDetails() {
  const entries = Object.entries(paymentStates).filter(([, state]) => Boolean(state?.awaitingDelaiCommandeId));
  const details = await Promise.all(entries.map(async ([phone, state]) => {
    const commande = await commandesStore.getCommande(state.awaitingDelaiCommandeId).catch(() => null);
    return {
      phone,
      commandeId: state.awaitingDelaiCommandeId,
      produits: commande?.produits || null,
      montant: Number(commande?.montant_total) || null,
      compteMobileMoney: commande?.compte_mobile_money || null,
      numeroCompteMobileMoney: commande?.compte_mobile_money || null,
      adresseLivraison: state.deliveryAddress || null,
    };
  }));
  return details;
}

export function findPendingDeliveryClient() {
  const phones = getPendingDeliveryClients();
  return phones.length === 1 ? phones[0] : null;
}

export function isAwaitingDeliveryConfirmation(from) {
  return Boolean(getState(from).awaitingDeliveryConfirmation);
}

export async function confirmDeliveryPhone(from, confirmed) {
  const state = getState(from);
  const pending = state.awaitingDeliveryConfirmation;
  if (!pending) return false;

  if (!confirmed) {
    state.awaitingDeliveryConfirmation = null;
    await persistState(from, state);
    await sendWhatsappMessage(from, "D'accord. Quel est le numéro à utiliser pour la livraison ?");
    return false;
  }

  state.awaitingDeliveryConfirmation = null;
  state.awaitingDelaiCommandeId = null;
  await persistState(from, state);
  return finalizeDelivery(from, pending.commandeId, pending.delaiText);
}

async function finalizeDelivery(from, commandeId, delaiText) {
  log.info("Numéro de livraison confirmé, finalisation de la facture", { from, commandeId, delaiText });
  const adresse = getDeliveryAddress(from);
  try {
    const numeroFacture = generateNumeroFacture();
    const commande = await commandesStore.updateCommande(commandeId, {
      delai_livraison: delaiText,
      statut: "facturee",
      numero_facture: numeroFacture,
    });
    const pdfBuffer = await generateInvoicePdfBuffer({ ...commande, adresse_livraison: adresse });
    await sendWhatsappPdf(from, pdfBuffer, `${numeroFacture}.pdf`, "Voici votre facture. Merci pour votre confiance ! 🙏");
    await sendWhatsappMessage(from, `Votre commande sera livrée sous : ${delaiText}. Merci pour votre confiance ! 🙏`);
    await sendToConfiguredHuman(`📄 Facture ${numeroFacture} envoyée à ${from}. Conversation clôturée.`, from);

    const state = getState(from);
    state.deliveryAddress = null;
    await persistState(from, state);
    return true;
  } catch (err) {
    log.error("Échec finalisation facture", err);
    await sendToConfiguredHuman(`⚠️ Erreur lors de l'envoi de la facture à ${from} — vérifiez les logs.`, from).catch(() => {});
    return false;
  }
}

export async function provideDeliveryDelay(from, delaiText) {
  const state = getState(from);
  const commandeId = state.awaitingDelaiCommandeId;
  if (!commandeId) {
    log.warn("/delai reçu mais aucun paiement confirmé en attente pour ce numéro", { from });
    await sendToConfiguredHuman(`⚠️ Aucun paiement confirmé en attente pour ${from}. Utilisez d'abord /paiement_recu.`, from).catch(() => {});
    return false;
  }
  state.awaitingDeliveryConfirmation = { commandeId, delaiText, phone: from, createdAt: new Date().toISOString() };
  await persistState(from, state);
  log.info("Délai de livraison reçu, confirmation du numéro demandée avant envoi", { from, commandeId, delaiText });
  await sendWhatsappMessage(
    from,
    `Pour votre livraison, je vais utiliser ce numéro WhatsApp : *+${from}*.\nEst-ce bien le bon numéro ? Répondez simplement *Oui* ou *Non*.`
  );
  return true;
}