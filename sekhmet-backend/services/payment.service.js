import { config } from "../config/env.js";
import { sendWhatsappMessage, sendWhatsappPdf } from "./whatsapp.service.js";
import { formatMontantFcfa } from "./catalogueFormatter.service.js";
import { generateInvoicePdfBuffer, generateNumeroFacture } from "./invoice.service.js";
import { createLogger } from "../utils/logger.js";
import { sendToConfiguredHuman, enqueueEscalation, closeEscalationLog } from "./escalation.service.js";

const log = createLogger("payment");

// Extraction déterministe du nom ET du numéro du compte Mobile Money ayant
// servi au paiement (côté client). Cette fonction appartient au service
// paiement pour éviter une dépendance payment.service -> chat.service qui
// peut créer des problèmes de cycle et surtout pour que le service paiement
// reste autonome au démarrage de Render.
//
// Le numéro est indispensable pour que le collaborateur puisse plus tard
// rattacher sans ambiguïté un paiement reçu (vu depuis son appli Mobile
// Money, qui affiche un nom + un montant) à la bonne conversation cliente
// — surtout lorsque plusieurs clients ont un paiement en attente de
// vérification en même temps (voir matchPendingClient plus bas).
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
  // Formats acceptés : 237XXXXXXXXX, +237XXXXXXXXX, 00237XXXXXXXXX, ou un
  // numéro local à 9 chiffres commençant par 6 (courant au Cameroun) — on
  // reconstitue alors le préfixe 237 pour rester cohérent avec le reste du
  // code qui normalise toujours les numéros au format 237XXXXXXXXX.
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

// Bascule automatique JSON / Supabase, même pattern que le reste du code.
const commandesStore = config.supabaseUrl
  ? await import("../data/commandes.store.supabase.js")
  : await import("../data/commandes.store.js");

const clientsStore = config.supabaseUrl
  ? await import("../data/clients.store.supabase.js")
  : await import("../data/clients.store.js");

// État transitoire du cycle de paiement — PERSISTÉ (fichier JSON local ou
// table Supabase selon le mode actif) pour survivre à un redémarrage du
// serveur. Avant ce correctif, cet état vivait uniquement dans des objets
// JS en mémoire et était perdu à chaque crash/redéploiement, avec le
// risque de "perdre" une commande en cours : un paiement signalé par le
// client mais jamais relancé auprès du collaborateur, une commande payée
// mais jamais relancée pour le délai de livraison, ou une quantité
// choisie par le client jamais rattachée à une commande.
const paymentStateStore = config.supabaseUrl
  ? await import("../data/paymentState.store.supabase.js")
  : await import("../data/paymentState.store.js");

// Panier persistant dédié : le panier n'est plus seulement un champ transitoire du paiement.
// Il possède sa propre table (SQLite `carts` / Supabase `carts`) et reste consultable
// même lorsqu'aucun paiement n'est encore en cours.
const cartStore = config.supabaseUrl
  ? await import("../data/cart.store.supabase.js")
  : await import("../data/cart.store.js");

const carts = await cartStore.loadCarts().catch((err) => {
  log.error("Impossible de charger les paniers persistants", err);
  return {};
});

// Cache mémoire peuplé au démarrage depuis le store persistant, pour ne
// pas relire le disque/la base à chaque message. Chaque mutation est
// néanmoins persistée immédiatement (await) avant de continuer, pour ne
// jamais avoir un état en mémoire plus "avancé" que ce qui est sauvegardé.
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
      // Adresse de livraison texte du client (quartier/ville/repère),
      // demandée une fois avant l'envoi des modalités de paiement puis
      // réutilisée telle quelle pour toute la suite du cycle (vérification
      // du paiement, demande de délai, facture) — voir requestDeliveryAddress
      // / provideDeliveryAddress plus bas.
      deliveryAddress: null,
      awaitingDeliveryAddress: false,
    }
  );
}

// Objets légers exposés au collaborateur (via humanCommands.js) pour lui
// permettre de rattacher un paiement reçu à la bonne conversation à partir
// du nom du payeur et/ou du montant, sans connaître forcément le numéro
// WhatsApp du client. `total` est recalculé ici (plutôt que stocké dans
// pendingPayment) pour toujours refléter le panier actuel du client.
export function getPendingPaymentClients() {
  return Object.entries(paymentStates)
    .filter(([, state]) => Boolean(state?.pendingPayment))
    .map(([phone, state]) => ({
      phone,
      ...state.pendingPayment,
      total: getCartTotal(phone),
    }));
}

