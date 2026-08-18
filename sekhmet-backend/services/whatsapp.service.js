import { config } from "../config/env.js";

export async function sendWhatsappMessage(to, text) {
  const url = `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      text: { body: text },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("Erreur envoi WhatsApp:", JSON.stringify(data, null, 2));
  }
}
