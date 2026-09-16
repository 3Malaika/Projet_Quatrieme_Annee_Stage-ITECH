import { Router } from "express";
import { config } from "../config/env.js";
import {
  handleClientMessage,
  getHistory,
  appendHistoryEntry,
  deleteConversationHistory,
} from "../services/chat.service.js";
import {
  sendWhatsappMessage,
  sendWhatsappImage,
} from "../services/whatsapp.service.js";
import { formatFicheProduit } from "../services/catalogueFormatter.service.js";
import { sendProductRecommendations } from "../services/recommendation.service.js";
import {
  enqueueEscalation,
  isPending,
  isHumanAgentNumber,
  noteHumanAgentInbound,
  handleWhatsappEscalationStatus,
} from "../services/escalation.service.js";
import {
  requestPaymentConfirmation,
  getCart,
  formatCart,
  cancelCartAbandonConfirmation,
  confirmCartAbandonment,
  confirmDeliveryPhone,
  provideMobileMoneyAccountInfo,
  provideDeliveryAddress,
  requestDeliveryAddress,
  requestClientName,
  clearAwaitingClientName,
  getAwaitingState,
  isPositiveResponse,
  isNegativeResponse,
  hasDeliveryMode,
  requestDeliveryMode,
  provideDeliveryModeFromText,
  isAwaitingPickupMoment,
  requestPickupMoment,
  providePickupMoment,
  hasRequiredLogisticsInfo,
  getDeliveryMode,
} from "../services/payment.service.js";
import { handleHumanCommand } from "../utils/humanCommands.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("webhook");

const { loadOpeningMessage } = config.supabaseUrl
  ? await import("../data/configTextes.store.supabase.js")
  : await import("../data/openingMessage.store.js");
const { getClient, upsertClient } = config.supabaseUrl
  ? await import("../data/clients.store.supabase.js")
  : await import("../data/clients.store.js");
const { loadPaiementComptes } = config.supabaseUrl
  ? await import("../data/configTextes.store.supabase.js")
  : await import("../data/paiementCompte.store.js");

const recentlyProcessedMessageIds = new Map();
const MESSAGE_ID_TTL_MS = 60_000;

function isDuplicateMessage(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [key, timestamp] of recentlyProcessedMessageIds) {
    if (now - timestamp > MESSAGE_ID_TTL_MS) recentlyProcessedMessageIds.delete(key);
  }
  if (recentlyProcessedMessageIds.has(id)) return true;
  recentlyProcessedMessageIds.set(id, now);
  return false;
}

function formatInfosPaiement(comptes) {
  if (!comptes?.length) {
    return "Un instant, je transmets votre demande à un collaborateur pour vous communiquer les informations de paiement 🙏";
  }
  if (comptes.length === 1) {
    const compte = comptes[0];
    return `Vous pouvez envoyer le paiement au numéro *${compte.numero}*${compte.nom ? ` (au nom de *${compte.nom}*)` : ""}. Dès que c'est fait, dites-le-moi ici pour que je vérifie la réception 🙏`;
  }
  const lignes = comptes.map((compte) => `- *${compte.numero}*${compte.nom ? ` (au nom de *${compte.nom}*)` : ""}`).join("\n");
  return `Vous pouvez envoyer le paiement à l'un des numéros suivants :\n${lignes}\n\nDès que c'est fait, dites-le-moi ici pour que je vérifie la réception 🙏`;
}

async function sendCartPaymentInstructions(from) {
  const client = await getClient(from);
  if (!client?.nom) {
    await requestClientName(from);
    return;
  }
  if (!hasDeliveryMode(from)) {
    await requestDeliveryMode(from);
    return;
  }
  if (!hasRequiredLogisticsInfo(from)) {
    if (getDeliveryMode(from) === "retrait_boutique") await requestPickupMoment(from);
    else await requestDeliveryAddress(from);
    return;
  }

  const comptes = await loadPaiementComptes();
  const message = `${formatCart(from)}\n\n${formatInfosPaiement(comptes)}`;
  await appendHistoryEntry(from, { role: "assistant", content: message });
  await sendWhatsappMessage(from, message);
}