// Sauvegarde l'état d'un client. Si l'état redevient "vide" (plus rien en
// attente pour ce client), on le supprime complètement plutôt que de
// garder une ligne/fichier vide indéfiniment.
async function persistState(phone, state) {
  const isEmpty =
    !state.pendingPayment && !state.awaitingDelaiCommandeId && !state.awaitingDeliveryConfirmation && !state.awaitingCartAbandonConfirmation && !state.awaitingPaymentAccountInfo && !state.deliveryAddress && !state.awaitingDeliveryAddress && state.selections.length === 0;

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

/**
 * Appelé depuis webhook.routes.js dès que le client valide une quantité
 * dans la liste interactive envoyée après une recommandation produit.
 * Ne crée encore aucune commande — la sélection est mémorisée ET
 * PERSISTÉE en attendant la confirmation de paiement, pour ne pas être
 * perdue si le serveur redémarre avant que le client paie.
 */
export async function recordProductSelection(from, selection) {
  const state = getState(from);
  const item = { ...selection, timestamp: Date.now() };
  const currentCart = Array.isArray(carts[from]) ? carts[from] : [];
  const merged = [...currentCart, item];
  carts[from] = merged;
  await cartStore.upsertCart(from, merged);
  state.selections = merged;
  await persistState(from, state);
  log.info("Sélection de quantité mémorisée en attente de paiement", { from, selection });
}

export function getPendingSelections(from) {
  return Array.isArray(carts[from]) ? carts[from] : getState(from).selections;
}

// Construit une description texte lisible (pour l'affichage/la facture) à
// partir des sélections structurées, ex: "2 x Savon noir, 1 x Beurre de karité".

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
  return `🛒 *Votre panier*\n\n${lines.join("\n")}\n\n*Total : ${formatMontantFcfa(total)}*`;
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

/**
 * Adresse de livraison texte (quartier / ville / repère) demandée au
 * client AVANT de lui communiquer les modalités de paiement, pour que le
 * collaborateur dispose déjà de cette information dès la vérification du
 * paiement — plutôt que de la découvrir seulement au moment de livrer.
 *
 * Volontairement stockée dans l'état de paiement (persisté) plutôt que sur
 * la commande elle-même : cela évite de dépendre d'une colonne dédiée sur
 * la table des commandes (dont le schéma exact n'est pas garanti ici), et
 * elle reste de toute façon disponible tout au long du cycle paiement ->
 * délai -> facture pour ce client, jusqu'à ce qu'elle soit nettoyée en fin
 * de livraison (voir finalizeDelivery).
 */
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

/**
 * Étape 1 — le client dit avoir payé : on extrait le nom du compte Mobile
 * Money s'il est mentionné, on répond au client par un message neutre (il
 * ne doit jamais savoir qu'un humain est sollicité), et on transmet la
 * demande de vérification au collaborateur. Le bot NE VALIDE RIEN à ce
 * stade : ni commande, ni facture — tout attend une confirmation explicite
 * du collaborateur, qui peut prendre son temps (il vérifie peut-être
 * plusieurs paiements en parallèle). Cette demande en attente est
 * persistée : si le serveur redémarre avant la confirmation, elle n'est
 * pas perdue silencieusement (consultable via getPendingSelections /
 * l'état persistant, et le message envoyé au collaborateur suffit pour
 * relancer manuellement /paiement_recu de toute façon).
 */
/**
 * Étape 1 (suite) — une fois qu'on dispose au minimum du NUMÉRO du compte
 * Mobile Money ayant servi au paiement (le nom est un plus mais ne suffit
 * jamais seul : plusieurs clients peuvent partager un même nom, très peu
 * partagent un même numéro), on notifie le client et on transmet la
 * vérification au collaborateur. C'est ce couple numéro+nom, avec le
 * montant du panier, qui permettra ensuite à handleHumanCommand /
 * matchPendingClient de rattacher sans ambiguïté la confirmation du
 * collaborateur à cette conversation même si plusieurs paiements sont en
 * vérification en parallèle.
 */
async function escalatePaymentVerification(from, userMessage, { compteMobileMoney, numeroCompteMobileMoney }) {
  const state = getState(from);
  state.awaitingPaymentAccountInfo = null;
  state.pendingPayment = { userMessage, compteMobileMoney, numeroCompteMobileMoney, timestamp: Date.now() };
  await persistState(from, state);

  const cart = formatCart(from);
  const total = getCartTotal(from);
  // Nom du client (s'il est déjà connu) et adresse de livraison (demandée
  // avant l'envoi des modalités de paiement, voir requestDeliveryAddress) :
  // toutes deux transmises au collaborateur pour qu'il ait un dossier
  // complet dès la demande de vérification, sans avoir à les redemander.
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

  // Le numéro du compte Mobile Money ayant payé est la clé UNIQUE (au
  // Cameroun) qui permet de rattacher sans ambiguïté une confirmation du
  // collaborateur à cette conversation, même quand plusieurs paiements sont
  // en vérification en même temps — voir matchPendingClient dans
  // humanCommands.js. Le nom déclaré par le client n'est qu'un complément
  // pratique pour que le collaborateur puisse s'y référer en langage
  // naturel ; il ne remplace jamais le numéro.
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

export function getAwaitingState(from) {
  const s = getState(from);
  return {
    awaitingDeliveryAddress:          Boolean(s.awaitingDeliveryAddress),
    awaitingPaymentAccountInfo:       Boolean(s.awaitingPaymentAccountInfo),
    awaitingCartAbandonConfirmation:  Boolean(s.awaitingCartAbandonConfirmation),
    awaitingDeliveryConfirmation:     Boolean(s.awaitingDeliveryConfirmation),
  };
}

export async function cancelPaymentAccountInfoRequest(from) {
  const state = getState(from);
  state.awaitingPaymentAccountInfo = null;
  await persistState(from, state);
}

/**
 * Le client a répondu à notre relance lui demandant le numéro (et
 * idéalement le nom) du compte Mobile Money utilisé pour payer. Si le
 * numéro est toujours introuvable dans sa réponse, on relance une seule
 * fois avec un message plus directif avant d'escalader quand même (pour ne
 * jamais bloquer indéfiniment un client de bonne foi qui ne sait pas
 * formuler la demande).
 */
export async function provideMobileMoneyAccountInfo(from, userMessage) {
  const state = getState(from);
  const awaiting = state.awaitingPaymentAccountInfo;
  if (!awaiting) return false;

  const { compteMobileMoney, numeroCompteMobileMoney } = extractPaymentInfo(userMessage);
  const originalMessage = awaiting.originalMessage || userMessage;

  if (!numeroCompteMobileMoney) {
    if (awaiting.attempts >= 1) {
      // Deuxième échec : on n'insiste plus, on transmet quand même au
      // collaborateur avec un avertissement explicite plutôt que de
      // laisser le client bloqué sans réponse.
      await escalatePaymentVerification(from, originalMessage, {
        compteMobileMoney,
        numeroCompteMobileMoney: "NON COMMUNIQUÉ",
      });
      return true;
    }
    state.awaitingPaymentAccountInfo = { originalMessage, attempts: (awaiting.attempts || 0) + 1, timestamp: Date.now() };
    await persistState(from, state);
    await sendWhatsappMessage(
      from,
      "Je n'ai pas trouvé de numéro. Pouvez-vous m'envoyer le numéro du compte Mobile Money qui a servi à payer, au format 6XXXXXXXX (et le nom du compte si possible) ?"
    );
    return true;
  }

  await escalatePaymentVerification(from, originalMessage, { compteMobileMoney, numeroCompteMobileMoney });
  return true;
}

/**
 * Étape 1 — le client dit avoir payé. Avant de déranger le collaborateur,
 * on vérifie que le NUMÉRO du compte Mobile Money ayant servi au paiement
 * est identifiable dans son message (le nom seul ne permet pas de
 * distinguer deux clients de manière fiable). S'il manque, on le demande
 * au client — sans encore rien transmettre au collaborateur — plutôt que
 * d'escalader une vérification incomplète comme c'était le cas
 * auparavant. Le bot ne valide toujours rien à ce stade : ni commande, ni
 * facture — tout attend une confirmation explicite du collaborateur.
 */
export async function requestPaymentConfirmation(from, userMessage) {
  const { compteMobileMoney, numeroCompteMobileMoney } = extractPaymentInfo(userMessage);

  if (!numeroCompteMobileMoney) {
    const state = getState(from);
    state.awaitingPaymentAccountInfo = { originalMessage: userMessage, attempts: 0, timestamp: Date.now() };
    await persistState(from, state);
    await sendWhatsappMessage(
      from,
      "Merci ! Pour vérifier rapidement votre paiement, pouvez-vous me communiquer le numéro du compte Mobile Money que vous avez utilisé (et le nom sur ce compte, s'il est différent du vôtre) ?"
    );
    return;
  }

  await escalatePaymentVerification(from, userMessage, { compteMobileMoney, numeroCompteMobileMoney });
}

/**
 * Étape 2 — le collaborateur confirme EXPLICITEMENT avoir reçu le paiement
 * (commande /paiement_recu) : seulement à ce moment la commande existe.
 * On lui demande ensuite le délai de livraison, en exigeant qu'il précise
 * le numéro du client dans sa réponse (/delai <numero> <texte>) — comme
 * plusieurs paiements peuvent être en cours de vérification en même temps,
 * une réponse en texte libre sans numéro serait ambiguë.
 *
 * `produitsDescription` est OPTIONNEL : si le collaborateur ne la précise
 * pas, on la reconstruit automatiquement à partir des choix de quantité
 * que le client a validés dans les listes interactives WhatsApp (voir
 * recordProductSelection). Ces choix structurés (produit_id, quantité,
 * prix) sont eux-mêmes persistés tels quels dans la commande via le champ
 * `produits`, pour enregistrer la description lisible de la commande sans dépendre
 * d'une colonne produits_detail absente du schéma Supabase réel.
 */
export async function confirmPayment(from, montant, produitsDescription, numeroCompteMobile) {
  const state = getState(from);

  // Le numéro du compte Mobile Money ayant reçu le paiement est obligatoire
  // avant de créer la commande. Le nom du client ne remplace jamais ce numéro.
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
  // Le bot peut détecter par lui-même un écart entre la somme annoncée
  // reçue et le total réel du panier — sans attendre que le collaborateur
  // s'en rende compte. On ne bloque pas la confirmation (le collaborateur a
  // vérifié son appli Mobile Money, source de vérité), mais on le signale
  // clairement dans le message renvoyé plutôt que dans les seuls logs.
  const montantMismatch = Boolean(
    selections.length && totalSelection > 0 && Number.isFinite(Number(montant)) && Number(montant) !== totalSelection
  );
  if (montantMismatch) {
    log.warn("Écart entre montant confirmé et total des produits sélectionnés", { from, montantConfirme: montant, totalSelection });
  }

  if (!produits) {
    // On persiste quand même la levée du pendingPayment avant de sortir en
    // erreur, pour ne pas laisser une demande de vérification "fantôme".
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

  // Le client n'était jusqu'ici jamais notifié à cette étape : il ne
  // recevait un message que plus tard, au moment du /delai (facture PDF).
  // S'il ne recevait pas de réponse rapide après avoir signalé son
  // paiement, rien ne lui confirmait que le collaborateur l'avait bien
  // validé de son côté.
  await sendWhatsappMessage(
    from,
    `✅ Votre paiement de ${formatMontantFcfa(montantFinal)} a bien été reçu et votre commande est confirmée. Je reviens vers vous dans un instant avec le délai de livraison 🙏`
  ).catch((err) => log.error("Échec de la notification de paiement confirmé au client", { from, error: err?.message || String(err) }));

  // Récapitulatif complet renvoyé au collaborateur avant de lui demander le
  // délai : commande (contenu), adresse de livraison, et l'alerte d'écart
  // de montant si le bot en a détecté un — tout ce dont il a besoin pour
  // valider en un coup d'œil avant de répondre au client.
  const adresse = getDeliveryAddress(from);
  const mismatchLigne = montantMismatch
    ? `\n⚠️ Attention : le montant indiqué (${formatMontantFcfa(Number(montant))}) ne correspond pas au total du panier (${formatMontantFcfa(totalSelection)}). Vérifiez avant de continuer.`
    : "";

  await sendToConfiguredHuman(
    `✅ Paiement confirmé pour ${from} (${formatMontantFcfa(montantFinal)}).${mismatchLigne}\n\nCommande : ${produits}\nAdresse de livraison : ${adresse || "non renseignée"}\n\nIndiquez le délai de livraison avec :\n/delai ${from} <texte>`,
    from
  );

  return commande;
}

/**
 * Le collaborateur indique que le paiement n'a PAS été reçu : le bot
 * l'annonce au client, aucune commande n'est créée, aucune facture n'est
 * générée.
 */
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

/**
 * Étape 3 — le collaborateur indique le délai de livraison pour UN client
 * précis (/delai <numero> <texte>) : on finalise la commande, génère la
 * facture PDF et l'envoie directement au client sur WhatsApp, avec le délai
 * annoncé, puis on clôture.
 */
export function getPendingDeliveryClients() {
  return Object.entries(paymentStates)
    .filter(([, state]) => Boolean(state?.awaitingDelaiCommandeId))
    .map(([phone]) => phone);
}

// Version détaillée pour l'interprétation en langage naturel du
// collaborateur : quand celui-ci annonce un délai sans préciser de numéro
// (« peut-être 1 heure »), il faut pouvoir le confronter au(x) commande(s)
// réellement en attente d'un délai — produits, montant, compte Mobile
// Money ayant payé — plutôt que de deviner. Voir matchPendingDeliveryClient
// dans humanCommands.js.
export async function getPendingDeliveryDetails() {
  const entries = Object.entries(paymentStates).filter(([, state]) => Boolean(state?.awaitingDelaiCommandeId));
  const details = await Promise.all(entries.map(async ([phone, state]) => {
    const commande = await commandesStore.getCommande(state.awaitingDelaiCommandeId).catch(() => null);
    return {
      phone,
      commandeId: state.awaitingDelaiCommandeId,
      produits: commande?.produits || null,
      montant: Number(commande?.montant_total) || null,
      // Nom conservé pour compat (voir humanCommands.js) — malgré son nom,
      // ce champ contient en réalité le NUMÉRO du compte Mobile Money ayant
      // payé (compte_mobile_money), pas un nom.
      compteMobileMoney: commande?.compte_mobile_money || null,
      // Alias explicite : c'est la clé unique (numéro de compte Mobile
      // Money, unique au Cameroun) permettant de rattacher sans ambiguïté
      // une réponse du collaborateur à CETTE commande, même quand
      // plusieurs livraisons attendent un délai en même temps.
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
  // Lue avant toute chose : c'est le dernier point du cycle où l'adresse
  // (mémorisée depuis la demande de paiement) est encore utile — elle est
  // nettoyée de l'état juste après, une fois la facture envoyée.
  const adresse = getDeliveryAddress(from);
  try {
    const numeroFacture = generateNumeroFacture();
    const commande = await commandesStore.updateCommande(commandeId, {
      delai_livraison: delaiText,
      statut: "facturee",
      numero_facture: numeroFacture,
    });
    // adresse_livraison n'est ajoutée qu'à l'objet transmis au générateur de
    // PDF (voir invoice.service.js), pas persistée sur la commande — on
    // évite ainsi de dépendre d'une colonne dédiée dont l'existence n'est
    // pas garantie sur la table des commandes.
    const pdfBuffer = await generateInvoicePdfBuffer({ ...commande, adresse_livraison: adresse });
    await sendWhatsappPdf(from, pdfBuffer, `${numeroFacture}.pdf`, "Voici votre facture. Merci pour votre confiance ! 🙏");
    await sendWhatsappMessage(from, `Votre commande sera livrée sous : ${delaiText}. Merci pour votre confiance ! 🙏`);
    await sendToConfiguredHuman(`📄 Facture ${numeroFacture} envoyée à ${from}. Conversation clôturée.`, from);

    // Nettoyage final de l'état transitoire de ce client — l'adresse a
    // rempli son rôle jusqu'ici (escalade, demande de délai, facture) et
    // n'a plus lieu d'être conservée une fois la commande livrée/facturée.
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