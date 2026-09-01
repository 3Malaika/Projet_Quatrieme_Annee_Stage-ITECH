import { config } from "../config/env.js";
import { sendWhatsappMessage } from "../services/whatsapp.service.js";
import { clearPending, closeEscalationLog } from "../services/escalation.service.js";
import { confirmPayment, rejectPayment, provideDeliveryDelay } from "../services/payment.service.js";
import { createLogger } from "./logger.js";

const log = createLogger("humanCommands");

export async function handleHumanCommand(text, senderNumber = config.humanAgentNumber) {
  const trimmed = text.trim();

  if (!trimmed.startsWith("/")) {
    log.info("Message libre du collaborateur ignoré (aucune commande reconnue)", { texte: trimmed });
    await sendWhatsappMessage(
      senderNumber,
      "Je n'ai pas reconnu de commande. Envoyez /aide pour voir la liste des commandes disponibles."
    );
    return;
  }

  const parts = trimmed.split(" ");
  const command = parts[0];
  log.info("Commande reçue", { command });

  if (command === "/resolu") {
    const clientNumber = parts[1];
    clearPending(clientNumber);
    await closeEscalationLog(clientNumber);
    await sendWhatsappMessage(senderNumber, `✅ Escalade clôturée pour ${clientNumber}.`);
    log.info("Escalade clôturée via /resolu", { clientNumber });
    return;
  }

  if (command === "/repondre") {
    const clientNumber = parts[1];
    const messageToClient = parts.slice(2).join(" ");
    if (!messageToClient) {
      log.warn("/repondre appelée sans message", { clientNumber });
      await sendWhatsappMessage(senderNumber, "Format: /repondre <numero> <message>");
      return;
    }
    await sendWhatsappMessage(clientNumber, messageToClient);
    clearPending(clientNumber);
    await closeEscalationLog(clientNumber);
    await sendWhatsappMessage(senderNumber, `✅ Message envoyé à ${clientNumber}, escalade clôturée.`);
    log.info("Réponse manuelle envoyée via /repondre", { clientNumber });
    return;
  }

  // Confirmation EXPLICITE que le paiement a été reçu — rien ne se passe
  // (pas de commande, pas de facture) tant que cette commande n'a pas été
  // envoyée par le collaborateur.
  //
  // La description des produits est désormais OPTIONNELLE : si le client a
  // choisi une/des quantité(s) via la liste interactive WhatsApp, ce choix
  // est automatiquement récupéré et persisté dans la commande (voir
  // confirmPayment() dans payment.service.js). On ne l'exige donc que si
  // aucune sélection n'est en attente pour ce client (confirmPayment lève
  // alors une erreur explicite, remontée au collaborateur ci-dessous).
  if (command === "/paiement_recu") {
    const clientNumber = parts[1];
    const montant = parts[2] ? Number(parts[2]) : undefined;
    const produitsDescription = parts.slice(montant !== undefined ? 3 : 2).join(" ") || undefined;
    if (!clientNumber || (montant !== undefined && (!Number.isFinite(montant) || montant <= 0))) {
      log.warn("/paiement_recu appelée avec un format invalide", { clientNumber, montant });
      await sendWhatsappMessage(
        senderNumber,
        "Format: /paiement_recu <numero> [montant] [description des produits]\n(Si le client a validé un panier, le montant et les produits peuvent être récupérés automatiquement.)"
      );
      return;
    }
    try {
      await confirmPayment(clientNumber, montant, produitsDescription);
    } catch (err) {
      log.error("Échec /paiement_recu", { clientNumber, err });
      await sendWhatsappMessage(
        senderNumber,
        `⚠️ ${err.message}\nFormat: /paiement_recu <numero> [montant] <description des produits>`
      );
    }
    return;
  }

  // Le paiement n'a PAS été reçu : le bot prévient le client, rien n'est
  // facturé.
  if (command === "/paiement_refuse") {
    const clientNumber = parts[1];
    const raison = parts.slice(2).join(" ") || null;
    if (!clientNumber) {
      log.warn("/paiement_refuse appelée sans numéro");
      await sendWhatsappMessage(senderNumber, "Format: /paiement_refuse <numero> [raison]");
      return;
    }
    await rejectPayment(clientNumber, raison);
    return;
  }

  // Délai de livraison pour UN client précis (obligatoire de préciser le
  // numéro : plusieurs paiements peuvent être en cours de vérification en
  // même temps, un texte libre sans numéro serait ambigu).
  if (command === "/delai") {
    const clientNumber = parts[1];
    const delaiText = parts.slice(2).join(" ");
    if (!clientNumber || !delaiText) {
      log.warn("/delai appelée avec un format invalide", { clientNumber, delaiText });
      await sendWhatsappMessage(senderNumber, "Format: /delai <numero> <texte>");
      return;
    }
    await provideDeliveryDelay(clientNumber, delaiText);
    return;
  }

  if (command === "/aide") {
    await sendWhatsappMessage(
      senderNumber,
      "Commandes disponibles:\n/resolu <numero>\n/repondre <numero> <message>\n/paiement_recu <numero> [montant] [description produits]\n/paiement_refuse <numero> [raison]\n/delai <numero> <texte>"
    );
    return;
  }

  log.warn("Commande inconnue reçue du collaborateur", { command });
  await sendWhatsappMessage(
    senderNumber,
    "Commande non reconnue. Envoyez /aide pour voir la liste des commandes disponibles."
  );
}
