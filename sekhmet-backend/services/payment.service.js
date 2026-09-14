import { config } from "../config/env.js";
import { sendWhatsappMessage, sendWhatsappPdf } from "./whatsapp.service.js";
import { formatMontantFcfa } from "./catalogueFormatter.service.js";
import { generateInvoicePdfBuffer, generateNumeroFacture } from "./invoice.service.js";
import { createLogger } from "../utils/logger.js";
import { sendToConfiguredHuman, enqueueEscalation, closeEscalationLog } from "./escalation.service.js";

const log = createLogger("payment");

// ---------------------------------------------------------------------------
// Garde-fous anti-anomalie (correctif)
// ---------------------------------------------------------------------------
// Un panier alimenté par des appels répétés de "ajout_panier" (ex: à cause
// d'une confirmation mal interprétée par le LLM) peut en théorie accumuler
// une quantité déraisonnable pour un même produit. MAX_ITEM_QUANTITY plafonne
// cette dérive à la source. SUSPICIOUS_TOTAL_THRESHOLD_FCFA ne bloque rien
// mais force une alerte visible pour le collaborateur avant qu'un paiement
// ne soit confirmé sur un montant qui n'a manifestement aucun sens pour une
// commande de ce type de boutique.
const MAX_ITEM_QUANTITY = 50;
const SUSPICIOUS_TOTAL_THRESHOLD_FCFA = 2_000_000;

// Durée au-delà de laquelle un panier non payé est considéré abandonné et
// purgé automatiquement (règle métier : "après 24h sans paiement, le panier
// se vide"). Le panier n'est PAS purgé si une vérification de paiement est
// déjà en cours (state.pendingPayment) : le client a déjà signalé avoir payé
// et attend un collaborateur, sa commande ne doit pas disparaître pendant ce
// délai même s'il dépasse 24h.
const CART_EXPIRY_MS = 24 * 60 * 60 * 1000;
const CART_EXPIRY_SWEEP_MS = 60 * 60 * 1000;

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
      // Mode de logistique choisi par le client avant l'adresse : détermine
      // si une adresse (livraison/expédition) ou un moment de passage
      // (retrait en boutique) est requis. null = pas encore choisi.
      deliveryMode: null,
      awaitingDeliveryMode: false,
      pickupMoment: null,
      awaitingPickupMoment: false,
    }
  );
}

// ---------------------------------------------------------------------------
// Purge automatique des paniers abandonnés depuis plus de 24h (correctif)
// ---------------------------------------------------------------------------
function isExpiredCartItem(item) {
  const ts = Number(item?.timestamp) || 0;
  return ts > 0 && Date.now() - ts > CART_EXPIRY_MS;
}

// Filtre en mémoire les articles > 24h d'un panier et persiste le résultat en
// tâche de fond (sans bloquer les appelants synchrones de getCart/getCartTotal
// utilisés partout dans ce fichier et dans l'admin). Ne purge jamais un
// panier pendant qu'une vérification de paiement est en cours.
function pruneExpiredCartItemsSync(from) {
  const state = getState(from);
  if (state.pendingPayment) {
    return Array.isArray(carts[from]) ? carts[from] : [];
  }

  const raw = Array.isArray(carts[from]) ? carts[from] : [];
  if (!raw.length) return raw;

  const fresh = raw.filter((item) => !isExpiredCartItem(item));
  if (fresh.length === raw.length) return raw;

  carts[from] = fresh;
  cartStore.upsertCart(from, fresh).catch((err) =>
    log.error("Erreur lors de la sauvegarde du panier après purge (24h)", { from, error: err?.message || String(err) })
  );
  state.selections = fresh;
  persistState(from, state).catch(() => {});
  log.info("Articles de panier expirés (>24h sans paiement) retirés automatiquement", {
    from,
    retires: raw.length - fresh.length,
    restants: fresh.length,
  });
  return fresh;
}

