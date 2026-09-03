import { Router } from "express";
import { config } from "../config/env.js";
import {
  handleClientMessage,
  getHistory,
  appendHistoryEntry,
} from "../services/chat.service.js";
import { sendWhatsappMessage, sendWhatsappImage, sendWhatsappQuickOptions, sendWhatsappInteractiveList } from "../services/whatsapp.service.js";
import {
  formatFicheProduit,
  parsePrixEnNombre,
  formatMontantFcfa,
} from "../services/catalogueFormatter.service.js";
import { sendProductRecommendations, sendProductForCart, parseQuantiteRowId } from "../services/recommendation.service.js";
import { enqueueEscalation, isPending, isHumanAgentNumber, noteAgentResponse, noteHumanAgentInbound, handleWhatsappEscalationStatus, findClientByDeliveredMessageId } from "../services/escalation.service.js";
import {
  requestPaymentConfirmation,
  recordProductSelection,
  getCart,
  getCartTotal,
  formatCart,
  clearCart,
  isAwaitingCartAbandonConfirmation,
  requestCartAbandonConfirmation,
  cancelCartAbandonConfirmation,
  confirmCartAbandonment,
  confirmDeliveryPhone,
  isAwaitingPaymentAccountInfo,
  provideMobileMoneyAccountInfo,
  isAwaitingCartValidationConfirmation,
  requestCartValidationConfirmation,
  confirmCartValidation,
  isAwaitingDeliveryAddress,
  provideDeliveryAddress,
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

// Envoie obligatoirement le récapitulatif du panier + les modalités de
// paiement (numéro/compte configurés dans l'admin) dès que le client
// indique vouloir passer commande (bouton "Valider ma commande" ou
// commande texte équivalente). Avant ce correctif, cette étape appelait
// directement requestPaymentConfirmation(), qui répond "je vérifie la
// réception de votre paiement" — une phrase qui suppose à tort que le
// client a déjà payé, alors qu'il n'a jamais reçu le numéro à créditer.
// requestPaymentConfirmation() reste utilisée UNIQUEMENT plus tard, quand
// le client indique explicitement avoir effectué le paiement.
async function sendCartPaymentInstructions(from) {
  const comptes = await loadPaiementComptes();
  const message = `${formatCart(from)}\n\n${formatInfosPaiement(comptes)}`;
  await appendHistoryEntry(from, { role: "assistant", content: message });
  await sendWhatsappMessage(from, message);
}

// Étape ajoutée avant l'envoi des instructions de paiement : on montre le
// panier et on demande une confirmation explicite (oui/non) plutôt que de
// considérer que taper "valider" suffit — la cliente peut avoir cliqué le
// bouton par erreur ou vouloir encore ajouter un produit.
async function askCartValidationConfirmation(from) {
  const requested = await requestCartValidationConfirmation(from);
  if (!requested) {
    await sendWhatsappMessage(from, "Votre panier est vide. Ajoutez d'abord au moins un produit 😊");
    return;
  }
  const message = `${formatCart(from)}\n\nConfirmez-vous ce panier ? Répondez simplement *oui* ou *non*.`;
  await appendHistoryEntry(from, { role: "assistant", content: message });
  await sendWhatsappMessage(from, message);
}

// Après avoir choisi une quantité dans la liste interactive envoyée suite à
// une recommandation, on confirme le choix au client — comme pour l'outil
// "envoyer_infos_paiement" côté LLM, rien n'est facturé/validé côté
// commande tant que le collaborateur n'a pas confirmé la réception du
// paiement (voir payment.service.js).
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

function isPaymentVerificationMessage(message) {
  const t = String(message || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "'")
    .trim();
  if (!t) return false;
  // On ne déclenche jamais pour "je veux payer" / "comment payer".
  const verification = [
    /\bj'ai\s+(?:deja\s+)?paye\b/,
    /\bj'ai\s+(?:deja\s+)?effectue\s+(?:le\s+)?paiement\b/,
    /\bje\s+viens\s+de\s+payer\b/,
    /\bje\s+viens\s+d'effectuer\s+(?:le\s+)?paiement\b/,
    /\bpa[iy]ement\s+(?:effectue|fait|envoye|envoyer)\b/,
    /\bc'est\s+(?:bon\s+)?paye\b/,
    /\bc'est\s+fait\b.*\bpa[iy]e\b/,
    /\btransfert\s+(?:effectue|fait|envoye)\b/,
  ];
  return verification.some((re) => re.test(t));
}

function isHumanEscalationRequest(message) {
  const t = String(message || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  return [
    /parle[r]?\s+(?:a|avec)\s+(?:un\s+)?(?:conseiller|collaborateur|responsable|humain)/,
    /transmet(?:s|tre)?\s+(?:ma|mon)\s+(?:demande|message)\s+(?:a|au)\s+(?:un\s+)?(?:conseiller|collaborateur|responsable)/,
    /je\s+veux\s+(?:parler|echanger)\s+(?:avec|a)\s+(?:un\s+)?(?:humain|conseiller|collaborateur)/,
    /un\s+autre\s+assistant/,
  ].some((re) => re.test(t));
}

function extractClientEntities(message) {
  const raw = String(message || "").trim();
  const namePatterns = [
    /(?:moi c[’\']est|je m[’\']appelle|je m[’\']appele|je m[’\']appel|mon prénom est|mon prenom est|mon nom est|appelez[- ]moi|vous pouvez m[’\']appeler)\s+([A-Za-zÀ-ÖØ-öø-ÿ\' -]{2,40}?)(?=\s+(?:et|je|j[’\']ai|je cherche|je veux|j[’\']aimerais|j[’\']voudrais|pour)\b|[.!?,;:]|$)/i,
    /(?:nom|pr[ée]nom|prenon)\s*(?:est|[:=])\s*([A-Za-zÀ-ÖØ-öø-ÿ\' -]{2,40}?)(?=\s+(?:et|je|j[’\']ai|je cherche|je veux|pour)\b|[.!?,;:]|$)/i,
  ];
  let name = null;
  for (const re of namePatterns) {
    const m = raw.match(re);
    if (m?.[1]) { name = m[1].trim().replace(/[.!?,;:]+$/, ""); break; }
  }
  if (!name) {
    const naturalName = raw.match(/^([A-Za-zÀ-ÖØ-öø-ÿ\'’-]{2,30})\s*[,;-]\s*(?:je|j[’\']|moi)\b/i);
    if (naturalName?.[1]) name = naturalName[1].trim();
  }
  if (!name && /^[A-Za-zÀ-ÖØ-öø-ÿ\'’-]{2,40}(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ\'’-]{2,40})?$/.test(raw)) name = raw;

  const needPatterns = [
    /(?:mon besoin est|besoin\s*[:=]|je cherche|j[’\']aimerais|je voudrais|je veux|j[’\']ai besoin de|je souhaite)\s+(.{3,160})$/i,
    /(?:pour|concernant)\s+(.{3,120})$/i,
  ];
  let need = null;
  for (const re of needPatterns) {
    const m = raw.match(re);
    if (m?.[1]) { need = m[1].trim().replace(/[.!?]+$/, ""); break; }
  }
  if (!need) {
    const lower = raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    for (const token of ["formation", "suivi alimentaire", "produits finis", "produits", "catalogue", "commande"]) {
      if (lower.includes(token)) { need = token; break; }
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
        log.error("Erreur lors du traitement du statut WhatsApp d'une escalade", {
          messageId: status.id,
          error: err?.message || String(err),
        });
      }
    } else {
      log.debug("Payload sans message exploitable (statut/accusé de lecture ?) — ignoré.");
    }
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
        await askCartValidationConfirmation(from);
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
      // Le fait que le collaborateur écrive au numéro Business ouvre/rafraîchit
      // sa fenêtre WhatsApp de 24 h. On le mémorise AVANT tout traitement afin
      // que le prochain message d'escalade puisse être envoyé en texte libre.
      noteHumanAgentInbound(from);

      // Si le collaborateur répond en WhatsApp en taguant/citant un message
      // précis (notification d'escalade, relance de paiement...), WhatsApp
      // fournit son wamid dans message.context.id. On le résout tout de
      // suite en numéro client CERTAIN, plutôt que de laisser le message
      // partir "à l'aveugle" vers l'interprétation Groq qui doit alors
      // deviner via le montant/nom — et se rabat sur une réponse générique
      // quand plusieurs cas sont en cours en parallèle.
      const replyToMessageId = message.context?.id || null;
      const taggedClient = replyToMessageId ? await findClientByDeliveredMessageId(replyToMessageId) : null;
      log.info("Message entrant du collaborateur — fenêtre WhatsApp 24 h actualisée", {
        from, texte: userMessage, replyToMessageId, taggedClient,
      });
      await handleHumanCommand(userMessage, from, { taggedClient });
      return;
    }

    const normalizedText = String(userMessage || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();

    // Le client répond à notre relance lui demandant le numéro (et le nom)
    // du compte Mobile Money utilisé pour payer. Traité en priorité, avant
    // tout autre routage déterministe ou appel Groq, car tant que cette
    // info n'est pas obtenue aucune escalade de paiement n'a été envoyée
    // au collaborateur pour ce client.
    if (isAwaitingPaymentAccountInfo(from)) {
      await provideMobileMoneyAccountInfo(from, userMessage);
      return;
    }

    // Confirmation d'abandon : toujours traitée avant tout autre « oui/non ».
    // Un « oui » ici ne doit jamais être interprété comme une confirmation de
    // livraison ou une autre action.
    if (isAwaitingCartAbandonConfirmation(from)) {
      if (/^(oui|oui merci|confirme|je confirme|d'accord|daccord|ok|okay|yes)$/.test(normalizedText)) {
        await confirmCartAbandonment(from);
        await sendWhatsappMessage(from, "🧹 C'est confirmé. Votre panier a été vidé. Si vous changez d'avis, je reste à votre disposition.");
        return;
      }
      if (/^(non|non merci|garde|garder|pas maintenant)$/.test(normalizedText)) {
        await cancelCartAbandonConfirmation(from);
        await sendWhatsappMessage(from, "D'accord, je conserve votre panier.");
        return;
      }
      await sendWhatsappMessage(from, "Souhaitez-vous vraiment abandonner votre panier ? Répondez simplement oui ou non.");
      return;
    }

    // Confirmation explicite du panier avant de passer à l'adresse puis au
    // paiement. Traitée avant tout autre "oui/non" pour ne jamais être
    // confondue avec une autre confirmation en attente.
    if (isAwaitingCartValidationConfirmation(from)) {
      if (/^(oui|oui merci|confirme|je confirme|d'accord|daccord|ok|okay|yes)$/.test(normalizedText)) {
        await confirmCartValidation(from, true);
        await sendWhatsappMessage(
          from,
          "Parfait 👍 Pour organiser la livraison, merci de m'indiquer votre adresse (quartier, repère/point connu, ville) 📍"
        );
        return;
      }
      if (/^(non|non merci|annule|annuler|pas maintenant)$/.test(normalizedText)) {
        await confirmCartValidation(from, false);
        await sendWhatsappMessage(from, "D'accord, votre panier reste inchangé. Dites-moi quand vous êtes prête à valider 😊");
        return;
      }
      await sendWhatsappMessage(from, "Confirmez-vous ce panier ? Répondez simplement oui ou non.");
      return;
    }

    // Adresse de livraison — obligatoire avant d'envoyer les instructions de
    // paiement, sinon ni l'adresse de destination ni le délai estimé par le
    // collaborateur ne peuvent être déterminés.
    if (isAwaitingDeliveryAddress(from)) {
      const saved = await provideDeliveryAddress(from, userMessage);
      if (!saved) {
        await sendWhatsappMessage(
          from,
          "Je n'ai pas bien compris l'adresse. Pouvez-vous préciser le quartier et un repère connu (ex : \"Bastos, derrière la pharmacie X, Yaoundé\") ?"
        );
        return;
      }
      await sendCartPaymentInstructions(from);
      return;
    }

    // 1. Premier contact : on se base sur l'historique PERSISTÉ, pas sur
    //    un simple booléen en mémoire. Cela évite que chaque nouveau webhook
    //    (ou un redémarrage Render) renvoie le message d'accueil comme si la
    //    cliente n'avait jamais écrit.
    //
    //    Le message d'accueil est bien envoyé en premier, conformément au
    //    parcours, mais la demande actuelle n'est PAS jetée : si la cliente
    //    a déjà donné son nom/besoin dans ce premier message, on peut continuer
    //    naturellement ; sinon on lui demande uniquement l'information manquante.
    const currentHistory = await getHistory(from);
    const hasStartedConversation = currentHistory.some((m) => m.role !== "system");
    let firstContactEntities = null;
    let firstContactUserRecorded = false;
    if (!hasStartedConversation) {
      log.info("Premier contact — envoi du message d'accueil", { from });
      const opening = await loadOpeningMessage();
      await appendHistoryEntry(from, { role: "user", content: userMessage });
      firstContactUserRecorded = true;
      await appendHistoryEntry(from, { role: "assistant", content: opening });
      await sendWhatsappMessage(from, opening);

      try {
        const cfg = await botConfigStore.loadBotConfig();
        firstContactEntities = extractClientEntities(userMessage);
        const simpleGreeting = /^(?:bonjour|bonsoir|salut|hello|coucou|bjr|bsr)[!.,\s]*$/i.test(String(userMessage || "").trim());
        const q = cfg.parcours?.quickOptions;
        const shouldShow = q?.enabled && (q.afterSimpleGreetingOnly ? simpleGreeting : true);
        if (shouldShow) {
          const delay = Math.max(0, Number(q.afterGreetingDelaySeconds) || 0) * 1000;
          if (delay) setTimeout(() => sendConfiguredQuickOptions(from).catch(() => {}), delay);
          else await sendConfiguredQuickOptions(from);
        }

        // Pour une simple salutation, le message d'accueil est déjà la
        // réponse attendue. Pour toute autre demande, on continue le même
        // tour afin de ne jamais perdre le besoin exprimé.
        if (simpleGreeting) return;
      } catch (err) {
        log.warn("Impossible d'appliquer le parcours configurable au premier contact", err);
      }
    }

    // 2. Ne bloque jamais la conversation avant Groq sur le simple fait que
    // le nom ou le besoin manque. Groq est le moteur conversationnel principal
    // et doit pouvoir comprendre une phrase naturelle contenant plusieurs
    // informations, en demander uniquement ce qui manque et tenir compte de
    // l'historique. On conserve seulement l'enregistrement des informations
    // explicitement détectables afin de stabiliser le contexte client.
    const clientConnu = await getClient(from);
    const infos = firstContactEntities || extractClientEntities(userMessage);

    if (infos.name || infos.need) {
      await upsertClient(from, {
        ...(!clientConnu?.nom && infos.name ? { nom: infos.name } : {}),
        ...(infos.need ? { besoin: infos.need } : {}),
        updatedAt: new Date().toISOString(),
      });
    }

    // 3. Commandes panier explicites : aucun appel LLM inutile.
    // Elles permettent de piloter le panier même lorsque le client préfère
    // écrire plutôt que toucher à la liste interactive WhatsApp.
    const deliveryConfirmation = /^(oui|oui merci|c'est bon|c est bon|yes|d'accord|daccord|ok|okay)$/i.test(normalizedText);
    const deliveryRefusal = /^(non|non merci|pas ce numero|pas ce numéro|mauvais numero|mauvais numéro)$/i.test(normalizedText);
    if (deliveryConfirmation || deliveryRefusal) {
      const handled = await confirmDeliveryPhone(from, deliveryConfirmation);
      if (handled || deliveryRefusal) return;
    }

    if (/^(panier|voir mon panier|mon panier|afficher mon panier)$/.test(normalizedText)) {
      await sendWhatsappMessage(from, formatCart(from));
      return;
    }
    // L'abandon naturel est désormais compris par Groq. On ne supprime jamais
    // le panier directement à partir d'une phrase utilisateur.
    if (/^(vider|vider le panier|annuler le panier)$/.test(normalizedText)) {
      const requested = await requestCartAbandonConfirmation(from);
      await sendWhatsappMessage(from, requested
        ? "Voulez-vous vraiment vider votre panier ? Répondez simplement oui ou non."
        : "Votre panier est déjà vide.");
      return;
    }
    if (/^(valider|valider la commande|confirmer|confirmer la commande|passer commande)$/.test(normalizedText)) {
      if (!getCart(from).length) {
        await sendWhatsappMessage(from, "Votre panier est vide. Ajoutez d'abord un produit 😊");
      } else {
        await askCartValidationConfirmation(from);
      }
      return;
    }

    // 4. Vérifications sensibles : on ne laisse pas un appel Groq décider
    //    seul d'une étape qui déclenche une opération métier. Le langage reste
    //    libre, mais les formulations explicites "j'ai payé" / "paiement
    //    effectué" sont routées directement vers la vérification humaine.
    if (isPaymentVerificationMessage(userMessage)) {
      log.info("Paiement explicitement signalé — vérification humaine directe", { from });
      await requestPaymentConfirmation(from, userMessage);
      return;
    }

    // Même principe pour une demande explicite de collaborateur. Cela évite
    // qu'un appel de function-calling mal formé de Groq puisse bloquer une
    // demande d'escalade pourtant parfaitement claire.
    if (isHumanEscalationRequest(userMessage)) {
      log.info("Demande explicite de collaborateur — escalade directe", { from });
      await enqueueEscalation(from, userMessage);
      return;
    }

    // 5. Groq reste le moteur conversationnel principal : compréhension du
    //    message, prise en compte du contexte récent et choix éventuel d'une
    //    action métier via function calling. Les contrôles déterministes
    //    restent limités aux opérations sensibles et parfaitement explicites.
    const result = await handleClientMessage(from, userMessage, {
      client: clientConnu || {},
      skipUserHistory: firstContactUserRecorded,
    });

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

    if (await isPending(from)) {
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