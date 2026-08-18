import { config } from "../config/env.js";
import { sendWhatsappMessage } from "../services/whatsapp.service.js";
import { clearPending, closeEscalationLog } from "../services/escalation.service.js";

export async function handleHumanCommand(text) {
  const parts = text.trim().split(" ");
  const command = parts[0];

  if (command === "/resolu") {
    const clientNumber = parts[1];
    clearPending(clientNumber);
    closeEscalationLog(clientNumber);
    await sendWhatsappMessage(config.humanAgentNumber, `✅ Escalade clôturée pour ${clientNumber}.`);
    return;
  }

  if (command === "/repondre") {
    const clientNumber = parts[1];
    const messageToClient = parts.slice(2).join(" ");
    if (!messageToClient) {
      await sendWhatsappMessage(config.humanAgentNumber, "Format: /repondre <numero> <message>");
      return;
    }
    await sendWhatsappMessage(clientNumber, messageToClient);
    clearPending(clientNumber);
    closeEscalationLog(clientNumber);
    await sendWhatsappMessage(config.humanAgentNumber, `✅ Message envoyé à ${clientNumber}, escalade clôturée.`);
    return;
  }

  await sendWhatsappMessage(
    config.humanAgentNumber,
    "Commandes disponibles:\n/resolu <numero>\n/repondre <numero> <message>"
  );
}
