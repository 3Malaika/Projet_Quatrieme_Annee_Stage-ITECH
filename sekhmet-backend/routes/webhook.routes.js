import { Router } from "express";
import { config } from "../config/env.js";
import {
  handleClientMessage,
  hasConversation,
  getHistory,
  extractClientInfo,
  appendHistoryEntry,
} from "../services/chat.service.js";
import { analyzeLocalMessage } from "../services/localNlp.service.js";
import { sendWhatsappMessage, sendWhatsappImage, sendWhatsappQuickOptions, sendWhatsappInteractiveList } from "../services/whatsapp.service.js";
import {
  formatFicheProduit,
  parsePrixEnNombre,
  formatMontantFcfa,
} from "../services/catalogueFormatter.service.js";
import { sendProductRecommendations, sendProductForCart, parseQuantiteRowId } from "../services/recommendation.service.js";
import { enqueueEscalation, isPending, isHumanAgentNumber, noteAgentResponse } from "../services/escalation.service.js";
import {
  requestPaymentConfirmation,
  recordProductSelection,
  getCart,
  getCartTotal,
  formatCart,
  clearCart,
} from "../services/payment.service.js";
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

const botConfigStore = config.supabaseUrl
  ? await import("../data/botConfig.store.supabase.js")
  : await import("../data/botConfig.store.js");

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

  const cartText = formatCart(from);
  const confirmation = `✅ ${quantite} x *${produit.nom}* ajouté au panier.\n\n${cartText}`;

  await appendHistoryEntry(from, { role: "assistant", content: confirmation });
  await sendWhatsappMessage(from, confirmation);

  // Aucun paiement n'est demandé ici : le client peut ajouter plusieurs
  // produits différents avant de valider le panier.
  await sendWhatsappInteractiveList(from, {
    body: "Que souhaitez-vous faire avec votre panier ?",
    footer: "Vous pouvez aussi écrire le nom d'un autre produit.",
    buttonText: "Panier",
    sections: [{
      title: "Commande",
      rows: [
        { id: "cart::add", title: "Ajouter un produit" },
        { id: "cart::view", title: "Voir mon panier" },
        { id: "cart::validate", title: "Valider ma commande" },
        { id: "cart::clear", title: "Vider le panier" },
      ],
    }],
  });
}