function extractClientEntities(message) {
  const raw = String(message || "").trim();
  const namePatterns = [
    /(?:moi c[’']est|je m[’']appelle|je m[’']appele|je m[’']appel|mon prénom est|mon prenom est|mon nom est|appelez[- ]moi|vous pouvez m[’']appeler)\s+([A-Za-zÀ-ÖØ-öø-ÿ'’ -]{2,40}?)(?=\s+(?:et|je|j[’']ai|je cherche|je veux|j[’']aimerais|j[’']voudrais|pour)\b|[.!?,;:]|$)/i,
    /(?:nom|pr[ée]nom|prenon)\s*(?:est|[:=])\s*([A-Za-zÀ-ÖØ-öø-ÿ'’ -]{2,40}?)(?=\s+(?:et|je|j[’']ai|je cherche|je veux|pour)\b|[.!?,;:]|$)/i,
  ];

  let name = null;
  for (const pattern of namePatterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      name = match[1].trim().replace(/[.!?,;:]+$/, "");
      break;
    }
  }
  if (!name) {
    const naturalName = raw.match(/^([A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,30})\s*[,;-]\s*(?:je|j[’']|moi)\b/i);
    if (naturalName?.[1]) name = naturalName[1].trim();
  }

  const needPatterns = [
    /(?:mon besoin est|besoin\s*[:=]|je cherche|j[’']aimerais|je voudrais|je veux|j[’']ai besoin de|je souhaite)\s+(.{3,160})$/i,
    /(?:pour|concernant)\s+(.{3,120})$/i,
  ];
  let need = null;
  for (const pattern of needPatterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      need = match[1].trim().replace(/[.!?]+$/, "");
      break;
    }
  }
  if (!need) {
    const normalized = raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    for (const token of ["formation", "suivi alimentaire", "produits finis", "produits", "catalogue", "commande"]) {
      if (normalized.includes(token)) {
        need = token;
        break;
      }
    }
  }
  return { name, need };
}

const router = Router();

router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.verifyToken) {
    log.info("Vérification webhook réussie");
    res.status(200).send(challenge);
    return;
  }
  log.warn("Vérification webhook refusée", { mode, tokenReçuLength: token?.length });
  res.sendStatus(403);
});

