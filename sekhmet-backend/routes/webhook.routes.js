import { Router } from "express";
import { config } from "../config/env.js";
import {
  askGroq,
  classifyMessage,
  hasConversation,
  getHistory,
  extractClientInfo,
} from "../services/chat.service.js";
import { sendWhatsappMessage } from "../services/whatsapp.service.js";
import { enqueueEscalation, isPending } from "../services/escalation.service.js";
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
    if (!clientConnu?.nom) {
      const infos = await extractClientInfo(userMessage);
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

    // 3. Ce nouveau message déclenche-t-il lui-même une escalade obligatoire ?
    const categorie = await classifyMessage(userMessage);
    log.info("Message classifié", { from, categorie });
    const categoriesEscalade = ["partenariat", "reclamation", "formation", "programme_alimentaire"];
    if (categoriesEscalade.includes(categorie)) {
      log.info("Escalade déclenchée", { from, categorie });
      await enqueueEscalation(from, userMessage);
      return;
    }

    // 4. Sinon, réponse normale de l'IA — que le client ait ou non
    //    une escalade en attente par ailleurs (non bloquant).
    let reply = await askGroq(from, userMessage);
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