async function sendConfiguredQuickOptions(from) {
  try {
    const cfg = await botConfigStore.loadBotConfig();
    const q = cfg.parcours?.quickOptions;
    if (!q?.enabled) return;
    await sendWhatsappQuickOptions(from, [
      { id: "quick::catalogue", title: "Voir le catalogue" },
      { id: "quick::order", title: "Commander" },
      { id: "quick::human", title: "Parler à un conseiller" },
    ]);
  } catch (err) { log.warn("Options rapides non envoyées", err); }
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

  // Les stickers sont des messages WhatsApp valides mais ne possèdent pas
  // de champ text.body. On les conserve explicitement dans l'historique au
  // lieu de les traiter comme des messages perdus/inexploitables. Ils restent
  // donc visibles dans l'admin et n'interrompent jamais le parcours client.
  if (message.type === "sticker") {
    const stickerId = message.sticker?.id || null;
    const stickerAnimated = message.sticker?.animated ? " animé" : "";
    log.info("Sticker WhatsApp reçu — conservation dans la conversation", {
      from, stickerId, animated: Boolean(message.sticker?.animated),
    });
    await appendHistoryEntry(from, {
      role: "user",
      content: `[Sticker WhatsApp${stickerAnimated}${stickerId ? ` — ${stickerId}` : ""}]`,
      type: "sticker",
      mediaId: stickerId,
    });
    // On ne force pas le LLM à inventer une interprétation du sticker.
    // Le sticker est conservé et le client peut poursuivre naturellement.
    return;
  }

  // Réponse à la liste interactive de quantité (envoyée après une
  // recommandation de produit) : traitement dédié, pas de passage par le LLM.
  const listReplyId = message.interactive?.list_reply?.id;
  if (message.type === "interactive" && listReplyId) {
    log.info("Réponse de liste interactive reçue", { from, listReplyId });
    try {
      if (listReplyId === "quick::catalogue") {
        await sendWhatsappMessage(from, "Je vais vous présenter notre catalogue. Si vous cherchez quelque chose de précis, dites-moi simplement votre besoin.");
        return;
      }
      if (listReplyId === "quick::order") {
        await sendWhatsappMessage(from, "Avec plaisir 😊 Pour commencer la commande, j'ai besoin de votre nom et de ce que vous recherchez.");
        return;
      }
      if (listReplyId === "quick::human") {
        await enqueueEscalation(from, "Demande de contact humain via les options rapides");
        return;
      }
      if (listReplyId === "cart::add") {
        await sendWhatsappMessage(from, "Bien sûr 😊 Écrivez simplement le nom du produit que vous souhaitez ajouter au panier, ou dites-moi ce que vous recherchez.");
        return;
      }
      if (listReplyId === "cart::view") {
        const cart = getCart(from);
        if (!cart.length) {
          await sendWhatsappMessage(from, "Votre panier est vide. Dites-moi quel produit vous souhaitez ajouter 😊");
          return;
        }
        await sendWhatsappMessage(from, formatCart(from));
        return;
      }
      if (listReplyId === "cart::clear") {
        await clearCart(from);
        await sendWhatsappMessage(from, "🧹 Votre panier a été vidé. Vous pouvez recommencer votre sélection quand vous le souhaitez.");
        return;
      }
      if (listReplyId === "cart::validate") {
        if (!getCart(from).length) {
          await sendWhatsappMessage(from, "Votre panier est vide. Ajoutez d'abord au moins un produit 😊");
          return;
        }
        await requestPaymentConfirmation(from, `Validation du panier : ${formatCart(from)}`);
        return;
      }
      await handleQuantitySelection(from, listReplyId);
    } catch (err) {
      log.error("Échec du traitement de la sélection interactive", { from, err });
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
    if (await isHumanAgentNumber(from)) {
      log.info("Commande du collaborateur détectée", { texte: userMessage });
      await handleHumanCommand(userMessage, from);
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
      try {
        const cfg = await botConfigStore.loadBotConfig();
        const analysis = await analyzeLocalMessage(userMessage);
        const simpleGreeting = analysis.intent === "greeting" && analysis.confidence >= 0.70;
        const q = cfg.parcours?.quickOptions;
        const shouldShow = q?.enabled && (q.afterSimpleGreetingOnly ? simpleGreeting : true);
        if (shouldShow) {
          const delay = Math.max(0, Number(q.afterGreetingDelaySeconds) || 0) * 1000;
          if (delay) setTimeout(() => sendConfiguredQuickOptions(from).catch(() => {}), delay);
          else await sendConfiguredQuickOptions(from);
        }
      } catch (err) { log.warn("Impossible d'appliquer le parcours configurable au premier contact", err); }
      return;
    }

    // 2. Le nom ET le besoin doivent être connus avant d'avancer dans la
    // procédure commerciale. L'extraction est locale : aucune consommation
    // Groq pour identifier une information explicite donnée par le client.
    const clientConnu = await getClient(from);
    const infos = await extractClientInfo(userMessage, from);
    const nom = clientConnu?.nom || infos.nom;
    const besoin = clientConnu?.besoin || infos.besoin;

    if (infos.nom || infos.besoin) {
      await upsertClient(from, {
        ...(infos.nom ? { nom: infos.nom } : {}),
        ...(infos.besoin ? { besoin: infos.besoin } : {}),
        updatedAt: new Date().toISOString(),
      });
    }

    const required = (await botConfigStore.loadBotConfig()).parcours?.requiredBeforeOrder || { name: true, need: true };
    const missingName = required.name !== false && !nom;
    const missingNeed = required.need !== false && !besoin;
    if (missingName || missingNeed) {
      const demande = missingName && missingNeed
        ? "Pour commencer 😊 pourriez-vous m'indiquer votre prénom et ce que vous recherchez (formation, suivi alimentaire ou produits finis) ?"
        : missingName
          ? "Merci 😊 Et comment puis-je vous appeler ?"
          : "Merci 😊 Et quel est votre besoin : formation, suivi alimentaire ou produits finis ?";
      await sendWhatsappMessage(from, demande);
      return;
    }

    // 3. Commandes panier explicites : aucun appel LLM inutile.
    // Elles permettent de piloter le panier même lorsque le client préfère
    // écrire plutôt que toucher à la liste interactive WhatsApp.
    const normalizedText = String(userMessage || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\\u0300-\\u036f]/g, "")
      .trim();

    if (/^(panier|voir mon panier|mon panier|afficher mon panier)$/.test(normalizedText)) {
      await sendWhatsappMessage(from, formatCart(from));
      return;
    }
    if (/^(vider|vider le panier|annuler le panier)$/.test(normalizedText)) {
      await clearCart(from);
      await sendWhatsappMessage(from, "🧹 Votre panier a été vidé.");
      return;
    }
    if (/^(valider|valider la commande|confirmer|confirmer la commande|passer commande)$/.test(normalizedText)) {
      if (!getCart(from).length) {
        await sendWhatsappMessage(from, "Votre panier est vide. Ajoutez d'abord un produit 😊");
      } else {
        await requestPaymentConfirmation(from, `Validation du panier : ${formatCart(from)}`);
      }
      return;
    }

    // 4. Un seul appel Groq fait à la fois la classification (via function
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

    if (result.type === "ajout_panier") {
      const { produit } = result;
      log.info("Produit demandé explicitement pour ajout au panier", { from, produit: produit.nom });
      try {
        await sendProductForCart(from, produit);
      } catch (err) {
        log.error("Échec présentation du produit à ajouter au panier", { from, produit: produit.nom, err });
        await sendWhatsappMessage(from, "Je n'arrive pas à afficher ce produit pour le moment. Vous pouvez réessayer dans un instant 🙏");
      }
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
