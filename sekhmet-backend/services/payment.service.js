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

// Demandes de confirmation de paiement en attente : { "237...": {...} }
const pendingPayments = {};

// Commandes payées, en attente d'un délai de livraison — indexées par
// numéro de client (pas une file FIFO : le collaborateur peut vérifier
// plusieurs paiements en même temps, donc on doit toujours savoir
// EXACTEMENT à quel client une confirmation/délai se rapporte).
const awaitingDelai = {}; // { "237...": commandeId }

/**
 * Étape 1 — le client dit avoir payé : on extrait le nom du compte Mobile
 * Money s'il est mentionné, on répond au client par un message neutre (il
 * ne doit jamais savoir qu'un humain est sollicité), et on transmet la
 * demande de vérification au collaborateur. Le bot NE VALIDE RIEN à ce
 * stade : ni commande, ni facture — tout attend une confirmation explicite
 * du collaborateur, qui peut prendre son temps (il vérifie peut-être
 * plusieurs paiements en parallèle).
 */
export async function requestPaymentConfirmation(from, userMessage) {
  const { compteMobileMoney } = await extractPaymentInfo(userMessage, from);

  pendingPayments[from] = {
    userMessage,
    compteMobileMoney,
    timestamp: Date.now(),
  };

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
    `💰 Paiement à vérifier — client ${from}\n\n${compteLigne}\n\nDernier message : "${userMessage}"\n\nSi reçu :\n/paiement_recu ${from} <montant> <description des produits>\n\nSi non reçu :\n/paiement_refuse ${from} [raison]`
  );
}

/**
 * Étape 2 — le collaborateur confirme EXPLICITEMENT avoir reçu le paiement
 * (commande /paiement_recu) : seulement à ce moment la commande existe.
 * On lui demande ensuite le délai de livraison, en exigeant qu'il précise
 * le numéro du client dans sa réponse (/delai <numero> <texte>) — comme
 * plusieurs paiements peuvent être en cours de vérification en même temps,
 * une réponse en texte libre sans numéro serait ambiguë.
 */
export async function confirmPayment(from, montant, produitsDescription) {
  delete pendingPayments[from];

  const client = await clientsStore.getClient(from);

  const commande = await commandesStore.createCommande({
    phone: from,
    nom_client: client?.nom || null,
    produits: produitsDescription,
    montant_total: montant,
    statut: "paiement_confirme",
  });

  awaitingDelai[from] = commande.id;
  log.info("Paiement confirmé, en attente du délai de livraison", { from, commandeId: commande.id });

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
  delete pendingPayments[from];
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
  const commandeId = awaitingDelai[from];
  if (!commandeId) {
    log.warn("/delai reçu mais aucun paiement confirmé en attente pour ce numéro", { from });
    await sendWhatsappMessage(
      config.humanAgentNumber,
      `⚠️ Aucun paiement confirmé en attente pour ${from}. Utilisez d'abord /paiement_recu.`
    );
    return false;
  }
  delete awaitingDelai[from];

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