router.post("/", async (req, res) => {
  res.sendStatus(200);
  log.info("Webhook POST reçu", req.body);

  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];
  const status = change?.value?.statuses?.[0];

  if (!message) {
    if (status) {
      try {
        const handled = await handleWhatsappEscalationStatus(status);
        if (handled) {
          log.info("Statut WhatsApp d'une escalade traité", {
            messageId: status.id,
            status: status.status,
            errorCode: status.errors?.[0]?.code || null,
          });
        }
      } catch (err) {
        log.error("Erreur traitement statut WhatsApp", {
          messageId: status.id,
          error: err?.message || String(err),
        });
      }
    }
    return;
  }

  const from = message.from;
  if (isDuplicateMessage(message.id)) {
    log.warn("Message dupliqué ignoré", { from, messageId: message.id });
    return;
  }

  // Garantit qu'une fiche client existe TOUJOURS avant la moindre autre
  // écriture (conversation, panier, état de paiement) pour ce numéro.
  // Indispensable depuis l'ajout de la contrainte ON DELETE CASCADE
  // (conversations_phone_fkey, carts_phone_fkey, payment_state_phone_fkey)
  // : sans fiche client existante, Postgres rejette l'insertion — ce qui
  // arrive systématiquement pour un client qui vient d'être supprimé côté
  // admin puis réécrit au bot, ou pour tout nouveau client qui n'a encore
  // ni nom ni besoin détecté. On ne crée jamais cette fiche pour le numéro
  // du collaborateur lui-même : ce n'est pas un client.
  const isAgentSender = await isHumanAgentNumber(from).catch(() => false);
  if (!isAgentSender) {
    const existingClient = await getClient(from).catch(() => null);
    if (!existingClient) {
      await upsertClient(from, {}).catch((err) => log.error("Échec création fiche client minimale", { from, err }));
    }
  }

  if (message.type === "sticker") {
    const stickerId = message.sticker?.id || null;
    const stickerAnimated = message.sticker?.animated ? " animé" : "";
    await appendHistoryEntry(from, {
      role: "user",
      content: `[Sticker WhatsApp${stickerAnimated}${stickerId ? ` — ${stickerId}` : ""}]`,
      type: "sticker",
      mediaId: stickerId,
    });
    return;
  }

  const userMessage = message.text?.body;
  if (!userMessage) {
    log.warn("Message reçu sans texte exploitable", { from, type: message.type });
    return;
  }

  const quotedMessageId = message.context?.id || null;

  try {
    if (isAgentSender) {
      noteHumanAgentInbound(from);
      await handleHumanCommand(userMessage, from, quotedMessageId);
      return;
    }

    const awaitingState = getAwaitingState(from);
    let yesNoUserAlreadyRecorded = false;

    if (awaitingState.awaitingPaymentAccountInfo) {
      await appendHistoryEntry(from, { role: "user", content: userMessage, timestamp: new Date().toISOString() });
      yesNoUserAlreadyRecorded = true;
      if (await provideMobileMoneyAccountInfo(from, userMessage)) return;
    } else if (awaitingState.awaitingDeliveryConfirmation) {
      await appendHistoryEntry(from, { role: "user", content: userMessage, timestamp: new Date().toISOString() });
      yesNoUserAlreadyRecorded = true;
      const confirmed = isPositiveResponse(userMessage);
      const refused = isNegativeResponse(userMessage);
      if (confirmed || refused) {
        await confirmDeliveryPhone(from, confirmed);
        return;
      }
    } else if (awaitingState.awaitingCartAbandonConfirmation) {
      await appendHistoryEntry(from, { role: "user", content: userMessage, timestamp: new Date().toISOString() });
      yesNoUserAlreadyRecorded = true;
      const confirmed = isPositiveResponse(userMessage);
      const refused = isNegativeResponse(userMessage);
      if (confirmed) {
        await confirmCartAbandonment(from);
        await sendWhatsappMessage(from, "🧹 C'est confirmé. Votre panier a été vidé. Si vous changez d'avis, je reste à votre disposition.");
        return;
      }
      if (refused) {
        await cancelCartAbandonConfirmation(from);
        await sendWhatsappMessage(from, "D'accord, je conserve votre panier.");
        return;
      }
    } else if (awaitingState.awaitingDeliveryMode) {
      await appendHistoryEntry(from, { role: "user", content: userMessage, timestamp: new Date().toISOString() });
      const recognized = await provideDeliveryModeFromText(from, userMessage);
      if (recognized) await sendCartPaymentInstructions(from);
      return;
    } else if (isAwaitingPickupMoment(from)) {
      await appendHistoryEntry(from, { role: "user", content: userMessage, timestamp: new Date().toISOString() });
      await providePickupMoment(from, userMessage);
      await sendCartPaymentInstructions(from);
      return;
    }

    const currentHistory = await getHistory(from);
    const hasStartedConversation = currentHistory.some((entry) => entry.role !== "system");
    const INACTIVITY_MS = 24 * 60 * 60 * 1000;
    const lastMessage = [...currentHistory].reverse().find((entry) => entry.role !== "system");
    const lastTs = lastMessage?.timestamp ? new Date(lastMessage.timestamp).getTime() : null;
    const isNewSession = hasStartedConversation && lastTs && Date.now() - lastTs > INACTIVITY_MS;

    if (isNewSession) await deleteConversationHistory(from);

    const isFreshStart = !hasStartedConversation || isNewSession;
    let firstContactEntities = null;
    let firstContactUserRecorded = false;

    if (isFreshStart) {
      const opening = await loadOpeningMessage();
      await appendHistoryEntry(from, { role: "user", content: userMessage });
      firstContactUserRecorded = true;
      await appendHistoryEntry(from, { role: "assistant", content: opening });
      await sendWhatsappMessage(from, opening);

      try {
        firstContactEntities = extractClientEntities(userMessage);
        const simpleGreeting = /^(?:bonjour|bonsoir|salut|hello|coucou|bjr|bsr)[!.,\s]*$/i.test(String(userMessage || "").trim());
        if (simpleGreeting) return;
      } catch (err) {
        log.warn("Impossible d'extraire les entités du premier contact", err);
      }
    }

    const clientConnu = await getClient(from);
    const infos = firstContactEntities || extractClientEntities(userMessage);
    if (infos.name || infos.need) {
      await upsertClient(from, {
        ...(!clientConnu?.nom && infos.name ? { nom: infos.name } : {}),
        ...(infos.need ? { besoin: infos.need } : {}),
        updatedAt: new Date().toISOString(),
      });
    }

    const result = await handleClientMessage(from, userMessage, {
      client: clientConnu || {},
      skipUserHistory: firstContactUserRecorded || yesNoUserAlreadyRecorded,
      awaitingState,
    });

    if (result.type === "adresse_livraison") {
      await provideDeliveryAddress(from, result.adresse);
      await sendCartPaymentInstructions(from);
      return;
    }

    if (result.type === "nom_client") {
      const clientAvantNom = await getClient(from);
      if (!clientAvantNom?.nom && result.nom) await upsertClient(from, { nom: result.nom, updatedAt: new Date().toISOString() });
      await clearAwaitingClientName(from);
      await sendCartPaymentInstructions(from);
      return;
    }

    if (result.type === "compte_momo") {
      await provideMobileMoneyAccountInfo(from, `${result.numero}${result.nomCompte ? ` ${result.nomCompte}` : ""}`);
      return;
    }

    if (result.type === "abandon_panier") {
      if (result.confirmed) {
        await confirmCartAbandonment(from);
        await sendWhatsappMessage(from, "🧹 C'est confirmé. Votre panier a été vidé. Si vous changez d'avis, je reste à votre disposition.");
      } else {
        await cancelCartAbandonConfirmation(from);
        await sendWhatsappMessage(from, "D'accord, je conserve votre panier.");
      }
      return;
    }

    if (result.type === "confirmation_livraison") {
      await confirmDeliveryPhone(from, result.confirmed);
      return;
    }

    if (result.type === "paiement") {
      await requestPaymentConfirmation(from, userMessage);
      return;
    }

    if (result.type === "escalade") {
      await enqueueEscalation(from, userMessage, { category: result.categorie });
      return;
    }

    if (result.type === "voir_panier") {
      await sendWhatsappMessage(from, formatCart(from));
      return;
    }

    if (result.type === "valider_panier") {
      if (!getCart(from).length) await sendWhatsappMessage(from, "Votre panier est vide. Ajoutez d'abord un produit 😊");
      else await sendCartPaymentInstructions(from);
      return;
    }

    if (result.type === "fiche_produit") {
      const { produit } = result;
      const caption = formatFicheProduit(produit);
      if (produit.imageUrl) {
        try {
          await sendWhatsappImage(from, produit.imageUrl, caption);
          return;
        } catch (err) {
          log.error("Échec envoi image produit", { from, produit: produit.nom, err });
        }
      }
      await sendWhatsappMessage(from, caption);
      return;
    }

    if (result.type === "recommandation") {
      try {
        await sendProductRecommendations(from, result.produits);
      } catch (err) {
        log.error("Échec envoi recommandation", { from, err });
        await sendWhatsappMessage(from, "Désolé, une erreur est survenue lors de l'envoi de la recommandation. Un instant, je réessaie ou je vous transmets à un collaborateur.");
      }
      return;
    }

    let reply = result.text || "Je veux bien vous aider. Pouvez-vous m'en dire un peu plus ?";
    if (await isPending(from)) reply += "\n\nPar ailleurs, votre précédente demande est toujours en cours de traitement par notre collaborateur. Il ne va plus tarder.";
    await sendWhatsappMessage(from, reply);
  } catch (err) {
    log.error(`Échec du traitement du message de ${from}`, err);
    try {
      await sendWhatsappMessage(from, "Désolé, une erreur est survenue. Veuillez réessayer plus tard.");
    } catch (sendErr) {
      log.error("Échec message d'erreur de secours", sendErr);
    }
  }
});

export default router;