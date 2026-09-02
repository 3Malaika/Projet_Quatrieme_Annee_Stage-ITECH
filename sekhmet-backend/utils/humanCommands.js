import { config } from "../config/env.js";
import { sendWhatsappMessage } from "../services/whatsapp.service.js";
import { clearPending, closeEscalationLog } from "../services/escalation.service.js";
import { confirmPayment, rejectPayment, provideDeliveryDelay, findPendingDeliveryClient, getPendingPaymentClients } from "../services/payment.service.js";
import { createLogger } from "./logger.js";

const log = createLogger("humanCommands");

function normalizeHumanText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhone(value) {
  let phone = String(value || "").replace(/[^0-9+]/g, "");
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.startsWith("+")) phone = phone.slice(1);
  return phone;
}

function extractFreeFormPaymentConfirmation(text) {
  const raw = String(text || "").trim();
  const normalized = normalizeHumanText(raw);
  if (!/(recu|reçu|paiement.*recu|paiement.*reçu|encaisse|versement)/i.test(normalized)) return null;

  const phoneCandidates = [...raw.matchAll(/(?:\+|00)?237[\s.-]?[0-9]{8}/g)].map(m => normalizePhone(m[0]));
  const clientNumber = phoneCandidates[0] || null;

  const amountMatch = raw.match(/(?:montant|somme)\s*(?:de|est|:)\s*([0-9][0-9\s.,]{1,12})\s*(?:fcfa|f\s*cfa|xaf)\b/i)
    || raw.match(/\b([0-9][0-9\s.,]{1,12})\s*(?:fcfa|f\s*cfa|xaf)\b/i)
    || raw.match(/\bpour\s+([0-9][0-9\s.,]{1,12})(?:\s+fcfa)?\b/i);
  let montant = null;
  const amountRaw = amountMatch?.[1];
  if (amountRaw) {
    const digits = amountRaw.replace(/[^0-9]/g, "");
    if (digits) montant = Number(digits);
  }

  const accountPatterns = [
    /(?:sur|dans|via|avec)\s+le\s+compte\s+(?:de\s+)?([^,.;\n]+?)(?=\s+(?:pour|de|montant|client|numero|n°)\b|$)/i,
    /(?:compte|nom du compte)\s*[:=]\s*([^,.;\n]+)/i,
    /(?:au nom de|au nom du compte)\s*[:=]?\s*([^,.;\n]+)/i,
  ];
  let nomCompte = null;
  for (const re of accountPatterns) {
    const m = raw.match(re);
    if (m?.[1]) { nomCompte = m[1].trim(); break; }
  }

  // Évite de prendre une phrase entière comme nom de compte.
  if (nomCompte) {
    nomCompte = nomCompte
      .replace(/\b(fcfa|xaf)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (nomCompte.length < 2 || /^(le|la|un|une|paiement|montant)$/i.test(nomCompte)) nomCompte = null;
  }

  return { clientNumber, montant, nomCompte, raw };
}


export async function handleHumanCommand(text, senderNumber = config.humanAgentNumber) {
  const trimmed = text.trim();

  const parts = trimmed.split(" ");
  const command = parts[0];

  // Les réponses naturelles du collaborateur sont traitées AVANT le flux
  // des commandes slash. Sinon un message comme « j'ai reçu le paiement... »
  // était rejeté immédiatement et le parseur naturel n'était jamais atteint.
  if (!trimmed.startsWith("/")) {
    // Après une demande de précision du bot, le collaborateur peut simplement
    // répondre « compte de Jean », « au nom de Marie », etc. Si un seul
    // paiement est en attente, on rattache cette réponse à ce paiement.
    const pending = getPendingPaymentClients();
    const accountOnly = trimmed.match(/^(?:compte(?: au nom de)?|nom du compte|au nom de|sur le compte)\s*[:=]?\s*(.+)$/i);
    if (accountOnly && pending.length === 1) {
      const p = pending[0];
      const nomCompte = accountOnly[1].trim();
      try {
        await confirmPayment(p.phone, undefined, undefined, nomCompte);
        await sendWhatsappMessage(senderNumber, `✅ Compte « ${nomCompte} » enregistré pour ${p.phone}. Le paiement est confirmé et la commande est lancée.`);
      } catch (err) {
        await sendWhatsappMessage(senderNumber, `⚠️ Je n'ai pas pu finaliser la commande pour ${p.phone} : ${err.message}`);
      }
      return;
    }

    // Compréhension déterministe des confirmations de paiement exprimées
    // en langage naturel. Cette étape doit rester avant tout fallback.
    const confirmation = extractFreeFormPaymentConfirmation(trimmed);
    if (confirmation) {
      const { clientNumber, montant, nomCompte } = confirmation;
      if (!clientNumber) {
        await sendWhatsappMessage(senderNumber, "J'ai bien compris qu'un paiement a été reçu. Pouvez-vous me préciser le numéro WhatsApp du client concerné ?");
        return;
      }
      if (!montant || !Number.isFinite(montant) || montant <= 0) {
        await sendWhatsappMessage(senderNumber, `Paiement reçu pour ${clientNumber}. Quel montant avez-vous reçu (en FCFA) ?`);
        return;
      }
      if (!nomCompte) {
        await sendWhatsappMessage(senderNumber, `Paiement de ${clientNumber} pour ${montant} FCFA bien identifié. Quel est le nom du compte ayant effectué le paiement ?`);
        return;
      }
      try {
        await confirmPayment(clientNumber, montant, undefined, nomCompte);
        await sendWhatsappMessage(senderNumber, `✅ Paiement confirmé pour ${clientNumber} — ${montant} FCFA — compte : ${nomCompte}. La commande est enregistrée. Je vais maintenant demander le délai de livraison.`);
      } catch (err) {
        log.error("Échec de l'interprétation d'une confirmation de paiement libre", { clientNumber, montant, nomCompte, err });
        await sendWhatsappMessage(senderNumber, `⚠️ Je n'ai pas pu finaliser le paiement pour ${clientNumber} : ${err.message}`);
      }
      return;
    }

    await sendWhatsappMessage(senderNumber, "Je n'ai pas reconnu cette réponse. Vous pouvez confirmer naturellement, par exemple : « J'ai reçu le paiement de 237696784809 pour 1500 FCFA sur le compte de Jean ».");
    return;
  }

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
    const rawAfterAmount = parts.slice(montant !== undefined ? 3 : 2).join(" ");
    // Avec la commande explicite, le dernier argument peut être le nom du compte.
    // On retire « compte: ... » de la description des produits pour ne jamais
    // enregistrer ce texte comme produit.
    const compteMatch = rawAfterAmount.match(/(?:^|\s)(?:compte|nom du compte)\s*[:=]\s*(.+)$/i);
    const nomCompte = compteMatch?.[1]?.trim() || null;
    const produitsDescription = (compteMatch ? rawAfterAmount.slice(0, compteMatch.index).trim() : rawAfterAmount).trim() || undefined;
    if (!clientNumber || (montant !== undefined && (!Number.isFinite(montant) || montant <= 0))) {
      log.warn("/paiement_recu appelée avec un format invalide", { clientNumber, montant });
      await sendWhatsappMessage(
        senderNumber,
        "Format: /paiement_recu <numero> [montant] [description des produits] compte: <nom du compte>\n(Le nom du compte est obligatoire avant la création de la commande.)"
      );
      return;
    }
    try {
      await confirmPayment(clientNumber, montant, produitsDescription, nomCompte);
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
    const candidate = parts[1] || "";
    const looksLikePhone = /^(?:\+|00)?[0-9]{8,15}$/.test(candidate.replace(/[^0-9+]/g, ""));
    const clientNumber = looksLikePhone ? candidate.replace(/[^0-9+]/g, "") : findPendingDeliveryClient();
    const delaiText = looksLikePhone ? parts.slice(2).join(" ") : parts.slice(1).join(" ");
    if (!clientNumber || !delaiText) {
      log.warn("/delai appelée sans cible déterminable", { clientNumber, delaiText });
      await sendWhatsappMessage(senderNumber, clientNumber
        ? "Format: /delai <texte>"
        : "Plusieurs livraisons sont en attente. Utilisez /delai <numero> <texte> pour préciser le client.");
      return;
    }
    await provideDeliveryDelay(clientNumber, delaiText);
    return;
  }
  if (command === "/aide") {
    await sendWhatsappMessage(
      senderNumber,
      "Commandes disponibles:\n/resolu <numero>\n/repondre <numero> <message>\n/paiement_recu <numero> [montant] [description produits] compte: <nom du compte>\n/paiement_refuse <numero> [raison]\n/delai <texte> (si un seul paiement attend le délai) ou /delai <numero> <texte>"
    );
    return;
  }

  log.warn("Commande inconnue reçue du collaborateur", { command });
  await sendWhatsappMessage(
    senderNumber,
    "Commande non reconnue. Envoyez /aide pour voir la liste des commandes disponibles."
  );
}
