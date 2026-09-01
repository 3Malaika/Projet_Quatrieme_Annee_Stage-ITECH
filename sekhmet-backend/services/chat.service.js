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
import { analyzeLocalMessage, buildLocalNaturalReply, getLocalChatConfig, getRecommendationCandidates } from "./localNlp.service.js";

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

// Comptes (numéro + nom) transmis au client quand il veut payer.
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

// Ajoute une entrée à l'historique d'un client depuis l'extérieur du flux
// normal handleClientMessage() — utilisé notamment pour tracer, côté admin,
// la sélection de quantité faite via la liste interactive envoyée après une
// recommandation de produit (webhook.routes.js).
export async function appendHistoryEntry(phoneNumber, entry) {
  const history = await getHistory(phoneNumber);
  history.push({ ...entry, timestamp: entry.timestamp || new Date().toISOString() });
  persistHistory(phoneNumber, history);
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

// Efface l'historique d'un client précis : retire la conversation du cache
// mémoire (donc le prochain message reconstruira un prompt système neuf,
// comme un tout premier contact) ET supprime la trace persistée
// (JSON local ou table Supabase selon le mode actif).
export async function deleteConversationHistory(phoneNumber) {
  delete conversations[phoneNumber];
  await convStore.deleteConversation(phoneNumber);
  log.info("Historique de conversation effacé", { phoneNumber });
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
  const local = await analyzeLocalMessage(userMessage);
  let nom = local.name || null;
  let besoin = local.need || null;

  // L'extraction locale reste prioritaire. Pour les formulations naturelles,
  // fautes de frappe ou réponses très courtes (ex: "Je m'appele Babouma",
  // "Moi c'est Babouma", ou simplement "Babouma" après la demande du nom),
  // Groq sert de filet de sécurité. Cela évite de gonfler artificiellement
  // le dataset avec des prénoms/formulations particuliers.
  if ((!nom || !besoin) && config.groqApiKey) {
    try {
      const history = await getHistory(phoneNumber);
      const extractionMessages = trimForApi(sanitizeHistory(history)).map(toApiMessage);
      extractionMessages.push({
        role: "user",
        content: `Extrais uniquement les informations client de ce dernier message : "${String(userMessage || "")}"\n\nRetourne STRICTEMENT un JSON valide de la forme {"nom": string|null, "besoin": string|null}.\n- nom : prénom ou nom explicitement donné par le client. Si le message est uniquement un nom/prénom et que le contexte récent montre qu'on lui demande son nom, utilise-le.\n- besoin : besoin explicitement exprimé (formation, suivi alimentaire, produits finis ou formulation libre).\n- Ne devine jamais une information absente.\n- Tolère les fautes d'orthographe et les formulations naturelles.`
      });
      const response = await groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        max_tokens: 180,
        reasoning_effort: "low",
        messages: extractionMessages,
      });
      const raw = response.choices?.[0]?.message?.content || "{}";
      const parsed = parseJsonReply(raw, "extraction informations client");
      if (!nom && typeof parsed.nom === "string" && parsed.nom.trim()) nom = parsed.nom.trim();
      if (!besoin && typeof parsed.besoin === "string" && parsed.besoin.trim()) besoin = parsed.besoin.trim();
      recordUsage({ type: "extraction_client", model: "openai/gpt-oss-120b", usage: response.usage, phoneNumber });
      log.info("Extraction client locale + secours Groq", { phoneNumber, nom: !!nom, besoin: !!besoin });
    } catch (err) {
      log.warn("Extraction client Groq échouée — résultat local conservé", { phoneNumber, error: err?.message || String(err) });
    }
  }

  return { nom, besoin };
}

