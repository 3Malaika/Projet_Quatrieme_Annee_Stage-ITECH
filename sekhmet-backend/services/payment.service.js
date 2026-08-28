import { config } from "../config/env.js";
import { sendWhatsappMessage, sendWhatsappPdf } from "./whatsapp.service.js";
import { extractPaymentInfo } from "./chat.service.js";
import { generateInvoicePdfBuffer, generateNumeroFacture } from "./invoice.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("payment");

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
      selections: [],
    }
  );
}

// Sauvegarde l'état d'un client. Si l'état redevient "vide" (plus rien en
// attente pour ce client), on le supprime complètement plutôt que de
// garder une ligne/fichier vide indéfiniment.
async function persistState(phone, state) {
  const isEmpty =
    !state.pendingPayment && !state.awaitingDelaiCommandeId && state.selections.length === 0;

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
  state.selections = [...state.selections, { ...selection, timestamp: Date.now() }];
  await persistState(from, state);
  log.info("Sélection de quantité mémorisée en attente de paiement", { from, selection });
}

export function getPendingSelections(from) {
  return getState(from).selections;
}

// Construit une description texte lisible (pour l'affichage/la facture) à
// partir des sélections structurées, ex: "2 x Savon noir, 1 x Beurre de karité".
function describeSelections(selections) {
  return selections.map((s) => `${s.quantite} x ${s.nom}`).join(", ");
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

  log.info("Demande de confirmation de paiement (en attente du collaborateur)", { from, compteMobileMoney });

  await sendWhatsappMessage(
    from,
    "Merci ! Je vérifie la réception de votre paiement, un instant 🙏"
  );

  const compteLigne = compteMobileMoney
    ? `Compte Mobile Money indiqué : ${compteMobileMoney}`
    : "⚠️ Le client n'a pas précisé le nom du compte Mobile Money — vérifiez avec l'historique de la conversation.";

  await sendWhatsappMessage(
    config.humanAgentNumber,
    `💰 Paiement à vérifier — client ${from}\n\n${compteLigne}\n\nDernier message : "${userMessage}"\n\nSi reçu :\n/paiement_recu ${from} <montant> [description des produits]\n(description optionnelle si le client a déjà choisi une quantité via la liste WhatsApp — elle sera reprise automatiquement)\n\nSi non reçu :\n/paiement_refuse ${from} [raison]`
  );
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
 * `produits_detail`, pour ne plus dépendre d'une ressaisie manuelle
 * sujette à erreur.
 */
export async function confirmPayment(from, montant, produitsDescription) {
  const state = getState(from);
  state.pendingPayment = null;

  const client = await clientsStore.getClient(from);
  const selections = state.selections;

  const produits =
    produitsDescription || (selections.length ? describeSelections(selections) : null);

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
    produits_detail: selections.length ? JSON.stringify(selections) : null,
    montant_total: montant,
    statut: "paiement_confirme",
  });

  state.selections = [];
  state.awaitingDelaiCommandeId = commande.id;
  await persistState(from, state);

  log.info("Paiement confirmé, en attente du délai de livraison", {
    from,
    commandeId: commande.id,
    selectionsPersistees: selections.length,
  });

  await sendWhatsappMessage(
    config.humanAgentNumber,
    `✅ Paiement confirmé pour ${from} (${montant} FCFA).\n\nIndiquez le délai de livraison avec :\n/delai ${from} <texte>`
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
export async function provideDeliveryDelay(from, delaiText) {
  const state = getState(from);
  const commandeId = state.awaitingDelaiCommandeId;
  if (!commandeId) {
    log.warn("/delai reçu mais aucun paiement confirmé en attente pour ce numéro", { from });
    await sendWhatsappMessage(
      config.humanAgentNumber,
      `⚠️ Aucun paiement confirmé en attente pour ${from}. Utilisez d'abord /paiement_recu.`
    );
    return false;
  }
  state.awaitingDelaiCommandeId = null;
  await persistState(from, state);

  log.info("Délai de livraison reçu, finalisation de la facture", { from, commandeId, delaiText });

  try {
    const numeroFacture = generateNumeroFacture();
    const commande = await commandesStore.updateCommande(commandeId, {
      delai_livraison: delaiText,
      statut: "facturee",
      numero_facture: numeroFacture,
    });

    const pdfBuffer = await generateInvoicePdfBuffer(commande);

    await sendWhatsappPdf(
      from,
      pdfBuffer,
      `${numeroFacture}.pdf`,
      "Voici votre facture. Merci pour votre confiance ! 🙏"
    );
    await sendWhatsappMessage(
      from,
      `Votre commande sera livrée sous : ${delaiText}. Merci pour votre confiance ! 🙏`
    );

    await sendWhatsappMessage(
      config.humanAgentNumber,
      `📄 Facture ${numeroFacture} envoyée à ${from}. Conversation clôturée.`
    );

    return true;
  } catch (err) {
    log.error("Échec finalisation facture", err);
    await sendWhatsappMessage(
      config.humanAgentNumber,
      `⚠️ Erreur lors de l'envoi de la facture à ${from} — vérifiez les logs.`
    );
    return true; // on considère la demande "traitée" pour ne pas la reproposer en boucle
  }
}