// Balayage périodique de tous les paniers, pour que les vues admin
// (getAllActiveCarts, getPendingPaymentClients) restent à jour même sans
// interaction récente d'un client précis (getCart() ne serait alors pas
// appelée pour lui entre deux visites).
const cartExpirySweepInterval = setInterval(() => {
  for (const phone of Object.keys(carts)) {
    pruneExpiredCartItemsSync(phone);
  }
}, CART_EXPIRY_SWEEP_MS);
cartExpirySweepInterval.unref?.();

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
    !state.pendingPayment && !state.awaitingDelaiCommandeId && !state.awaitingDeliveryConfirmation && !state.awaitingCartAbandonConfirmation && !state.awaitingPaymentAccountInfo && !state.deliveryAddress && !state.awaitingDeliveryAddress && !state.awaitingClientName && state.selections.length === 0 && !state.deliveryMode && !state.awaitingDeliveryMode && !state.pickupMoment && !state.awaitingPickupMoment && !state.pendingPaymentMessageAfterAddress;

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
  //
  // CORRECTIF : comparaison désormais faite via String() des deux côtés.
  // L'ancienne comparaison stricte (===) pouvait échouer silencieusement si
  // produitId était une chaîne d'un côté et un nombre de l'autre (selon la
  // source : catalogue local vs Supabase, ou sérialisation JSON), créant une
  // ligne en double au lieu de fusionner — une des causes probables des
  // totaux/quantités incohérents observés.
  const produitIdKey = (v) => (v === undefined || v === null ? null : String(v));
  const itemKey = produitIdKey(item.produitId);
  const existingIndex = itemKey === null
    ? -1
    : currentCart.findIndex((i) => produitIdKey(i.produitId) === itemKey);

  let merged;
  if (existingIndex >= 0) {
    const existing = currentCart[existingIndex];
    let newQte = (existing.quantite || 0) + (item.quantite || 0);

    // CORRECTIF : plafond de sécurité. Si un bug de routage (ou toute autre
    // cause) fait s'accumuler une quantité manifestement déraisonnable pour
    // une boutique de ce type, on la plafonne au lieu de la laisser dériver
    // indéfiniment et fausser le total.
    if (newQte > MAX_ITEM_QUANTITY) {
      log.warn("Quantité anormalement élevée détectée pour un produit du panier, plafonnée", {
        from,
        produitId: item.produitId,
        quantiteCalculee: newQte,
        plafond: MAX_ITEM_QUANTITY,
      });
      newQte = MAX_ITEM_QUANTITY;
    }

    const newTotal = item.prixUnitaire ? item.prixUnitaire * newQte : null;
    merged = [
      ...currentCart.slice(0, existingIndex),
      { ...existing, quantite: newQte, total: newTotal, timestamp: Date.now() },
      ...currentCart.slice(existingIndex + 1),
    ];
    log.info("Quantité cumulée pour produit déjà au panier", { from, produitId: item.produitId, newQte });
  } else {
    const quantiteBrute = Number(item.quantite) || 0;
    const quantiteClampee = Math.min(quantiteBrute, MAX_ITEM_QUANTITY);
    if (quantiteClampee !== quantiteBrute) {
      log.warn("Quantité anormalement élevée détectée à l'ajout d'un nouveau produit, plafonnée", {
        from,
        produitId: item.produitId,
        quantiteDemandee: quantiteBrute,
        plafond: MAX_ITEM_QUANTITY,
      });
    }
    const total = item.prixUnitaire ? item.prixUnitaire * quantiteClampee : item.total;
    merged = [...currentCart, { ...item, quantite: quantiteClampee, total }];
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
  const raw = pruneExpiredCartItemsSync(from);
  return normalizeSelections(raw.length ? raw : getState(from).selections);
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
      // S'assure que les articles > 24h sont retirés avant l'affichage
      // admin, même si getCart() n'a pas été appelée récemment pour ce
      // client (state est la même référence que paymentStates[phone], donc
      // la purge ci-dessous met bien à jour state.selections avant lecture).
      pruneExpiredCartItemsSync(phone);
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

// Appelée lors de la suppression d'un client (voir clients.routes.js), pour
// une suppression EN CASCADE : le panier et l'état de paiement en cours
// (sélections, paiement en attente de vérification, adresse de livraison...)
// ne doivent pas survivre à la suppression de la fiche client. Sans ça, un
// numéro réutilisé plus tard (nouveau client, correction d'une faute de
// frappe précédente, etc.) hériterait silencieusement d'un panier ou d'un
// paiement en attente qui ne lui appartient pas. Contrairement à clearCart
// ci-dessus, on supprime réellement l'entrée (pas de persistState avec un
// état vide) : plus aucune trace ne doit rester, ni en mémoire ni en base.
export async function deleteAllClientPaymentData(from) {
  delete carts[from];
  delete paymentStates[from];
  await Promise.all([
    cartStore.deleteCart(from).catch((err) => log.error("Erreur suppression panier (cascade client)", { from, err })),
    paymentStateStore.deletePaymentState(from).catch((err) => log.error("Erreur suppression état de paiement (cascade client)", { from, err })),
  ]);
}

// Même garde-fou que côté chat.service.js (ajout au panier) : une ligne de
// panier déjà persistée AVANT ce correctif peut contenir un prix corrompu
// (donnée catalogue invalide). On l'écarte à la lecture plutôt que
// d'afficher indéfiniment un total délirant à la cliente tant que le panier
// n'est pas vidé manuellement. Complémentaire à MAX_ITEM_QUANTITY /
// SUSPICIOUS_TOTAL_THRESHOLD_FCFA plus haut : ceux-ci plafonnent une
// quantité/un total déjà valides, celui-ci écarte un prix UNITAIRE aberrant.
const PRIX_UNITAIRE_MAX_RAISONNABLE = 500_000;

function normalizeSelections(selections) {
  const byProduct = new Map();
  for (const raw of Array.isArray(selections) ? selections : []) {
    const key = String(raw.produitId ?? raw.nom ?? "produit");
    const qty = Number(raw.quantite) || 0;
    const unit = Number(raw.prixUnitaire ?? raw.prix ?? 0) || 0;
    if (!qty) continue;
    if (!Number.isFinite(unit) || unit <= 0 || unit > PRIX_UNITAIRE_MAX_RAISONNABLE) {
      log.error("Ligne de panier écartée à la lecture — prix aberrant détecté", { nom: raw.nom, prixUnitaire: unit });
      continue;
    }
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
  // S'il y avait un signalement de paiement en attente uniquement parce
  // que l'adresse manquait (voir requestPaymentConfirmation), on le
  // reprend automatiquement maintenant que l'adresse est connue — sans ça,
  // le client resterait bloqué : son "j'ai payé" initial ne serait jamais
  // traité, et le collaborateur ne verrait jamais l'escalade.
  const resumeMessage = state.pendingPaymentMessageAfterAddress || null;
  state.pendingPaymentMessageAfterAddress = null;
  await persistState(from, state);
  log.info("Adresse de livraison enregistrée", { from, adresse: trimmed });
  if (resumeMessage) {
    log.info("Reprise de la vérification de paiement après réception de l'adresse", { from });
    await requestPaymentConfirmation(from, resumeMessage);
  }
  return true;
}

// --- Mode de logistique (livraison / expédition / retrait en boutique) ---
//
// Demandé UNE SEULE FOIS, avant l'adresse, en texte libre — traitement
// déterministe côté webhook (mots-clés, pas de Groq, pas de liste
// interactive), cohérent avec la volonté de réduire les erreurs de
// sélection d'outil et de laisser le client répondre naturellement. Selon
// le choix :
//   - "livraison"  ou "expedition" -> une adresse de livraison est requise
//     (l'adresse d'expédition est une adresse d'agence de voyage, mais
//     techniquement stockée dans le même champ deliveryAddress). C'est la
//     SEULE raison pour laquelle une adresse est demandée au client.
//   - "retrait_boutique" -> AUCUNE adresse n'est requise ; à la place, on
//     demande le moment auquel le client passera récupérer sa commande.
const DELIVERY_MODES = ["livraison", "expedition", "retrait_boutique"];

const DELIVERY_MODE_QUESTION =
  "Avant de continuer, comment souhaitez-vous recevoir votre commande ?\n" +
  "- *Livraison à domicile* (vous êtes à Yaoundé)\n" +
  "- *Expédition* si vous êtes hors de Yaoundé (envoi via agence de voyage)\n" +
  "- *Retrait en boutique* si vous passez chercher votre commande vous-même\n\n" +
  "Répondez simplement, par exemple : \"livraison\", \"expédition\", ou \"je passe la récupérer\".";

// Classification par mots-clés, volontairement simple et sans Groq : ces
// trois options sont mutuellement exclusives et se reconnaissent sans
// ambiguïté dans l'immense majorité des formulations naturelles. Éviter un
// appel LLM ici réduit à la fois la latence, le coût, et un risque
// d'erreur de routage sur une décision qui n'a pas besoin d'un LLM.
function detectDeliveryModeFromText(text) {
  const t = normalizeTextForMatchLocal(text);
  const retraitKeys = ["retrait", "passer chercher", "passe chercher", "recuperer moi", "recuperer moi-meme", "boutique", "sur place", "magasin", "chez vous", "je viens", "je passe"];
  const expeditionKeys = ["expedition", "agence de voyage", "agence voyage", "hors yaounde", "voyage", "bus", "car "];
  const livraisonKeys = ["livraison", "livrer", "domicile", "a la maison", "chez moi"];

  if (retraitKeys.some((k) => t.includes(k))) return "retrait_boutique";
  if (expeditionKeys.some((k) => t.includes(k))) return "expedition";
  if (livraisonKeys.some((k) => t.includes(k))) return "livraison";
  return null;
}

function normalizeTextForMatchLocal(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function getDeliveryMode(from) {
  return getState(from).deliveryMode || null;
}
export function hasDeliveryMode(from) {
  return Boolean(getState(from).deliveryMode);
}
export function isAwaitingDeliveryMode(from) {
  return Boolean(getState(from).awaitingDeliveryMode);
}

export async function requestDeliveryMode(from) {
  const state = getState(from);
  state.awaitingDeliveryMode = true;
  await persistState(from, state);
  log.info("Mode de logistique demandé (livraison/expédition/retrait boutique)", { from });
  await sendWhatsappMessage(from, DELIVERY_MODE_QUESTION);
}

export async function provideDeliveryMode(from, mode) {
  if (!DELIVERY_MODES.includes(mode)) return false;
  const state = getState(from);
  state.deliveryMode = mode;
  state.awaitingDeliveryMode = false;
  await persistState(from, state);
  log.info("Mode de logistique enregistré", { from, mode });
  return true;
}

// Point d'entrée pour une réponse en texte libre du client à la question du
// mode de logistique (remplace la liste interactive). Retourne true si le
// mode a été reconnu et enregistré, false si la réponse était ambiguë (dans
// ce cas, une reformulation de la question est renvoyée directement au
// client, sans faire deviner l'intention par un LLM).
export async function provideDeliveryModeFromText(from, text) {
  const mode = detectDeliveryModeFromText(text);
  if (!mode) {
    log.info("Réponse au mode de logistique non reconnue — reformulation demandée", { from, texte: text });
    await sendWhatsappMessage(
      from,
      "Je n'ai pas bien compris. " + DELIVERY_MODE_QUESTION
    );
    return false;
  }
  await provideDeliveryMode(from, mode);
  return true;
}

export function hasPickupMoment(from) {
  return Boolean(getState(from).pickupMoment);
}
export function isAwaitingPickupMoment(from) {
  return Boolean(getState(from).awaitingPickupMoment);
}
export function getPickupMoment(from) {
  return getState(from).pickupMoment || null;
}

export async function requestPickupMoment(from) {
  const state = getState(from);
  state.awaitingPickupMoment = true;
  await persistState(from, state);
  log.info("Moment de retrait en boutique demandé", { from });
  await sendWhatsappMessage(
    from,
    "Avant de vous donner les modalités de paiement, à quel moment pensez-vous passer récupérer votre commande en boutique (ex: \"aujourd'hui 17h\", \"demain matin\") ?"
  );
}

export async function providePickupMoment(from, moment) {
  const trimmed = String(moment || "").trim();
  if (!trimmed) return false;
  const state = getState(from);
  state.pickupMoment = trimmed;
  state.awaitingPickupMoment = false;
  const resumeMessage = state.pendingPaymentMessageAfterAddress || null;
  state.pendingPaymentMessageAfterAddress = null;
  await persistState(from, state);
  log.info("Moment de retrait en boutique enregistré", { from, moment: trimmed });
  if (resumeMessage) {
    log.info("Reprise de la vérification de paiement après réception du moment de retrait", { from });
    await requestPaymentConfirmation(from, resumeMessage);
  }
  return true;
}

// Vue d'ensemble utilisée partout où on doit savoir si les informations
// logistiques nécessaires sont complètes, sans se soucier du mode choisi.
export function hasRequiredLogisticsInfo(from) {
  const mode = getDeliveryMode(from);
  if (!mode) return false;
  if (mode === "retrait_boutique") return hasPickupMoment(from);
  return hasDeliveryAddress(from);
}

// Ligne d'affichage prête à l'emploi pour les récapitulatifs envoyés au
// collaborateur (escalade paiement) ou utilisée dans la facture.
export function formatLogisticsLine(from) {
  const mode = getDeliveryMode(from);
  if (mode === "retrait_boutique") {
    const moment = getPickupMoment(from);
    return `Retrait en boutique — moment prévu : ${moment || "non renseigné"}`;
  }
  if (mode === "expedition") {
    const adresse = getDeliveryAddress(from);
    return `Expédition (agence de voyage) — adresse/agence : ${adresse || "non renseignée"}`;
  }
  // "livraison" ou mode encore inconnu (ancien client avant ce correctif)
  const adresse = getDeliveryAddress(from);
  return `Livraison à domicile — adresse : ${adresse || "non renseignée"}`;
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
  const logistiqueLigne = formatLogisticsLine(from);

  // CORRECTIF : alerte visible pour le collaborateur si le montant dépasse
  // un seuil clairement anormal pour ce type de boutique, plutôt que de le
  // laisser confirmer un paiement sur un montant potentiellement corrompu
  // sans le savoir.
  const alerteMontant = total > SUSPICIOUS_TOTAL_THRESHOLD_FCFA
    ? `\n\n🚨 MONTANT ANORMALEMENT ÉLEVÉ (${formatMontantFcfa(total)}) — vérifiez le détail du panier ci-dessus avant de confirmer, il peut s'agir d'une anomalie technique plutôt que d'une vraie commande.`
    : "";

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
      agentMessage: `💰 Paiement à vérifier — conversation ${from}${nomClient ? ` (client : ${nomClient})` : ""}\n\nPanier${nomClient ? ` de ${nomClient}` : ""} :\n${cart}\n\nMontant à recevoir : ${formatMontantFcfa(total)}\n${compteLigne}\n${logistiqueLigne}${alerteMontant}\n\nDernier message : "${userMessage}"\n\nRépondez naturellement dès que vous avez vérifié (reçu ou non reçu, avec le montant si reçu) — je comprends vos messages en langage courant.`,
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
    awaitingDeliveryMode:             Boolean(s.awaitingDeliveryMode),
    awaitingPickupMoment:             Boolean(s.awaitingPickupMoment),
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

  // Garde-fou : ne JAMAIS escalader une confirmation de paiement sans les
  // informations logistiques nécessaires — une adresse pour
  // livraison/expédition, ou un moment de passage pour un retrait en
  // boutique — quel que soit le chemin qui a mené ici (que le client soit
  // passé par "valider" ou qu'il ait dit "j'ai payé" directement, sans
  // jamais avoir choisi de mode ni donné d'adresse). On oriente vers
  // l'étape manquante précise plutôt que de redemander une adresse même
  // quand ce n'en est pas une qui manque (cas du retrait boutique).
  if (!hasRequiredLogisticsInfo(from)) {
    guardState.pendingPaymentMessageAfterAddress = userMessage;
    await persistState(from, guardState);
    if (!hasDeliveryMode(from)) {
      if (!guardState.awaitingDeliveryMode) await requestDeliveryMode(from);
    } else if (guardState.deliveryMode === "retrait_boutique") {
      if (!guardState.awaitingPickupMoment) await requestPickupMoment(from);
    } else {
      if (!guardState.awaitingDeliveryAddress) await requestDeliveryAddress(from);
    }
    // Si l'étape manquante est déjà en attente d'une réponse, on ne la
    // redemande pas une seconde fois : on mémorise simplement ce message
    // pour reprendre automatiquement la vérification de paiement une fois
    // l'information reçue (voir provideDeliveryAddress / providePickupMoment
    // / provideDeliveryMode ci-dessus).
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

  // CORRECTIF : trace explicite si un montant manifestement anormal est sur
  // le point d'être confirmé, pour faciliter l'investigation a posteriori
  // même si la décision finale reste au collaborateur (qui a saisi le
  // montant lui-même via /paiement_recu).
  if (montantFinal > SUSPICIOUS_TOTAL_THRESHOLD_FCFA) {
    log.warn("Montant de commande anormalement élevé sur le point d'être confirmé", { from, montantFinal });
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

  const logistiqueLigne = formatLogisticsLine(from);
  const mismatchLigne = montantMismatch
    ? `\n⚠️ Attention : le montant indiqué (${formatMontantFcfa(Number(montant))}) ne correspond pas au total du panier (${formatMontantFcfa(totalSelection)}). Vérifiez avant de continuer.`
    : "";

  await sendToConfiguredHuman(
    `✅ Paiement confirmé pour ${from} (${formatMontantFcfa(montantFinal)}). Escalade clôturée automatiquement.${mismatchLigne}\n\nCommande : ${produits}\n${logistiqueLigne}\n\nQuel est le délai de livraison ? Répondez simplement (ex: "2 heures", "demain matin"), ou avec /delai ${from} <texte>. Je transmettrai le délai au client et lui enverrai directement sa facture.`,
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
  const mode = getDeliveryMode(from);
  // La facture garde un unique champ "adresse_livraison" (invoice.service.js
  // n'a pas été modifié) : pour un retrait en boutique, on y indique le
  // moment de passage plutôt qu'une adresse inexistante.
  const adresse = mode === "retrait_boutique"
    ? `Retrait en boutique (${getPickupMoment(from) || "moment non renseigné"})`
    : getDeliveryAddress(from);
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