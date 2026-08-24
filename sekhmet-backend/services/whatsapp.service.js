import { config } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("whatsapp");

// WhatsApp coupe tout message au-delà de 4096 caractères.
const WHATSAPP_MAX_LENGTH = 4096;

export async function sendWhatsappMessage(to, text) {
  const url = `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`;
  const body = text.length > WHATSAPP_MAX_LENGTH
    ? text.slice(0, WHATSAPP_MAX_LENGTH - 1) + "…"
    : text;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.whatsappToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        // Champ requis par l'API Meta : sans lui, la requête est rejetée
        // (400) et AUCUN message ne part, silencieusement.
        type: "text",
        text: { body },
      }),
    });
  } catch (networkErr) {
    log.error(`Erreur réseau lors de l'envoi vers ${to}`, networkErr);
    throw networkErr;
  }

  const data = await response.json();
  if (!response.ok) {
    log.error(`Échec envoi WhatsApp vers ${to} (${response.status})`, data);
    // On remonte l'erreur : le code appelant (webhook) doit savoir que
    // l'envoi a échoué, plutôt que de croire silencieusement que tout va bien.
    throw new Error(
      `Échec envoi WhatsApp (${response.status}): ${data?.error?.message || "erreur inconnue"}`
    );
  }

  log.info(`Message envoyé à ${to}`, { longueur: body.length, waId: data?.messages?.[0]?.id });
  return data;
}