// Le nom du compte Mobile Money est extrait localement. Groq reste réservé
// à la conversation naturelle, pas aux informations structurées simples.
export async function extractPaymentInfo(userMessage, phoneNumber) {
  const text = String(userMessage || "");
  const patterns = [
    /(?:au nom de|nom du compte|compte au nom de)\s*[:=]?\s*([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,80})/i,
    /(?:j['’]ai payé avec|j['’]ai paye avec|payé sur|paye sur)\s*([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return { compteMobileMoney: match[1].trim().replace(/[.!?,;:]+$/, "") };
  }
  return { compteMobileMoney: null };
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
  const analysis = await analyzeLocalMessage(userMessage);
  return analysis.intent;
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

// A appeler quand le client veut payer / demande comment payer / demande le
// numéro à créditer — AVANT qu'il ait effectivement envoyé l'argent (une
// fois payé, c'est l'outil signaler_besoin_special / catégorie "paiement"
// qui prend le relais). Le numéro et le nom du compte viennent toujours de
// la configuration admin (jamais inventés par le modèle).
const PAYMENT_INFO_TOOL = {
  type: "function",
  function: {
    name: "envoyer_infos_paiement",
    description:
      "A appeler quand le client veut payer, demande comment payer, ou demande le numero/compte Mobile Money pour envoyer l'argent, AVANT qu'il ait effectivement envoye le paiement. Ne pas utiliser une fois que le client dit avoir deja paye : dans ce cas utiliser signaler_besoin_special avec la categorie paiement.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

// A appeler quand le modèle recommande PLUSIEURS produits en réponse à un
// besoin exprimé (au lieu de les décrire en texte) : chaque produit est
// alors envoyé au client sous forme de fiche (photo + nom + prix) suivie
// d'une sélection de quantité à valider. Limité à 3 produits maximum.
const RECOMMENDATION_TOOL = {
  type: "function",
  function: {
    name: "recommander_produits",
    description:
      "A appeler quand tu recommandes DEUX OU TROIS produits du catalogue en reponse a un besoin exprime par le client (pas pour un seul produit precis : dans ce cas utiliser envoyer_fiche_produit). Chaque produit recommande sera envoye avec sa photo, son nom, son prix, et un choix de quantite a valider. Maximum 3 produits.",
    parameters: {
      type: "object",
      properties: {
        produits: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "string",
            description: "Nom du produit tel que mentionne ou compris depuis le catalogue",
          },
        },
      },
      required: ["produits"],
    },
  },
};

const ADD_TO_CART_TOOL = {
  type: "function",
  function: {
    name: "ajouter_produit_panier",
    description:
      "A appeler UNIQUEMENT lorsque le client exprime clairement qu'il veut AJOUTER ou ACHETER un produit précis dans son panier, notamment après avoir déjà sélectionné un autre produit. Ne pas utiliser pour une simple question de prix, stock, photo ou description. Ne choisis jamais une quantité : le client la sélectionnera ensuite.",
    parameters: {
      type: "object",
      properties: {
        nom_produit: {
          type: "string",
          description: "Nom du produit précis que le client veut ajouter au panier",
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

// L'historique stocké garde `timestamp` (utile pour l'admin et pour
// reconstituer la timeline d'une conversation), mais ce champ ne fait PAS
// partie du schéma accepté par l'API Groq (compatible OpenAI : role,
// content, name, tool_calls, tool_call_id — rien d'autre). L'envoyer tel
// quel dans `messages` est au mieux inutile, au pire risque un rejet de la
// requête selon la sévérité de la validation côté Groq. On ne garde donc
// que les champs reconnus par l'API juste avant l'appel.
function toApiMessage({ role, content, name, tool_calls, tool_call_id }) {
  const msg = { role, content };
  if (name !== undefined) msg.name = name;
  if (tool_calls !== undefined) msg.tool_calls = tool_calls;
  if (tool_call_id !== undefined) msg.tool_call_id = tool_call_id;
  return msg;
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

  const localConfig = await getLocalChatConfig();
  const analysis = await analyzeLocalMessage(userMessage, { config: localConfig });
  const clients = await clientsStore.loadClients();
  const client = clients[phoneNumber] || {};

  if (isDemandeCatalogueComplet(userMessage)) {
    const reply = formatCatalogueComplet(await catalogueStore.loadCatalogue());
    history.push({ role: "assistant", content: reply, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "reply", text: reply, source: "local" };
  }

  if (analysis.paymentDone) return { type: "paiement", source: "local" };

  if (analysis.paymentRequest) {
    const comptes = await loadPaiementComptes();
    const reply = formatInfosPaiement(comptes);
    history.push({ role: "assistant", content: reply, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "reply", text: reply, source: "local" };
  }

  const escalationCategories = new Set(["partenariat", "reclamation", "formation", "programme_alimentaire"]);
  // Une escalade locale n'est déclenchée que si les règles locales sont
  // suffisamment sûres. Une formulation ambiguë reste traitée par Groq.
  if (!analysis.requiresGroq && escalationCategories.has(analysis.intent)) {
    persistHistory(phoneNumber, history);
    return { type: "escalade", categorie: analysis.intent, source: "local" };
  }

  // Une réponse locale n'est utilisée que lorsque l'analyse est suffisamment
  // sûre. Sinon Groq reçoit le message et l'historique pour gérer les cas
  // ambigus/naturels.
  const localReply = !analysis.requiresGroq
    ? buildLocalNaturalReply(analysis, localConfig, client)
    : null;
  if (localReply) {
    history.push({ role: "assistant", content: localReply, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "reply", text: localReply, source: "local" };
  }

  if (analysis.intent === "productInfo") {
    const catalogue = await catalogueStore.loadCatalogue();
    const product = catalogue.find((p) => {
      const n = String(p.nom || "").toLowerCase();
      return n && userMessage.toLowerCase().includes(n);
    });
    if (product) {
      const produitNormalise = { ...product, imageUrl: product.imageUrl || product.image_url || "" };
      history.push({ role: "assistant", content: `[Fiche produit envoyée : ${product.nom}]`, timestamp: new Date().toISOString() });
      persistHistory(phoneNumber, history);
      return { type: "fiche_produit", produit: produitNormalise, source: "local" };
    }
  }

  const candidates = getRecommendationCandidates(
    await catalogueStore.loadCatalogue(),
    localConfig,
    client.besoin || analysis.need || userMessage
  );
  if (candidates.length >= 2 && /cherche|besoin|conseil|recommande|conseille|pour ma|pour mon/i.test(userMessage)) {
    const produits = candidates.slice(0, 3).map((p) => ({ ...p, imageUrl: p.imageUrl || p.image_url || "" }));
    history.push({
      role: "assistant",
      content: `[Recommandation locale envoyée : ${produits.map((p) => p.nom).join(", ")}]`,
      timestamp: new Date().toISOString(),
    });
    persistHistory(phoneNumber, history);
    return { type: "recommandation", produits, source: "local" };
  }

  const start = Date.now();
  let response;
  try {
    if (!config.groqApiKey) {
      const fallback = "Je veux bien vous aider 😊 Pouvez-vous me préciser ce que vous recherchez ?";
      history.push({ role: "assistant", content: fallback, timestamp: new Date().toISOString() });
      persistHistory(phoneNumber, history);
      return { type: "reply", text: fallback, source: "local-fallback" };
    }
    response = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      max_tokens: 900,
      reasoning_effort: "low",
      tools: [ESCALATION_TOOL, PRODUCT_DETAIL_TOOL, PAYMENT_INFO_TOOL, RECOMMENDATION_TOOL, ADD_TO_CART_TOOL],
      tool_choice: "auto",
      messages: trimForApi(sanitizeHistory(history)).map(toApiMessage),
    });
  } catch (err) {
    log.error("Échec de l'appel Groq (handleClientMessage)", err);
    throw err;
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

  if (toolCall?.function?.name === "ajouter_produit_panier") {
    let nomProduit = "";
    try { nomProduit = JSON.parse(toolCall.function.arguments).nom_produit; }
    catch (err) { log.error("Argument de l'outil ajouter_produit_panier illisible", { raw: toolCall.function.arguments, err }); }
    const catalogue = await catalogueStore.loadCatalogue();
    const produit = trouverProduitParNom(catalogue, nomProduit);
    if (!produit) {
      const repli = "Je n'ai pas trouvé ce produit dans notre catalogue — pouvez-vous préciser son nom ? 🙏";
      history.push({ role: "assistant", content: repli, timestamp: new Date().toISOString() });
      persistHistory(phoneNumber, history);
      return { type: "reply", text: repli, source: "local-fallback" };
    }
    history.push({ role: "assistant", content: `[Produit à ajouter au panier : ${produit.nom}]`, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "ajout_panier", produit: { ...produit, imageUrl: produit.imageUrl || produit.image_url || "" }, source: "groq" };
  }

  if (toolCall?.function?.name === "envoyer_fiche_produit") {
    let nomProduit = "";
    try { nomProduit = JSON.parse(toolCall.function.arguments).nom_produit; }
    catch (err) { log.error("Argument de l'outil envoyer_fiche_produit illisible", { raw: toolCall.function.arguments, err }); }
    const catalogue = await catalogueStore.loadCatalogue();
    const produit = trouverProduitParNom(catalogue, nomProduit);
    if (!produit) {
      const repli = "Je n'ai pas trouvé ce produit précis dans notre catalogue — pouvez-vous préciser le nom exact ? 🙏";
      history.push({ role: "assistant", content: repli, timestamp: new Date().toISOString() });
      persistHistory(phoneNumber, history);
      return { type: "reply", text: repli, source: "local-fallback" };
    }
    history.push({ role: "assistant", content: `[Fiche produit envoyée : ${produit.nom}]`, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "fiche_produit", produit: { ...produit, imageUrl: produit.imageUrl || produit.image_url || "" }, source: "groq" };
  }

  if (toolCall?.function?.name === "envoyer_infos_paiement") {
    const comptes = await loadPaiementComptes();
    const reply = formatInfosPaiement(comptes);
    history.push({ role: "assistant", content: reply, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "reply", text: reply, source: "groq-tool" };
  }

  if (toolCall?.function?.name === "recommander_produits") {
    let nomsProduits = [];
    try { nomsProduits = JSON.parse(toolCall.function.arguments).produits || []; }
    catch (err) { log.error("Argument de l'outil recommander_produits illisible", { raw: toolCall.function.arguments, err }); }
    const catalogue = await catalogueStore.loadCatalogue();
    const produits = nomsProduits.slice(0, 3).map((nom) => trouverProduitParNom(catalogue, nom)).filter(Boolean).map((p) => ({ ...p, imageUrl: p.imageUrl || p.image_url || "" }));
    if (!produits.length) {
      const repli = "Je n'ai pas trouvé ces produits précis dans notre catalogue — pouvez-vous préciser vos besoins ? 🙏";
      history.push({ role: "assistant", content: repli, timestamp: new Date().toISOString() });
      persistHistory(phoneNumber, history);
      return { type: "reply", text: repli, source: "local-fallback" };
    }
    history.push({ role: "assistant", content: `[Recommandation envoyée : ${produits.map((p) => p.nom).join(", ")}]`, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "recommandation", produits, source: "groq" };
  }

  if (toolCall?.function?.name === "signaler_besoin_special") {
    let categorie = "normal";
    try { categorie = JSON.parse(toolCall.function.arguments).categorie; } catch (err) { log.error("Argument de l'outil signaler_besoin_special illisible", { raw: toolCall.function.arguments, err }); }
    persistHistory(phoneNumber, history);
    return categorie === "paiement" ? { type: "paiement" } : { type: "escalade", categorie };
  }

  const reply = message.content || "Je veux bien vous aider 😊 Pouvez-vous m'en dire un peu plus ?";
  history.push({ role: "assistant", content: reply, timestamp: new Date().toISOString() });
  persistHistory(phoneNumber, history);
  return { type: "reply", text: reply, source: "groq" };
}

