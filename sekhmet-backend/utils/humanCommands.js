import { config } from "../config/env.js";
import { sendWhatsappMessage } from "../services/whatsapp.service.js";
import { clearPending, closeEscalationLog } from "../services/escalation.service.js";
import { confirmPayment, rejectPayment, provideDeliveryDelay } from "../services/payment.service.js";
import { createLogger } from "./logger.js";

const log = createLogger("humanCommands");

export async function handleHumanCommand(text) {
  const trimmed = text.trim();

  // Message en texte libre (pas de "/") : si une commande vient d'être
  // marquée payée et attend un délai de livraison, c'est très probablement
  // la réponse à cette question.
  if (!trimmed.startsWith("/")) {
    const handled = await provideDeliveryDelay(trimmed);
    if (handled) {
      log.info("Délai de livraison traité (réponse en texte libre)");
      return;
    }
    log.info("Message libre du collaborateur ignoré (aucune action en attente)", { texte: trimmed });
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

  log.warn("Commande inconnue reçue du collaborateur", { command });
  await sendWhatsappMessage(
    config.humanAgentNumber,
    "Commandes disponibles:\n/resolu <numero>\n/repondre <numero> <message>\n/paiement_recu <numero> <montant> <description produits>\n/paiement_refuse <numero> [raison]\n\n(Répondre en texte libre, sans \"/\", pour indiquer un délai de livraison en attente.)"
  );
}
