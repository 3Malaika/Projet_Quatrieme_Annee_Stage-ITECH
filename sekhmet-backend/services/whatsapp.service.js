import { config } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("whatsapp");
const WHATSAPP_API_VERSION = "v21.0";
const WHATSAPP_MAX_LENGTH = 4096;

function messagesUrl() {
  return `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${config.phoneNumberId}/messages`;
}

function mediaUrl() {
  return `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${config.phoneNumberId}/media`;
}

function authHeaders(withJson = true) {
  return {
    Authorization: `Bearer ${config.whatsappToken}`,
    ...(withJson ? { "Content-Type": "application/json" } : {}),
  };
}

async function parseResponse(response) {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `Erreur WhatsApp ${response.status}`);
  }
  return data;
}

export async function sendWhatsappTemplate(to, name, languageCode = "fr", parameters = []) {
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name,
      language: { code: languageCode },
      ...(parameters.length
        ? {
            components: [
              {
                type: "body",
                parameters: parameters.map((text) => ({ type: "text", text: String(text ?? "") })),
              },
            ],
          }
        : {}),
    },
  };

  try {
    const response = await fetch(messagesUrl(), {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify(body),
    });
    const data = await parseResponse(response);
    log.info("Template WhatsApp envoyé", { to, template: name, language: languageCode, waId: data?.messages?.[0]?.id });
    return data;
  } catch (err) {
    log.error("Échec envoi template WhatsApp", { to, template: name, error: err?.message || String(err) });
    throw err;
  }
}

export async function sendWhatsappMessage(to, text) {
  const safeText = String(text ?? "");
  const body = safeText.length > WHATSAPP_MAX_LENGTH
    ? `${safeText.slice(0, WHATSAPP_MAX_LENGTH - 1)}…`
    : safeText;

  try {
    const response = await fetch(messagesUrl(), {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body },
      }),
    });
    const data = await parseResponse(response);
    log.info("Message WhatsApp envoyé", { to, longueur: body.length, waId: data?.messages?.[0]?.id });
    return data;
  } catch (err) {
    log.error("Échec envoi message WhatsApp", { to, error: err?.message || String(err) });
    throw err;
  }
}

export async function uploadWhatsappMedia(buffer, filename, mimeType) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([buffer], { type: mimeType }), filename);

  try {
    const response = await fetch(mediaUrl(), {
      method: "POST",
      headers: authHeaders(false),
      body: form,
    });
    const data = await parseResponse(response);
    log.info("Média WhatsApp uploadé", { mediaId: data.id, filename });
    return data.id;
  } catch (err) {
    log.error("Échec upload média WhatsApp", { filename, error: err?.message || String(err) });
    throw err;
  }
}

export async function sendWhatsappDocument(to, mediaId, filename, caption) {
  try {
    const response = await fetch(messagesUrl(), {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "document",
        document: { id: mediaId, filename, ...(caption ? { caption } : {}) },
      }),
    });
    const data = await parseResponse(response);
    log.info("Document WhatsApp envoyé", { to, filename, waId: data?.messages?.[0]?.id });
    return data;
  } catch (err) {
    log.error("Échec envoi document WhatsApp", { to, filename, error: err?.message || String(err) });
    throw err;
  }
}

export async function sendWhatsappImage(to, imageUrl, caption) {
  try {
    const response = await fetch(messagesUrl(), {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "image",
        image: { link: imageUrl, ...(caption ? { caption } : {}) },
      }),
    });
    const data = await parseResponse(response);
    log.info("Image WhatsApp envoyée", { to, imageUrl, waId: data?.messages?.[0]?.id });
    return data;
  } catch (err) {
    log.error("Échec envoi image WhatsApp", { to, error: err?.message || String(err) });
    throw err;
  }
}

export async function sendWhatsappPdf(to, buffer, filename, caption) {
  const mediaId = await uploadWhatsappMedia(buffer, filename, "application/pdf");
  return sendWhatsappDocument(to, mediaId, filename, caption);
}

export async function sendWhatsappInteractiveList(to, { header, body, footer, buttonText, sections }) {
  try {
    const response = await fetch(messagesUrl(), {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          ...(header ? { header: { type: "text", text: header } } : {}),
          body: { text: body },
          ...(footer ? { footer: { text: footer } } : {}),
          action: { button: buttonText || "Choisir", sections },
        },
      }),
    });
    const data = await parseResponse(response);
    log.info("Liste interactive WhatsApp envoyée", { to, waId: data?.messages?.[0]?.id });
    return data;
  } catch (err) {
    log.error("Échec envoi liste interactive", { to, error: err?.message || String(err) });
    throw err;
  }
}

export async function sendWhatsappFlow(to, { header, body, footer, flowId, flowCta, flowToken, screen, data: flowData }) {
  try {
    const response = await fetch(messagesUrl(), {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "flow",
          ...(header ? { header: { type: "text", text: header } } : {}),
          body: { text: body },
          ...(footer ? { footer: { text: footer } } : {}),
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "3",
              flow_token: flowToken,
              flow_id: flowId,
              flow_cta: flowCta || "Commander",
              flow_action: "navigate",
              flow_action_payload: { screen, data: flowData },
            },
          },
        },
      }),
    });
    const result = await parseResponse(response);
    log.info("WhatsApp Flow envoyé", { to, flowId, waId: result?.messages?.[0]?.id });
    return result;
  } catch (err) {
    log.error("Échec envoi WhatsApp Flow", { to, error: err?.message || String(err) });
    throw err;
  }
}

export async function sendWhatsappQuickOptions(to, options = []) {
  const rows = options.slice(0, 10).map((option) => ({
    id: String(option.id),
    title: String(option.title).slice(0, 24),
    ...(option.description ? { description: String(option.description).slice(0, 72) } : {}),
  }));
  if (!rows.length) return null;
  return sendWhatsappInteractiveList(to, {
    body: "Que souhaitez-vous faire ?",
    footer: "Vous pouvez aussi écrire votre demande librement.",
    buttonText: "Choisir",
    sections: [{ title: "Options rapides", rows }],
  });
}
