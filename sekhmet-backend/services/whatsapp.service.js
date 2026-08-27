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

// Upload direct d'un fichier binaire vers l'API Meta (pas besoin d'hébergement
// public : le fichier est envoyé directement, on récupère juste un media_id
// à référencer dans le message qui suit).
export async function uploadWhatsappMedia(buffer, filename, mimeType) {
  const url = `https://graph.facebook.com/v21.0/${config.phoneNumberId}/media`;

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([buffer], { type: mimeType }), filename);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.whatsappToken}` },
      body: form,
    });
  } catch (networkErr) {
    log.error("Erreur réseau lors de l'upload du média", networkErr);
    throw networkErr;
  }

  const data = await response.json();
  if (!response.ok) {
    log.error(`Échec upload média WhatsApp (${response.status})`, data);
    throw new Error(`Échec upload média (${response.status}): ${data?.error?.message || "erreur inconnue"}`);
  }

  log.info("Média WhatsApp uploadé", { mediaId: data.id, filename });
  return data.id;
}

// Envoie un document déjà uploadé (media_id) en pièce jointe.
export async function sendWhatsappDocument(to, mediaId, filename, caption) {
  const url = `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`;

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
        type: "document",
        document: { id: mediaId, filename, caption },
      }),
    });
  } catch (networkErr) {
    log.error(`Erreur réseau lors de l'envoi du document vers ${to}`, networkErr);
    throw networkErr;
  }

  const data = await response.json();
  if (!response.ok) {
    log.error(`Échec envoi document WhatsApp vers ${to} (${response.status})`, data);
    throw new Error(`Échec envoi document (${response.status}): ${data?.error?.message || "erreur inconnue"}`);
  }

  log.info(`Document envoyé à ${to}`, { filename, waId: data?.messages?.[0]?.id });
  return data;
}

// Envoie une image par lien public (pas besoin d'upload préalable — utile
// pour les images produits déjà hébergées, ex. Supabase Storage). Si le lien
// n'est pas valide/accessible publiquement, Meta renvoie une erreur 400 que
// l'appelant doit gérer (ex. repli sur un message texte).
export async function sendWhatsappImage(to, imageUrl, caption) {
  const url = `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`;

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
        type: "image",
        image: { link: imageUrl, caption },
      }),
    });
  } catch (networkErr) {
    log.error(`Erreur réseau lors de l'envoi d'image vers ${to}`, networkErr);
    throw networkErr;
  }

  const data = await response.json();
  if (!response.ok) {
    log.error(`Échec envoi image WhatsApp vers ${to} (${response.status})`, data);
    throw new Error(`Échec envoi image (${response.status}): ${data?.error?.message || "erreur inconnue"}`);
  }

  log.info(`Image envoyée à ${to}`, { imageUrl, waId: data?.messages?.[0]?.id });
  return data;
}

// Upload + envoi en un seul appel : le cas d'usage courant (facture, etc.)
export async function sendWhatsappPdf(to, buffer, filename, caption) {
  const mediaId = await uploadWhatsappMedia(buffer, filename, "application/pdf");
  return sendWhatsappDocument(to, mediaId, filename, caption);
}
