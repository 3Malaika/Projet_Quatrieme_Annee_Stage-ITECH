import { config } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("whatsapp");

// WhatsApp coupe tout message au-delà de 4096 caractères.
const WHATSAPP_MAX_LENGTH = 4096;

export async function sendWhatsappTemplate(to, name, languageCode = "fr", parameters = []) {
  const url = `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`;
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name,
      language: { code: languageCode },
      ...(parameters.length
        ? { components: [{ type: "body", parameters: parameters.map((text) => ({ type: "text", text: String(text ?? "") })) }] }
        : {}),
    },
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.whatsappToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    log.error(`Erreur réseau lors de l'envoi du template vers ${to}`, networkErr);
    throw networkErr;
  }

  const data = await response.json();
  if (!response.ok) {
    log.error(`Échec envoi template WhatsApp vers ${to} (${response.status})`, data);
    throw new Error(`Échec template WhatsApp (${response.status}): ${data?.error?.message || "erreur inconnue"}`);
  }

  log.info(`Template WhatsApp envoyé à ${to}`, {
    template: name,
    language: languageCode,
    waId: data?.messages?.[0]?.id,
  });
  return data;
}

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

// Envoie un message interactif "liste" (jusqu'à 10 lignes) : c'est ce que
// l'on utilise pour la sélection de quantité + validation après la fiche
// d'un produit recommandé. Contrairement aux boutons (limités à 3, 20
// caractères chacun), une liste supporte assez de lignes pour couvrir
// plusieurs quantités + une option "Autre quantité", et ne nécessite AUCUNE
// configuration préalable côté Meta Business Manager (contrairement aux
// WhatsApp Flows, cf. sendWhatsappFlow ci-dessous).
export async function sendWhatsappInteractiveList(to, { header, body, footer, buttonText, sections }) {
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
        type: "interactive",
        interactive: {
          type: "list",
          ...(header ? { header: { type: "text", text: header } } : {}),
          body: { text: body },
          ...(footer ? { footer: { text: footer } } : {}),
          action: {
            button: buttonText || "Choisir",
            sections,
          },
        },
      }),
    });
  } catch (networkErr) {
    log.error(`Erreur réseau lors de l'envoi de la liste interactive vers ${to}`, networkErr);
    throw networkErr;
  }

  const data = await response.json();
  if (!response.ok) {
    log.error(`Échec envoi liste interactive WhatsApp vers ${to} (${response.status})`, data);
    throw new Error(
      `Échec envoi liste interactive (${response.status}): ${data?.error?.message || "erreur inconnue"}`
    );
  }

  log.info(`Liste interactive envoyée à ${to}`, { waId: data?.messages?.[0]?.id });
  return data;
}

// Envoie un WhatsApp Flow (formulaire multi-écrans natif de Meta) : utile
// pour un vrai écran "quantité + validation" avec champ numérique libre.
// PRÉ-REQUIS (côté Meta Business Manager, pas dans ce code) : créer et
// publier un Flow, récupérer son "Flow ID", et le renseigner dans la
// variable d'environnement WHATSAPP_FLOW_ID. Tant que ce n'est pas fait,
// le code applicatif utilise plutôt sendWhatsappInteractiveList ci-dessus
// (qui fonctionne immédiatement, sans configuration supplémentaire).
export async function sendWhatsappFlow(to, { header, body, footer, flowId, flowCta, flowToken, screen, data: flowData }) {
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
  } catch (networkErr) {
    log.error(`Erreur réseau lors de l'envoi du flow vers ${to}`, networkErr);
    throw networkErr;
  }

  const data = await response.json();
  if (!response.ok) {
    log.error(`Échec envoi flow WhatsApp vers ${to} (${response.status})`, data);
    throw new Error(`Échec envoi flow (${response.status}): ${data?.error?.message || "erreur inconnue"}`);
  }

  log.info(`Flow envoyé à ${to}`, { flowId, waId: data?.messages?.[0]?.id });
  return data;
}

// Options rapides configurables : utilisées uniquement lorsque le parcours le prévoit.
export async function sendWhatsappQuickOptions(to, options = []) {
  const rows = options.slice(0, 10).map((o) => ({ id: String(o.id), title: String(o.title).slice(0, 24), description: o.description ? String(o.description).slice(0, 72) : undefined }));
  if (!rows.length) return null;
  return sendWhatsappInteractiveList(to, {
    body: "Que souhaitez-vous faire ?",
    footer: "Vous pouvez aussi écrire votre demande librement.",
    buttonText: "Choisir",
    sections: [{ title: "Options rapides", rows }],
  });
}
