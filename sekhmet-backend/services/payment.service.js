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

// File des commandes payées en attente d'un délai de livraison de la part
// du collaborateur (FIFO — un seul collaborateur, traitement séquentiel).
const awaitingDelaiQueue = [];

export function hasAwaitingDelai() {
  return awaitingDelaiQueue.length > 0;
}

/**
 * Étape 1 — le client dit avoir payé : on extrait le nom du compte Mobile
 * Money s'il est mentionné, on répond au client par un message neutre (il
 * ne doit jamais savoir qu'un humain est sollicité), et on transmet la
 * demande de vérification au collaborateur.
 */
export async function requestPaymentConfirmation(from, userMessage) {
  const { compteMobileMoney } = await extractPaymentInfo(userMessage);

  pendingPayments[from] = {
    userMessage,
    compteMobileMoney,
    timestamp: Date.now(),
  };

  log.info("Demande de confirmation de paiement", { from, compteMobileMoney });

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
 * Étape 2 — le collaborateur confirme avoir reçu le paiement : on crée la
 * commande, puis on lui demande le délai de livraison (sa PROCHAINE réponse
 * en texte libre, sans "/", sera interprétée comme ce délai).
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

  awaitingDelaiQueue.push({ phone: from, commandeId: commande.id });
  log.info("Paiement confirmé, en attente du délai de livraison", { from, commandeId: commande.id });

  await sendWhatsappMessage(
    config.humanAgentNumber,
    `✅ Paiement confirmé pour ${from} (${montant} FCFA).\n\nQuel est le délai de livraison ? (répondez simplement en texte, sans "/")`
  );

  return commande;
}

export async function rejectPayment(from, raison) {
  delete pendingPayments[from];
  log.info("Paiement refusé/non trouvé", { from, raison });

  await sendWhatsappMessage(
    from,
    "Nous n'avons pas encore reçu votre paiement de notre côté. Pourriez-vous vérifier et réessayer, ou nous envoyer une capture de la transaction ?"
  );
}

/**
 * Étape 3 — le collaborateur répond (texte libre) avec le délai de
 * livraison : on finalise la commande, génère la facture PDF et l'envoie
 * directement au client sur WhatsApp, avec le délai annoncé.
 */
export async function provideDeliveryDelay(delaiText) {
  if (awaitingDelaiQueue.length === 0) return false;

  const { phone, commandeId } = awaitingDelaiQueue.shift();
  log.info("Délai de livraison reçu, finalisation de la facture", { phone, commandeId, delaiText });

  try {
    const numeroFacture = generateNumeroFacture();
    const commande = await commandesStore.updateCommande(commandeId, {
      delai_livraison: delaiText,
      statut: "facturee",
      numero_facture: numeroFacture,
    });

    const pdfBuffer = await generateInvoicePdfBuffer(commande);

    await sendWhatsappPdf(
      phone,
      pdfBuffer,
      `${numeroFacture}.pdf`,
      "Voici votre facture. Merci pour votre confiance ! 🙏"
    );
    await sendWhatsappMessage(
      phone,
      `Votre commande sera livrée sous : ${delaiText}. Merci pour votre confiance ! 🙏`
    );

    await sendWhatsappMessage(
      config.humanAgentNumber,
      `📄 Facture ${numeroFacture} envoyée à ${phone}. Conversation clôturée.`
    );

    return true;
  } catch (err) {
    log.error("Échec finalisation facture", err);
    await sendWhatsappMessage(
      config.humanAgentNumber,
      `⚠️ Erreur lors de l'envoi de la facture à ${phone} — vérifiez les logs.`
    );
    return true; // on considère la demande "traitée" pour ne pas la reproposer en boucle
  }
}
