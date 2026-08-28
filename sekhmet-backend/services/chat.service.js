import Groq from "groq-sdk";
import { config } from "../config/env.js";
import { buildSystemPrompt } from "./systemPrompt.service.js";
import {
  formatCatalogueComplet,
  isDemandeCatalogueComplet,
  trouverProduitParNom,
  formatFicheProduit,
} from "./catalogueFormatter.service.js";
import { recordUsage } from "./usage.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("chat.service");
const groq = new Groq({ apiKey: config.groqApiKey });

// Sélection dynamique des stores selon l'environnement
const clientsStore = config.supabaseUrl
  ? await import("../data/clients.store.supabase.js")
  : await import("../data/clients.store.js");

const convStore = config.supabaseUrl
  ? await import("../data/conversations.store.supabase.js")
  : await import("../data/conversations.store.js");

// Bug corrigé : loadCatalogue pointait toujours vers le fichier local,
// même en mode Supabase (donc jamais synchro avec l'admin en prod).
const catalogueStore = config.supabaseUrl
  ? await import("../data/catalogue.store.supabase.js")
  : await import("../data/catalogue.store.js");

// Cache en mémoire des conversations (peuplé au démarrage)
const conversations = sanitizeAllHistories(await convStore.loadConversations());
log.info(`Conversations chargées au démarrage`, { total: Object.keys(conversations).length });

// Filet de sécurité : Groq rejette tout message dont `content` n'est pas une
// chaîne (ou un tableau). Une conversation stockée avant un correctif
// antérieur peut contenir un message corrompu (ex: une Promise sérialisée
// en objet vide) qui replanterait sinon TOUS les appels futurs pour ce
// client, indéfiniment. On répare/écarte ces messages au chargement.
function sanitizeMessage(m) {
  if (typeof m?.content === "string") return m;
  if (Array.isArray(m?.content)) return m;
  log.warn("Message d'historique corrompu ignoré (content invalide)", {
    role: m?.role,
    content: m?.content,
  });
  return null;
}

function sanitizeHistory(history) {
  return (history || []).map(sanitizeMessage).filter(Boolean);
}

function sanitizeAllHistories(allConversations) {
  const cleaned = {};
  for (const [phone, history] of Object.entries(allConversations)) {
    cleaned[phone] = sanitizeHistory(history);
  }
  return cleaned;
}

// Async car buildSystemPrompt() lit potentiellement le catalogue/bienfaits/
// procédures depuis Supabase. Tous les appelants doivent l'attendre (await).
export async function getHistory(phoneNumber) {
  if (!conversations[phoneNumber]) {
    conversations[phoneNumber] = [
      { role: "system", content: await buildSystemPrompt() },
    ];
    // Persistance asynchrone — on ne bloque pas l'exécution
    convStore.saveConversations(conversations).catch((e) =>
      log.error("Erreur sauvegarde conversation (nouvelle)", e)
    );
  }
  return conversations[phoneNumber];
}

export function hasConversation(phoneNumber) {
  return !!conversations[phoneNumber];
}

export async function getAllConversations() {
  const clients = await clientsStore.loadClients();
  return Object.entries(conversations).map(([phone, history]) => ({
    phone,
    nom: clients[phone]?.nom || null,
    besoin: clients[phone]?.besoin || null,
    messageCount: history.filter((m) => m.role !== "system").length,
    lastMessage: [...history].reverse().find((m) => m.role !== "system")?.content || null,
  }));
}

export async function getConversation(phoneNumber) {
  const clients = await clientsStore.loadClients();
  return {
    phone: phoneNumber,
    nom: clients[phoneNumber]?.nom || null,
    besoin: clients[phoneNumber]?.besoin || null,
    besoinsHistorique: clients[phoneNumber]?.besoinsHistorique || [],
    messages: conversations[phoneNumber]?.filter((m) => m.role !== "system") || [],
  };
}

