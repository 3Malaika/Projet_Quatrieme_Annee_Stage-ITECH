import { Router } from "express";
import { config } from "../config/env.js";
import {
  handleClientMessage,
  hasConversation,
  getHistory,
  extractClientInfo,
  appendHistoryEntry,
} from "../services/chat.service.js";
import { sendWhatsappMessage, sendWhatsappImage } from "../services/whatsapp.service.js";
import {
  formatFicheProduit,
  parsePrixEnNombre,
  formatMontantFcfa,
} from "../services/catalogueFormatter.service.js";
import { sendProductRecommendations, parseQuantiteRowId } from "../services/recommendation.service.js";
import { enqueueEscalation, isPending } from "../services/escalation.service.js";
import { requestPaymentConfirmation, recordProductSelection } from "../services/payment.service.js";
import { handleHumanCommand } from "../utils/humanCommands.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("webhook");

// Bascule automatique JSON / Supabase — même pattern que les autres routes
const { loadOpeningMessage } = config.supabaseUrl
  ? await import("../data/configTextes.store.supabase.js")
  : await import("../data/openingMessage.store.js");

const { getClient, upsertClient } = config.supabaseUrl
  ? await import("../data/clients.store.supabase.js")
  : await import("../data/clients.store.js");

const { loadCatalogue } = config.supabaseUrl
  ? await import("../data/catalogue.store.supabase.js")
  : await import("../data/catalogue.store.js");

const { loadPaiementComptes } = config.supabaseUrl
  ? await import("../data/configTextes.store.supabase.js")
  : await import("../data/paiementCompte.store.js");

// Construit le message listant un ou plusieurs numéros de paiement.
function formatInfosPaiement(comptes) {
  if (!comptes || comptes.length === 0) {
    return "Un instant, je transmets votre demande à un collaborateur pour vous communiquer les informations de paiement 🙏";
  }
  if (comptes.length === 1) {
    const compte = comptes[0];
    return `Vous pouvez envoyer le paiement au numéro *${compte.numero}*${compte.nom ? ` (au nom de *${compte.nom}*)` : ""}. Dès que c'est fait, dites-le-moi ici pour que je vérifie la réception 🙏`;
  }
  const lignes = comptes
    .map((c) => `- *${c.numero}*${c.nom ? ` (au nom de *${c.nom}*)` : ""}`)
    .join("\n");
  return `Vous pouvez envoyer le paiement à l'un des numéros suivants :\n${lignes}\n\nDès que c'est fait, dites-le-moi ici pour que je vérifie la réception 🙏`;
}

// Après avoir choisi une quantité dans la liste interactive envoyée suite à
// une recommandation, on confirme le choix au client et on lui transmet
// directement les informations de paiement (numéro + nom configurés dans
// l'admin) — comme pour l'outil "envoyer_infos_paiement" côté LLM, rien
// n'est facturé/validé côté commande tant que le collaborateur n'a pas
// confirmé la réception du paiement (voir payment.service.js).
async function handleQuantitySelection(from, rowId) {
  const parsed = parseQuantiteRowId(rowId);
  if (!parsed) {
    log.warn("Réponse de liste interactive non reconnue — ignorée", { from, rowId });
    return;
  }

  const catalogue = await loadCatalogue();
  const produit = catalogue.find((p) => String(p.id) === String(parsed.produitId));
  if (!produit) {
    log.warn("Produit introuvable pour la sélection de quantité", { from, parsed });
    return;
  }

  const { quantite } = parsed;
  const prixUnitaire = parsePrixEnNombre(produit.prix);
  const total = prixUnitaire ? prixUnitaire * quantite : null;
  const ligneTotal = total ? ` = *${formatMontantFcfa(total)}*` : "";

  log.info("Quantité sélectionnée par le client", { from, produit: produit.nom, quantite, total });

  // Mémorisation structurée (produit + quantité + prix) en attente de la
  // confirmation de paiement — c'est cette donnée qui sera réellement
  // persistée dans la commande une fois /paiement_recu reçu (voir
  // confirmPayment() dans payment.service.js), plutôt qu'une simple trace
  // texte dans l'historique de conversation.
  await recordProductSelection(from, {
    produitId: produit.id,
    nom: produit.nom,
    quantite,
    prixUnitaire,
    total,
  });

  await appendHistoryEntry(from, {
    role: "user",
    content: `[Quantité choisie : ${quantite} x ${produit.nom}]`,
  });

  const comptes = await loadPaiementComptes();
  const infosPaiement = formatInfosPaiement(comptes);

  const confirmation = `Très bien, vous avez choisi : ${quantite} x *${produit.nom}*${ligneTotal}.\n\n${infosPaiement}`;

  await appendHistoryEntry(from, { role: "assistant", content: confirmation });
  await sendWhatsappMessage(from, confirmation);

  await sendWhatsappMessage(
    config.humanAgentNumber,
    `🛒 Choix de quantité par ${from} : ${quantite} x ${produit.nom}${total ? ` (${formatMontantFcfa(total)})` : ""}. En attente de son paiement.`
  );
}

const router = Router();

router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.verifyToken) {
    log.info("Vérification webhook réussie (handshake Meta)");
    res.status(200).send(challenge);
  } else {
    log.warn("Vérification webhook refusée — token invalide ou mode incorrect", {
      mode,
      tokenReçuLength: token?.length,
    });
    res.sendStatus(403);
  }
});

