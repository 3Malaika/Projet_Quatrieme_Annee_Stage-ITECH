import { config } from "../config/env.js";
import { sendWhatsappMessage, sendWhatsappPdf } from "./whatsapp.service.js";
import { formatMontantFcfa } from "./catalogueFormatter.service.js";
import { generateInvoicePdfBuffer, generateNumeroFacture } from "./invoice.service.js";
import { createLogger } from "../utils/logger.js";
import { sendToConfiguredHuman, enqueueEscalation, closeEscalationLog } from "./escalation.service.js";

const log = createLogger("payment");

// Extraction déterministe du nom de compte Mobile Money.
// Cette fonction appartient au service paiement pour éviter une dépendance
// payment.service -> chat.service qui peut créer des problèmes de cycle et
// surtout pour que le service paiement reste autonome au démarrage de Render.
function extractPaymentInfo(userMessage) {
  const text = String(userMessage || "");
  const patterns = [
    /(?:au nom de|nom du compte|compte au nom de)\s*[:=]?\s*([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,80})/i,
    /(?:j['’]ai payé avec|j['’]ai paye avec|payé sur|paye sur)\s*([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return { compteMobileMoney: match[1].trim().replace(/[.!?,;:]+$/, "") };
    }
  }
  return { compteMobileMoney: null };
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
    }
  );
}

export function getPendingPaymentClients() {
  return Object.entries(paymentStates)
    .filter(([, state]) => Boolean(state?.pendingPayment))
    .map(([phone, state]) => ({
      phone,
      ...state.pendingPayment,
    }));
}

// Sauvegarde l'état d'un client. Si l'état redevient "vide" (plus rien en
// attente pour ce client), on le supprime complètement plutôt que de
// garder une ligne/fichier vide indéfiniment.
async function persistState(phone, state) {
  const isEmpty =
    !state.pendingPayment && !state.awaitingDelaiCommandeId && !state.awaitingDeliveryConfirmation && !state.awaitingCartAbandonConfirmation && state.selections.length === 0;

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
export async function requestPaymentConfirmation(from, userMessage) {
  const { compteMobileMoney } = await extractPaymentInfo(userMessage, from);
  const state = getState(from);
  state.pendingPayment = { userMessage, compteMobileMoney, timestamp: Date.now() };
  await persistState(from, state);

  const cart = formatCart(from);
  const total = getCartTotal(from);

  log.info("Demande de confirmation de paiement (en attente du collaborateur)", {
    from, compteMobileMoney, total, lignes: getCart(from).length
  });

  await sendWhatsappMessage(
    from,
    `Merci ! Je vérifie la réception de votre paiement, un instant 🙏\n\n${cart}`
  );

  const compteLigne = compteMobileMoney
    ? `Compte Mobile Money indiqué : ${compteMobileMoney}`
    : "⚠️ Le client n'a pas précisé le nom du compte Mobile Money — vérifiez avec l'historique de la conversation.";

  try {
    await enqueueEscalation(from, userMessage, {
      notifyClient: false,
      agentMessage: `💰 Paiement à vérifier — client ${from}\n\n${cart}\n\nMontant attendu : ${formatMontantFcfa(total)}\n${compteLigne}\n\nDernier message : "${userMessage}"\n\nSi reçu :\n/paiement_recu ${from} <montant>\n(les différents produits et quantités du panier seront repris automatiquement)\n\nSi non reçu :\n/paiement_refuse ${from} [raison]`,
    });
  } catch (err) {
    log.error("Impossible de transmettre la vérification de paiement au collaborateur", { from, error: err?.message || String(err) });
    await sendWhatsappMessage(from, "Votre demande est bien enregistrée. Je rencontre toutefois un problème pour joindre le collaborateur chargé de vérifier le paiement.");
  }
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
  if (selections.length && totalSelection > 0 && Number(montant) !== totalSelection) {
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

  await sendToConfiguredHuman(
    `✅ Paiement confirmé pour ${from} (${montant || montantFinal} FCFA).\n\nIndiquez le délai de livraison avec :\n/delai ${from} <texte>`
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

export function findPendingDeliveryClient() {
  const phones = getPendingDeliveryClients();
  return phones.length === 1 ? phones[0] : null;
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
  try {
    const numeroFacture = generateNumeroFacture();
    const commande = await commandesStore.updateCommande(commandeId, {
      delai_livraison: delaiText,
      statut: "facturee",
      numero_facture: numeroFacture,
    });
    const pdfBuffer = await generateInvoicePdfBuffer(commande);
    await sendWhatsappPdf(from, pdfBuffer, `${numeroFacture}.pdf`, "Voici votre facture. Merci pour votre confiance ! 🙏");
    await sendWhatsappMessage(from, `Votre commande sera livrée sous : ${delaiText}. Merci pour votre confiance ! 🙏`);
    await sendToConfiguredHuman(`📄 Facture ${numeroFacture} envoyée à ${from}. Conversation clôturée.`);
    return true;
  } catch (err) {
    log.error("Échec finalisation facture", err);
    await sendToConfiguredHuman(`⚠️ Erreur lors de l'envoi de la facture à ${from} — vérifiez les logs.`).catch(() => {});
    return false;
  }
}

export async function provideDeliveryDelay(from, delaiText) {
  const state = getState(from);
  const commandeId = state.awaitingDelaiCommandeId;
  if (!commandeId) {
    log.warn("/delai reçu mais aucun paiement confirmé en attente pour ce numéro", { from });
    await sendToConfiguredHuman(`⚠️ Aucun paiement confirmé en attente pour ${from}. Utilisez d'abord /paiement_recu.`).catch(() => {});
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
