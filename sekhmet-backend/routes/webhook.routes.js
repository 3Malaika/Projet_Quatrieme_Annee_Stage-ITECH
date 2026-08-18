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
import { loadOpeningMessage } from "../data/openingMessage.store.js";
import { getClient, upsertClient } from "../data/clients.store.js";

const router = Router();

router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

router.post("/", async (req, res) => {
  res.sendStatus(200);

  const entry = req.body.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];
  if (!message) return;

  const from = message.from;
  const userMessage = message.text?.body;
  if (!userMessage) return;

  console.log(`Message de ${from}: ${userMessage}`);

  try {
    // 0. Message venant du collaborateur lui-même ? -> commande, pas une conversation client
    if (from === config.humanAgentNumber) {
      await handleHumanCommand(userMessage);
      return;
    }

    // 1. Tout premier contact de ce client ? On envoie le message d'accueil
    //    tel quel (texte intégral, garanti non tronqué/reformulé par le LLM)
    //    et on demande son nom + son besoin, sans traiter le reste ce tour-ci.
    if (!hasConversation(from)) {
      const history = getHistory(from); // crée la conversation (prompt système)
      const opening = loadOpeningMessage();
      history.push({ role: "assistant", content: opening });
      await sendWhatsappMessage(from, opening);
      return;
    }

    // 2. Le client est-il déjà identifié ? Sinon, on tente d'extraire son nom
    //    et son besoin depuis ce message, pour l'afficher dans l'interface.
    const clientConnu = getClient(from);
    if (!clientConnu?.nom) {
      const infos = await extractClientInfo(userMessage);
      if (infos.nom || infos.besoin) {
        upsertClient(from, {
          ...(infos.nom ? { nom: infos.nom } : {}),
          ...(infos.besoin ? { besoin: infos.besoin } : {}),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    // 3. Ce nouveau message déclenche-t-il lui-même une escalade obligatoire ?
    const categorie = await classifyMessage(userMessage);
    const categoriesEscalade = ["partenariat", "reclamation", "formation", "programme_alimentaire"];
    if (categoriesEscalade.includes(categorie)) {
      await enqueueEscalation(from, userMessage);
      return;
    }

    // 4. Sinon, réponse normale de l'IA — que le client ait ou non
    //    une escalade en attente par ailleurs (non bloquant).
    let reply = await askGroq(from, userMessage);

    if (isPending(from)) {
      reply +=
        "\n\n(Par ailleurs, votre précédente demande est toujours en cours de traitement par notre collaborateur, il ne va plus tarder.)";
    }

    await sendWhatsappMessage(from, reply);
  } catch (err) {
    console.error("Erreur:", err.message);
    await sendWhatsappMessage(from, "Désolé, une erreur est survenue. Veuillez réessayer plus tard.");
  }
});

export default router;