router.post("/", async (req, res) => {
  res.sendStatus(200);

  // Log brut systématique : ainsi, même si la suite ne reconnaît pas le
  // payload (ex: accusés de lecture, changement de format côté Meta), on
  // voit dans les logs que la requête est bien arrivée jusqu'ici.
  log.info("Webhook POST reçu", req.body);

  const entry = req.body.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];
  if (!message) {
    log.debug("Payload sans message exploitable (statut/accusé de lecture ?) — ignoré.");
    return;
  }

  const from = message.from;

  // Réponse à la liste interactive de quantité (envoyée après une
  // recommandation de produit) : traitement dédié, pas de passage par le LLM.
  const listReplyId = message.interactive?.list_reply?.id;
  if (message.type === "interactive" && listReplyId) {
    log.info("Réponse de liste interactive reçue", { from, listReplyId });
    try {
      await handleQuantitySelection(from, listReplyId);
    } catch (err) {
      log.error("Échec du traitement de la sélection de quantité", { from, err });
    }
    return;
  }

  const userMessage = message.text?.body;
  if (!userMessage) {
    log.warn("Message reçu sans texte exploitable (media, réaction, etc.)", { from, type: message.type });
    return;
  }

  log.info(`Message de ${from}`, { texte: userMessage });

  try {
    // 0. Message venant du collaborateur lui-même ? -> commande, pas une conversation client
    if (from === config.humanAgentNumber) {
      log.info("Commande du collaborateur détectée", { texte: userMessage });
      await handleHumanCommand(userMessage);
      return;
    }

    // 1. Tout premier contact de ce client ? On envoie le message d'accueil
    //    tel quel (texte intégral, garanti non tronqué/reformulé par le LLM)
    //    et on demande son nom + son besoin, sans traiter le reste ce tour-ci.
    if (!hasConversation(from)) {
      log.info("Premier contact — envoi du message d'accueil", { from });
      const history = await getHistory(from); // crée la conversation (prompt système)
      const opening = await loadOpeningMessage();
      history.push({ role: "assistant", content: opening });
      await sendWhatsappMessage(from, opening);
      return;
    }

    // 2. Le client est-il déjà identifié ? Sinon, on tente d'extraire son nom
    //    et son besoin depuis ce message, pour l'afficher dans l'interface.
    const clientConnu = await getClient(from);
    if (!clientConnu?.nom && !clientConnu?.besoin) {
      const infos = await extractClientInfo(userMessage, from);
      log.info("Extraction infos client", { from, infos });
      if (infos.nom || infos.besoin) {
        await upsertClient(from, {
          ...(infos.nom ? { nom: infos.nom } : {}),
          ...(infos.besoin ? { besoin: infos.besoin } : {}),
          updatedAt: new Date().toISOString(),
        });
      } else {
        // Nom et besoin toujours inconnus — on relance poliment sans passer au LLM
        log.info("Nom/besoin toujours inconnus — relance du client", { from });
        await sendWhatsappMessage(
          from,
          "Merci de votre message 😊 Avant de continuer, pourriez-vous nous indiquer :\n1️⃣ Votre prénom\n2️⃣ Votre besoin (formation, suivi alimentaire ou produits finis)\n\nCela nous permettra de mieux vous accompagner ✅"
        );
        return;
      }
    }

    // 3. Un seul appel Groq fait à la fois la classification (via function
    //    calling) et, le cas échéant, la réponse — voir handleClientMessage
    //    pour le détail de ce qui a changé par rapport à l'ancien duo
    //    classifyMessage() + askGroq().
    const result = await handleClientMessage(from, userMessage);

    if (result.type === "paiement") {
      log.info("Paiement signalé par le client", { from });
      await requestPaymentConfirmation(from, userMessage);
      return;
    }

    if (result.type === "escalade") {
      log.info("Escalade déclenchée", { from, categorie: result.categorie });
      await enqueueEscalation(from, userMessage);
      return;
    }

    if (result.type === "fiche_produit") {
      const { produit } = result;
      const caption = formatFicheProduit(produit);
      log.info("Envoi fiche produit", { from, produit: produit.nom, aPhoto: Boolean(produit.imageUrl) });

      if (produit.imageUrl) {
        try {
          await sendWhatsappImage(from, produit.imageUrl, caption);
          return;
        } catch (err) {
          // L'image peut échouer (lien invalide/inaccessible) sans faire
          // échouer toute la réponse : on bascule sur du texte, le client
          // doit quand même recevoir l'information produit.
          log.error("Échec envoi image produit — repli sur texte", { from, produit: produit.nom, err });
        }
      }

      await sendWhatsappMessage(from, caption);
      return;
    }

    if (result.type === "recommandation") {
      log.info("Envoi d'une recommandation de produits", {
        from,
        produits: result.produits.map((p) => p.nom),
      });
      try {
        await sendProductRecommendations(from, result.produits);
      } catch (err) {
        log.error("Échec envoi recommandation produits", { from, err });
        await sendWhatsappMessage(
          from,
          "Désolé, une erreur est survenue lors de l'envoi de la recommandation. Un instant, je réessaie ou vous transmets à un collaborateur."
        );
      }
      return;
    }

    // Sinon, réponse normale de l'IA — que le client ait ou non
    // une escalade en attente par ailleurs (non bloquant).
    let reply = result.text;
    log.info("Réponse Groq obtenue", { from, longueur: reply.length });

    if (isPending(from)) {
      reply +=
        "\n\n(Par ailleurs, votre précédente demande est toujours en cours de traitement par notre collaborateur, il ne va plus tarder.)";
    }

    await sendWhatsappMessage(from, reply);
    log.info("Réponse envoyée avec succès", { from });
  } catch (err) {
    log.error(`Échec du traitement du message de ${from}`, err);
    try {
      await sendWhatsappMessage(from, "Désolé, une erreur est survenue. Veuillez réessayer plus tard.");
    } catch (sendErr) {
      log.error("Échec de l'envoi du message d'erreur de secours", sendErr);
    }
  }
});

export default router;
