import { config } from "../config/env.js";
import { sendWhatsappMessage } from "../services/whatsapp.service.js";
import { clearPending, closeEscalationLog } from "../services/escalation.service.js";
import { confirmPayment, rejectPayment, provideDeliveryDelay } from "../services/payment.service.js";
import { createLogger } from "./logger.js";

const log = createLogger("humanCommands");

export async function handleHumanCommand(text) {
  const trimmed = text.trim();

  if (!trimmed.startsWith("/")) {
    log.info("Message libre du collaborateur ignoré (aucune commande reconnue)", { texte: trimmed });
    await sendWhatsappMessage(
      config.humanAgentNumber,
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
    closeEscalationLog(clientNumber);
    await sendWhatsappMessage(config.humanAgentNumber, `✅ Escalade clôturée pour ${clientNumber}.`);
    log.info("Escalade clôturée via /resolu", { clientNumber });
    return;
  }

  if (command === "/repondre") {
    const clientNumber = parts[1];
    const messageToClient = parts.slice(2).join(" ");
    if (!messageToClient) {
      log.warn("/repondre appelée sans message", { clientNumber });
      await sendWhatsappMessage(config.humanAgentNumber, "Format: /repondre <numero> <message>");
      return;
    }
    await sendWhatsappMessage(clientNumber, messageToClient);
    clearPending(clientNumber);
    closeEscalationLog(clientNumber);
    await sendWhatsappMessage(config.humanAgentNumber, `✅ Message envoyé à ${clientNumber}, escalade clôturée.`);
    log.info("Réponse manuelle envoyée via /repondre", { clientNumber });
    return;
  }

  // Confirmation EXPLICITE que le paiement a été reçu — rien ne se passe
  // (pas de commande, pas de facture) tant que cette commande n'a pas été
  // envoyée par le collaborateur.
  if (command === "/paiement_recu") {
    const clientNumber = parts[1];
    const montant = Number(parts[2]);
    const produitsDescription = parts.slice(3).join(" ");
    if (!clientNumber || !montant || !produitsDescription) {
      log.warn("/paiement_recu appelée avec un format invalide", { clientNumber, montant, produitsDescription });
      await sendWhatsappMessage(
        config.humanAgentNumber,
        "Format: /paiement_recu <numero> <montant> <description des produits>"
      );
      return;
    }
    await confirmPayment(clientNumber, montant, produitsDescription);
    return;
  }

  // Le paiement n'a PAS été reçu : le bot prévient le client, rien n'est
  // facturé.
  if (command === "/paiement_refuse") {
    const clientNumber = parts[1];
    const raison = parts.slice(2).join(" ") || null;
    if (!clientNumber) {
      log.warn("/paiement_refuse appelée sans numéro");
      await sendWhatsappMessage(config.humanAgentNumber, "Format: /paiement_refuse <numero> [raison]");
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
      await sendWhatsappMessage(config.humanAgentNumber, "Format: /delai <numero> <texte>");
      return;
    }
    await provideDeliveryDelay(clientNumber, delaiText);
    return;
  }

  if (command === "/aide") {
    await sendWhatsappMessage(
      config.humanAgentNumber,
      "Commandes disponibles:\n/resolu <numero>\n/repondre <numero> <message>\n/paiement_recu <numero> <montant> <description produits>\n/paiement_refuse <numero> [raison]\n/delai <numero> <texte>"
    );
    return;
  }

  log.warn("Commande inconnue reçue du collaborateur", { command });
  await sendWhatsappMessage(
    config.humanAgentNumber,
    "Commande non reconnue. Envoyez /aide pour voir la liste des commandes disponibles."
  );
}