// Parse un JSON renvoyé par le LLM, en tolérant les blocs markdown
// (```json ... ```) que certains modèles ajoutent malgré la consigne.
function parseJsonReply(raw, context) {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    log.error(`Réponse LLM non-JSON reçue pour ${context}`, { raw });
    throw err;
  }
}

export async function extractClientInfo(userMessage, phoneNumber) {
  try {
    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      // openai/gpt-oss-20b est un modèle "raisonneur" : il consomme une
      // partie du budget max_tokens en réflexion interne avant de produire
      // la réponse finale. Avec un budget trop court (60), tout partait dans
      // le raisonnement, laissant "" pour le JSON demandé
      // ("failed_generation": "" côté Groq). On réduit l'effort de
      // raisonnement au minimum et on laisse assez de marge.
      reasoning_effort: "low",
      max_tokens: 300,
      // Force une réponse JSON valide côté Groq — sans ça, le modèle peut
      // parfois ajouter du texte ou des balises markdown malgré la consigne,
      // ce qui faisait échouer le JSON.parse et bloquait tout le flux client
      // (relance en boucle, quoi que dise le client).
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `On a demandé à un client son nom et son besoin (formation, suivi alimentaire, ou produits finis). Analyse son message et extrais ces informations SI elles sont clairement présentes.
Réponds UNIQUEMENT avec un objet JSON de la forme {"nom": "..." ou null, "besoin": "..." ou null}, sans aucun autre texte.
N'invente jamais un nom ou un besoin qui ne serait pas explicitement dans le message.`,
        },
        { role: "user", content: userMessage },
      ],
    });

    recordUsage({ type: "extraction_client", model: "openai/gpt-oss-20b", usage: response.usage, phoneNumber });

    const parsed = parseJsonReply(response.choices[0].message.content, "extractClientInfo");
    return { nom: parsed.nom || null, besoin: parsed.besoin || null };
  } catch (err) {
    log.error("Échec extractClientInfo (appel Groq ou parsing JSON)", err);
    return { nom: null, besoin: null };
  }
}

// Repère le nom du compte Mobile Money mentionné par le client quand il
// signale un paiement, pour que le collaborateur puisse vérifier facilement
// dans son app Mobile Money.
export async function extractPaymentInfo(userMessage, phoneNumber) {
  try {
    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      reasoning_effort: "low",
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Le client vient d'indiquer qu'il a payé ou est en train de payer via Mobile Money. Analyse son message et extrais le nom du compte Mobile Money utilisé (le nom qui apparaît sur la transaction), SI il est clairement présent.
Réponds UNIQUEMENT avec un objet JSON de la forme {"compteMobileMoney": "..." ou null}, sans aucun autre texte.
N'invente jamais un nom qui ne serait pas explicitement dans le message.`,
        },
        { role: "user", content: userMessage },
      ],
    });

    recordUsage({ type: "extraction_paiement", model: "openai/gpt-oss-20b", usage: response.usage, phoneNumber });

    const parsed = parseJsonReply(response.choices[0].message.content, "extractPaymentInfo");
    return { compteMobileMoney: parsed.compteMobileMoney || null };
  } catch (err) {
    log.error("Échec extractPaymentInfo (appel Groq ou parsing JSON)", err);
    return { compteMobileMoney: null };
  }
}

// ANCIENNE VERSION (conservée en commentaire pour référence) : classifyMessage()
// faisait un appel Groq séparé (modèle 20b) AVANT askGroq() pour CHAQUE message,
// sans jamais voir l'historique de la conversation (seulement le dernier message).
// Conséquences : (1) un appel Groq de plus payé sur la quasi-totalité des messages
// "normaux", qui appelaient de toute façon askGroq() juste après ; (2) une
// classification parfois moins fiable, faute de contexte (ex: un client qui
// répond juste "oui, envoyez-moi la photo" à une réclamation évoquée plus tôt).
//
// NOUVELLE VERSION : la classification est fusionnée dans l'appel principal
// (voir handleClientMessage ci-dessous) via le function calling natif de Groq.
// Le modèle répond normalement en texte pour les cas standards, ou appelle
// l'outil "signaler_besoin_special" pour les cas nécessitant une escalade —
// en un seul appel, avec accès à tout l'historique. Ça élimine l'appel dédié
// pour la majorité des messages, et améliore la précision de la classification
// au passage. classifyMessage() n'est donc plus utilisé nulle part, mais reste
// disponible si un besoin ponctuel de classification isolée se présente ailleurs.
export async function classifyMessage(userMessage) {
  try {
    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      reasoning_effort: "low",
      max_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Classifie le message suivant dans UNE SEULE de ces catégories :
- "partenariat" : demande ou proposition de partenariat, expertise, collaboration professionnelle, ou recherche de stage
- "reclamation" : plainte, produit endommagé, mal conditionné, grammage incorrect, ou insatisfaction sur un produit déjà acheté
- "formation" : le client veut suivre une formation, apprendre auprès du cabinet, ou demande s'il existe des formations proposées
- "programme_alimentaire" : le client veut qu'on lui établisse un vrai suivi ou programme alimentaire personnalisé (coaching nutritionnel individuel), pas juste une question générale sur un produit
- "paiement" : le client indique qu'il vient de payer, qu'il est en train de payer, ou qu'il a envoyé l'argent via Mobile Money (Orange Money / MTN MoMo) pour une commande
- "normal" : toute autre demande (commande de produit, question sur le catalogue/prix, recommandation de produit selon un besoin, horaires, suivi de livraison, questions générales sur les bienfaits d'un produit, etc.)

Note : une simple question sur les bienfaits d'un produit ou une demande de recommandation de produit reste "normal". Ce n'est "programme_alimentaire" que si le client veut un accompagnement personnalisé et suivi dans la durée. Une simple intention d'achat sans mention de paiement effectué reste "normal" — "paiement" est réservé au moment où le client dit avoir réellement envoyé l'argent.

Réponds UNIQUEMENT avec un objet JSON de la forme {"categorie": "..."}, sans aucun autre texte.`,
        },
        { role: "user", content: userMessage },
      ],
    });

    const parsed = parseJsonReply(response.choices[0].message.content, "classifyMessage");
    return parsed.categorie;
  } catch (err) {
    log.error("Échec classifyMessage (appel Groq ou parsing JSON) — repli sur 'normal'", err);
    return "normal";
  }
}

// Définition de l'outil que le modèle peut appeler pour signaler un besoin
// nécessitant un collaborateur, au lieu de répondre directement en texte.
// Les descriptions détaillées vivent dans le prompt système (section
// "ROUTAGE"), pour ne pas dupliquer ces règles à deux endroits différents.
// Outil permettant au modèle de demander l'envoi de la fiche détaillée
// (photo + description) d'un produit précis, au lieu de décrire le produit
// lui-même en texte — utilisé quand le client s'intéresse à UN produit en
// particulier (pas pour une demande de catalogue complet, qui a déjà son
// propre court-circuit sans LLM).
const PRODUCT_DETAIL_TOOL = {
  type: "function",
  function: {
    name: "envoyer_fiche_produit",
    description:
      "A appeler quand le client demande des details, une photo, ou plus d'informations sur UN produit precis du catalogue (pas une demande de catalogue complet, pas une simple question generale). Envoie automatiquement la photo et la description du produit au client.",
    parameters: {
      type: "object",
      properties: {
        nom_produit: {
          type: "string",
          description: "Le nom du produit tel que mentionne ou compris depuis le message du client",
        },
      },
      required: ["nom_produit"],
    },
  },
};

const ESCALATION_TOOL = {
  type: "function",
  function: {
    name: "signaler_besoin_special",
    description:
      "A appeler uniquement quand le message du client correspond a un besoin qui doit etre transmis a un collaborateur humain (partenariat, reclamation, formation, programme alimentaire) ou quand le client signale un paiement. Ne jamais l'utiliser pour une commande, une question produit, une recommandation, ou toute demande a laquelle tu peux repondre toi-meme.",
    parameters: {
      type: "object",
      properties: {
        categorie: {
          type: "string",
          enum: ["partenariat", "reclamation", "formation", "programme_alimentaire", "paiement"],
        },
      },
      required: ["categorie"],
    },
  },
};

export async function summarizeForHuman(phoneNumber) {
  const history = await getHistory(phoneNumber);

  try {
    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      reasoning_effort: "low",
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content:
            "Résume cette conversation client en 2-3 phrases maximum, pour qu'un collaborateur comprenne vite la situation avant de répondre.",
        },
        ...sanitizeHistory(history).filter((m) => m.role !== "system"),
      ],
    });

    recordUsage({ type: "resume_escalade", model: "openai/gpt-oss-20b", usage: response.usage, phoneNumber });

    return response.choices[0].message.content;
  } catch (err) {
    log.error("Échec summarizeForHuman (appel Groq)", err);
    return "(résumé indisponible — erreur technique lors de la génération)";
  }
}

// Sauvegarde factorisée (évite de dupliquer le if/else Supabase/JSON à
// chaque point de sauvegarde de handleClientMessage).
function persistHistory(phoneNumber, history) {
  const promise = config.supabaseUrl
    ? convStore.saveConversation(phoneNumber, history)
    : convStore.saveConversations(conversations);
  promise.catch((e) => log.error("Erreur sauvegarde conversation", e));
}

// Nombre de messages (hors prompt système) envoyés à Groq à chaque appel.
// Le tableau complet reste stocké intégralement (BDD/JSON, visible dans
// l'admin) — seule la copie envoyée à l'API est plafonnée, pour éviter
// qu'une conversation qui dure des semaines ne fasse grossir indéfiniment
// le coût de CHAQUE appel suivant. Au-delà, les échanges les plus anciens
// n'apportent presque plus rien à la réponse du moment : le prompt système
// (persona, catalogue, procédures) reste lui présent en entier à chaque appel.
const MAX_HISTORY_MESSAGES = 24;

function trimForApi(history) {
  const [system, ...rest] = history;
  const trimmed = rest.length > MAX_HISTORY_MESSAGES ? rest.slice(-MAX_HISTORY_MESSAGES) : rest;
  return [system, ...trimmed];
}

/**
 * Remplace l'ancien duo classifyMessage() + askGroq(). Un seul appel Groq
 * (modèle 120b) qui, selon le message, répond directement en texte OU
 * appelle l'outil "signaler_besoin_special" — le modèle voit l'historique
 * complet dans les deux cas, contrairement à l'ancienne classification
 * isolée qui ne voyait que le dernier message.
 *
 * Retourne :
 *   { type: "reply", text }              -> réponse normale à envoyer telle quelle
 *   { type: "escalade", categorie }       -> à transmettre à enqueueEscalation()
 *   { type: "paiement" }                  -> à transmettre à requestPaymentConfirmation()
 */
export async function handleClientMessage(phoneNumber, userMessage) {
  const history = await getHistory(phoneNumber);
  history.push({ role: "user", content: userMessage, timestamp: new Date().toISOString() });
  persistHistory(phoneNumber, history);

  if (isDemandeCatalogueComplet(userMessage)) {
    log.info("Demande de catalogue complet détectée — réponse directe sans LLM", { phoneNumber });
    const reply = formatCatalogueComplet(await catalogueStore.loadCatalogue());
    history.push({ role: "assistant", content: reply, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "reply", text: reply };
  }

  const start = Date.now();
  let response;
  try {
    response = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      max_tokens: 1200,
      // "low" plutôt que le "medium" par défaut : une réponse de service
      // client n'a pas besoin d'un raisonnement interne poussé, et chaque
      // token de raisonnement en plus est un token facturé en plus sur
      // l'appel le plus fréquent et le plus gros du système.
      reasoning_effort: "low",
      tools: [ESCALATION_TOOL, PRODUCT_DETAIL_TOOL],
      tool_choice: "auto",
      messages: trimForApi(sanitizeHistory(history)),
    });
  } catch (err) {
    log.error("Échec de l'appel Groq (handleClientMessage) — voir détails ci-dessous", err);
    throw err; // on remonte l'erreur : le webhook doit savoir que ça a échoué
  }
  log.info("Appel Groq terminé", {
    phoneNumber,
    durationMs: Date.now() - start,
    promptTokens: response.usage?.prompt_tokens,
    completionTokens: response.usage?.completion_tokens,
    totalTokens: response.usage?.total_tokens,
  });
  recordUsage({ type: "reponse", model: "openai/gpt-oss-120b", usage: response.usage, phoneNumber });

  const message = response.choices[0].message;
  const toolCall = message.tool_calls?.[0];

  if (toolCall?.function?.name === "envoyer_fiche_produit") {
    let nomProduit = "";
    try {
      nomProduit = JSON.parse(toolCall.function.arguments).nom_produit;
    } catch (err) {
      log.error("Argument de l'outil envoyer_fiche_produit illisible", {
        raw: toolCall.function.arguments,
        err,
      });
    }

    const catalogue = await catalogueStore.loadCatalogue();
    const produit = trouverProduitParNom(catalogue, nomProduit);

    if (!produit) {
      log.warn("Fiche produit demandée mais produit introuvable dans le catalogue", { phoneNumber, nomProduit });
      // Repli texte : le modèle explique lui-même qu'il n'a pas trouvé,
      // au prochain tour — ici on renvoie juste une réponse neutre.
      const repli = "Je n'ai pas trouvé ce produit précis dans notre catalogue — pouvez-vous préciser le nom exact ? 🙏";
      history.push({ role: "assistant", content: repli, timestamp: new Date().toISOString() });
      persistHistory(phoneNumber, history);
      return { type: "reply", text: repli };
    }

    log.info("Fiche produit à envoyer", { phoneNumber, produit: produit.nom });
    // Entrée légère dans l'historique : la photo elle-même n'est pas un
    // "message texte" du modèle, mais sans cette ligne, l'admin verrait un
    // trou dans la timeline de conversation là où le client a pourtant reçu
    // quelque chose — et le modèle, lui, ne "se souviendrait" pas non plus
    // de l'avoir déjà envoyée aux tours suivants.
    history.push({
      role: "assistant",
      content: `[Fiche produit envoyée : ${produit.nom}]`,
      timestamp: new Date().toISOString(),
    });
    persistHistory(phoneNumber, history);
    // Le store Supabase renvoie "image_url" (snake_case) ; le store JSON
    // renvoie déjà "imageUrl" — on normalise ici pour que le reste du code
    // (webhook, formatFicheProduit) n'ait qu'un seul nom de champ à connaître.
    const produitNormalise = { ...produit, imageUrl: produit.imageUrl || produit.image_url || "" };
    return { type: "fiche_produit", produit: produitNormalise };
  }

  if (toolCall?.function?.name === "signaler_besoin_special") {
    let categorie = "normal";
    try {
      categorie = JSON.parse(toolCall.function.arguments).categorie;
    } catch (err) {
      log.error("Argument de l'outil signaler_besoin_special illisible — repli sur 'normal'", {
        raw: toolCall.function.arguments,
        err,
      });
    }
    log.info("Besoin spécial signalé par le modèle", { phoneNumber, categorie });
    // Pas de réponse texte du modèle à conserver ici : le message envoyé au
    // client pour ce cas est un gabarit géré par enqueueEscalation() /
    // requestPaymentConfirmation(), pas une génération libre du LLM.
    persistHistory(phoneNumber, history);
    return categorie === "paiement"
      ? { type: "paiement" }
      : { type: "escalade", categorie };
  }

  const reply = message.content;
  history.push({ role: "assistant", content: reply, timestamp: new Date().toISOString() });
  persistHistory(phoneNumber, history);

  return { type: "reply", text: reply };
}
