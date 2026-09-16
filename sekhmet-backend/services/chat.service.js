import Groq from "groq-sdk";
import { config } from "../config/env.js";
import {
  formatCatalogueComplet,
  isDemandeCatalogueComplet,
  trouverProduitParNom,
  formatFicheProduit,
  parsePrixEnNombre,
} from "./catalogueFormatter.service.js";
import { recordUsage } from "./usage.service.js";
import { createLogger } from "../utils/logger.js";
import {
  requestCartAbandonConfirmation,
  recordProductSelection,
  formatCart,
  detectDeliveryModeFromText,
  extractDeliveryAddressFromText,
  hasDeliveryMode,
  provideDeliveryModeFromText,
  hasDeliveryAddress,
  provideDeliveryAddress,
  getDeliveryMode,
} from "./payment.service.js";
import { enqueueEscalation, isPending as isEscalationPending } from "./escalation.service.js";

const log = createLogger("chat.service");
const groq = new Groq({ apiKey: config.groqApiKey });

// Sélection dynamique des stores selon l'environnement
const clientsStore = config.supabaseUrl
  ? await import("../data/clients.store.supabase.js")
  : await import("../data/clients.store.js");

const convStore = config.supabaseUrl
  ? await import("../data/conversations.store.supabase.js")
  : await import("../data/conversations.store.js");

// Le panier est une donnée structurée : on peut le fournir à Groq sous forme
// d'un résumé très court uniquement quand il est utile, sans lui envoyer la
// totalité des détails internes de la commande.
const cartStoreForContext = config.supabaseUrl
  ? await import("../data/cart.store.supabase.js")
  : await import("../data/cart.store.js");

const proceduresStoreForContext = config.supabaseUrl
  ? await import("../data/configTextes.store.supabase.js")
  : await import("../data/procedures.store.js");

let proceduresCache = { value: "", loadedAt: 0 };
const PROCEDURES_CACHE_MS = 30_000;

// Bug corrigé : loadCatalogue pointait toujours vers le fichier local,
// même en mode Supabase (donc jamais synchro avec l'admin en prod).
const catalogueStore = config.supabaseUrl
  ? await import("../data/catalogue.store.supabase.js")
  : await import("../data/catalogue.store.js");

// Comptes (numéro + nom) transmis au client quand il veut payer.
// NOTE : formatInfosPaiement/loadPaiementComptes ne sont plus utilisés ici
// depuis que l'outil "infos_paiement" ne formate plus la réponse lui-même
// (voir plus bas) — c'est désormais sendCartPaymentInstructions, dans
// webhook.routes.js, qui s'en charge, après avoir vérifié nom/mode/adresse.
// Conservés tels quels pour limiter la surface de ce correctif.
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
    // Le contexte Groq est maintenant construit à la demande. On ne stocke
    // plus un énorme prompt système dans chaque conversation. Cela réduit
    // fortement la taille persistée et empêche qu'un ancien prompt complet
    // soit accidentellement renvoyé à l'API.
    conversations[phoneNumber] = [
      { role: "system", content: "[Contexte système géré dynamiquement]" },
    ];
    // Ne pas sauvegarder ici : un enregistrement asynchrone d'une nouvelle
    // conversation pouvait recréer dans Supabase une conversation que
    // l'administrateur venait de supprimer. La première vraie écriture
    // intervient quand un message est ajouté à l'historique.
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

// Définition de l'outil que le modèle peut appeler pour signaler un besoin
// nécessitant un collaborateur, au lieu de répondre directement en texte.
// Les descriptions détaillées vivent dans le prompt système (section
// "ROUTAGE"), pour ne pas dupliquer ces règles à deux endroits différents.
// Outil permettant au modèle de demander l'envoi de la fiche détaillée
// (photo + description) d'un produit précis, au lieu de décrire le produit
// lui-même en texte — utilisé quand le client s'intéresse à UN produit en
// particulier (pas pour une demande de catalogue complet, qui a déjà son
// propre court-circuit sans LLM).
//
// NOTE PERF (réduction consommation tokens) : les descriptions des outils
// ci-dessous ont été raccourcies au maximum. La logique fine de routage
// (quand appeler quel outil, quels cas limites) vit désormais uniquement
// dans le prompt système (section "OUTILS" de buildFocusedGroqContext),
// pour éviter de payer deux fois le même texte à chaque appel Groq.
const PRODUCT_DETAIL_TOOL = {
  type: "function",
  function: {
    name: "fiche_produit",
    description:
      "A appeler quand le client demande des détails/photo sur UN produit précis (pas le catalogue complet).",
    parameters: {
      type: "object",
      properties: {
        nom_produit: {
          type: "string",
          description: "Le nom du produit tel que mentionné ou compris depuis le message du client",
        },
      },
      required: ["nom_produit"],
    },
  },
};

// A appeler quand le client veut payer / demande comment payer / demande le
// numéro à créditer — AVANT qu'il ait effectivement envoyé l'argent (une
// fois payé, c'est l'outil escalade / catégorie "paiement"
// qui prend le relais). Le numéro et le nom du compte viennent toujours de
// la configuration admin (jamais inventés par le modèle).
const PAYMENT_INFO_TOOL = {
  type: "function",
  function: {
    name: "infos_paiement",
    description:
      "A appeler quand le client veut payer ou demande le numéro Mobile Money, AVANT d'avoir payé.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

// A appeler dès que le client indique COMMENT il veut récupérer sa
// commande — y compris de façon spontanée, sans qu'on le lui ait demandé
// (ex: "je veux me faire livrer", "je suis pas à Yaoundé", "je passerai la
// chercher moi-même"). Avant cet outil, une telle précision donnée en même
// temps qu'une autre question (ex: "je veux me faire livrer, je paie
// comment ?") était totalement perdue : seul infos_paiement était appelé,
// et le client recevait les modalités de paiement sans que son mode de
// livraison n'ait jamais été enregistré. Cet outil corrige ce cas —
// utilisé conjointement avec infos_paiement pour ASK_PAYMENT_INFO (voir
// buildToolsForIntent), et seul pour SET_DELIVERY_MODE.
const REGISTER_DELIVERY_MODE_TOOL = {
  type: "function",
  function: {
    name: "mode_livraison",
    description:
      "A appeler dès que le client précise comment il veut récupérer sa commande, même spontanément (pas seulement en réponse à une question posée par le bot). Ne pas utiliser pour une simple question générale sur les délais/zones de livraison, sans préférence exprimée.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["livraison", "expedition", "retrait_boutique"],
          description: "livraison = domicile à Yaoundé. expedition = hors Yaoundé, via agence de voyage. retrait_boutique = le client vient chercher lui-même sa commande.",
        },
      },
      required: ["mode"],
    },
  },
};

// A appeler quand le modèle recommande PLUSIEURS produits en réponse à un
// besoin exprimé (au lieu de les décrire en texte) : chaque produit est
// alors envoyé au client sous forme de fiche (photo + nom + prix). Limité à
// 3 produits maximum. Le client répond ensuite en texte libre pour préciser
// lesquels il veut et en quelle quantité — voir "ajout_panier".
const RECOMMENDATION_TOOL = {
  type: "function",
  function: {
    name: "recommander",
    description:
      "A appeler quand tu recommandes 2+ produits, OU quand le client demande explicitement à voir TOUS les produits d'une catégorie/famille (ex: \"tous les pains\", \"toutes les photos de vos jus\") — dans ce cas liste TOUS les produits correspondants, pas seulement 2 ou 3. Pas pour 1 seul produit précis : voir fiche_produit.",
    parameters: {
      type: "object",
      properties: {
        produits: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "string",
            description: "Nom du produit tel que mentionné ou compris depuis le catalogue",
          },
        },
      },
      required: ["produits"],
    },
  },
};

const ABANDON_CART_TOOL = {
  type: "function",
  function: {
    name: "abandonner",
    description:
      "A appeler quand la cliente exprime qu'elle abandonne/annule son panier. Ne vide jamais le panier directement, prépare juste une demande de confirmation.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

// A appeler UNIQUEMENT lorsque le client exprime clairement qu'il veut
// AJOUTER ou ACHETER un ou plusieurs produits — avec ou sans quantité
// précisée pour chacun. Un SEUL appel doit regrouper TOUS les produits
// mentionnés dans le message, même s'il y en a plusieurs à la fois (ex :
// « je veux un pain, un cupcake et trois chouquettes » -> un seul appel
// avec les 3 produits et leurs quantités). Chaque produit est directement
// ajouté au panier avec la quantité donnée (1 par défaut si absente) — plus
// aucune liste de choix de quantité n'est envoyée au client, pour ne pas
// bloquer la conversation sur un seul produit à la fois.
const ADD_TO_CART_TOOL = {
  type: "function",
  function: {
    name: "ajout_panier",
    description:
      "A appeler quand le client veut acheter/ajouter un ou plusieurs produits à son panier. Regrouper TOUS les produits du message en un seul appel.",
    parameters: {
      type: "object",
      properties: {
        produits: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              nom_produit: {
                type: "string",
                description: "Nom du produit précis tel que mentionné ou compris depuis le catalogue",
              },
              quantite: {
                type: "integer",
                description: "Quantité demandée. Si non précisée, mets 1.",
              },
            },
            required: ["nom_produit"],
          },
        },
      },
      required: ["produits"],
    },
  },
};

const ESCALATION_TOOL = {
  type: "function",
  function: {
    name: "escalade",
    description:
      "Catégorie 'paiement' si le client dit avoir payé. Catégorie 'contact_humain' si demande explicite d'un humain. Autres : partenariat, reclamation, formation, programme_alimentaire. Ne jamais utiliser si un ÉTAT EN ATTENTE est actif dans le contexte : utiliser l'outil correspondant à cet état à la place.",
    parameters: {
      type: "object",
      properties: {
        categorie: {
          type: "string",
          enum: ["partenariat", "reclamation", "formation", "programme_alimentaire", "paiement", "contact_humain"],
        },
      },
      required: ["categorie"],
    },
  },
};

// A appeler quand le client demande a voir/consulter le contenu de son
// panier actuel, plutot que de faire deviner cette intention par une
// correspondance de mots-cles cote code.
const VIEW_CART_TOOL = {
  type: "function",
  function: {
    name: "panier",
    description: "A appeler quand le client demande à voir/consulter son panier actuel.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

// A appeler quand le client veut valider/confirmer/passer sa commande a
// partir du panier deja constitue (distinct du paiement effectif : cette
// etape envoie le recapitulatif + les modalites de paiement).
const VALIDATE_CART_TOOL = {
  type: "function",
  function: {
    name: "valider",
    description:
      "A appeler quand le client veut valider/confirmer/passer sa commande à partir de son panier actuel.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const REGISTER_DELIVERY_ADDRESS_TOOL = {
  type: "function",
  function: {
    name: "adresse",
    description: "A appeler quand le bot attend l'adresse de livraison et que le client vient d'en donner une.",
    parameters: {
      type: "object",
      properties: {
        adresse: { type: "string", description: "L'adresse de livraison telle que donnée par le client" },
      },
      required: ["adresse"],
    },
  },
};

// A appeler UNIQUEMENT quand le bot attend le nom du client avant de
// valider sa commande (voir ÉTAT EN ATTENTE / procédures : le nom est
// obligatoire pour valider une commande).
const REGISTER_CLIENT_NAME_TOOL = {
  type: "function",
  function: {
    name: "nom_client",
    description: "A appeler quand le bot attend le nom du client et que le client vient de le donner.",
    parameters: {
      type: "object",
      properties: {
        nom: { type: "string", description: "Le nom (ou prénom) du client tel qu'il vient de le donner" },
      },
      required: ["nom"],
    },
  },
};

const REGISTER_MOMO_TOOL = {
  type: "function",
  function: {
    name: "momo",
    description:
      "A appeler quand le bot attend le numéro Mobile Money et que le client le donne ou le confirme (ex: 'oui', 'c'est ça' => utiliser son numéro WhatsApp indiqué dans le contexte).",
    parameters: {
      type: "object",
      properties: {
        numero: { type: "string", description: "Le numéro de compte Mobile Money donné par le client" },
        nom_compte: { type: "string", description: "Le nom sur le compte Mobile Money, si mentionné" },
      },
      required: ["numero"],
    },
  },
};

const CONFIRM_CART_ABANDON_TOOL = {
  type: "function",
  function: {
    name: "abandon_ok",
    description: "A appeler quand le bot attend la confirmation d'abandon du panier et que le client répond oui/non.",
    parameters: {
      type: "object",
      properties: {
        confirmed: { type: "boolean", description: "true si le client confirme vouloir vider le panier, false s'il refuse" },
      },
      required: ["confirmed"],
    },
  },
};

const CONFIRM_DELIVERY_PHONE_TOOL = {
  type: "function",
  function: {
    name: "livraison_ok",
    description: "A appeler quand le bot attend la confirmation du numéro de livraison et que le client confirme ou refuse.",
    parameters: {
      type: "object",
      properties: {
        confirmed: { type: "boolean", description: "true si le client confirme le numéro, false s'il refuse ou donne un autre numéro" },
      },
      required: ["confirmed"],
    },
  },
};

// ---------------------------------------------------------------------------
// Sélection des outils envoyés à Groq selon le contexte (réduction tokens)
// ---------------------------------------------------------------------------
// Avant ce correctif, les 13 outils étaient envoyés à CHAQUE appel, même
// lorsqu'un état d'attente précis (adresse, nom, momo, confirmation...)
// n'appelle logiquement qu'UN seul outil de réponse. On limite donc la
// liste envoyée au strict nécessaire selon l'état en attente, ce qui réduit
// fortement le nombre de tokens de prompt sur ces échanges (très fréquents
// dans le flow : adresse -> nom -> momo -> confirmation livraison...).
// On garde toujours "escalade" disponible en secours (ex: le client change
// de sujet et veut parler à un humain au lieu de répondre à la question
// posée), sauf pour les cas où l'état en attente est trop spécifique.
// Outils de secours volontairement vides : un routage incertain ne doit
// jamais redonner au modèle l'accès à toutes les actions métier.
const NO_TOOLS = [];


const INTENTS = Object.freeze({
  ADD_TO_CART: "ADD_TO_CART",
  VALIDATE_ORDER: "VALIDATE_ORDER",
  VIEW_CART: "VIEW_CART",
  ABANDON_CART: "ABANDON_CART",
  ASK_PAYMENT_INFO: "ASK_PAYMENT_INFO",
  PAYMENT_DONE: "PAYMENT_DONE",
  SET_DELIVERY_MODE: "SET_DELIVERY_MODE",
  PRODUCT_DETAIL: "PRODUCT_DETAIL",
  PRODUCT_QUERY: "PRODUCT_QUERY",
  RECOMMENDATION: "RECOMMENDATION",
  HUMAN_REQUEST: "HUMAN_REQUEST",
  COMPLAINT: "COMPLAINT",
  PARTNERSHIP: "PARTNERSHIP",
  TRAINING: "TRAINING",
  FAMILY_FOLLOWUP: "FAMILY_FOLLOWUP",
  DELIVERY_INFORMATION: "DELIVERY_INFORMATION",
  GENERAL_INFORMATION: "GENERAL_INFORMATION",
  UNCLEAR: "UNCLEAR",
});

const VALID_INTENTS = new Set(Object.values(INTENTS));
const INTENT_CONFIDENCE_THRESHOLD = 0.78;

// Ces catégories sont des obligations métier : lorsqu'elles sont reconnues
// avec suffisamment de confiance, le modèle 120B ne doit jamais répondre seul
// ni choisir une autre catégorie.
const MANDATORY_ESCALATION_BY_INTENT = Object.freeze({
  [INTENTS.PAYMENT_DONE]: "paiement",
  [INTENTS.HUMAN_REQUEST]: "contact_humain",
  [INTENTS.COMPLAINT]: "reclamation",
  [INTENTS.PARTNERSHIP]: "partenariat",
  [INTENTS.TRAINING]: "formation",
  [INTENTS.FAMILY_FOLLOWUP]: "programme_alimentaire",
});

const HARD_PAYMENT_DONE_PHRASES = [
  "j'ai payé",
  "j ai paye",
  "c'est payé",
  "c est paye",
  "c'est réglé",
  "c est regle",
  "j'ai envoyé l'argent",
  "j ai envoye l argent",
  "je viens d'envoyer l'argent",
  "je viens d envoyer l argent",
];

const HARD_HUMAN_PHRASES = [
  "je veux parler à quelqu'un",
  "je veux parler a quelqu'un",
  "je veux un humain",
  "mettez-moi en relation avec quelqu'un",
  "mets-moi en relation avec quelqu'un",
  "je veux parler au coach",
  "je veux parler à coach emy",
  "je veux parler a coach emy",
];

const HARD_COMPLAINT_PHRASES = [
  "je me plains",
  "je porte réclamation",
  "je porte reclamation",
  "produit endommagé",
  "produit endommage",
  "mauvais conditionnement",
  "mauvais emballage",
  "grammage incorrect",
  "produit abîmé",
  "produit abîme",
  "produit abime",
];

const HARD_PARTNERSHIP_PHRASES = [
  "partenariat",
  "collaboration professionnelle",
  "collaboration pro",
  "expertise professionnelle",
  "demande de partenariat",
];

function textContainsPhrase(normalizedText, phrases) {
  return phrases.some((phrase) => normalizedText.includes(normalizeTextForMatch(phrase)));
}

function applyHardIntentGuards(userMessage) {
  const text = normalizeTextForMatch(userMessage);
  if (textContainsPhrase(text, HARD_PAYMENT_DONE_PHRASES)) {
    return { primaryIntent: INTENTS.PAYMENT_DONE, secondaryIntent: null, confidence: 1, source: "hard-guard" };
  }
  if (textContainsPhrase(text, HARD_HUMAN_PHRASES)) {
    return { primaryIntent: INTENTS.HUMAN_REQUEST, secondaryIntent: null, confidence: 1, source: "hard-guard" };
  }
  if (textContainsPhrase(text, HARD_COMPLAINT_PHRASES)) {
    return { primaryIntent: INTENTS.COMPLAINT, secondaryIntent: null, confidence: 1, source: "hard-guard" };
  }
  if (textContainsPhrase(text, HARD_PARTNERSHIP_PHRASES)) {
    return { primaryIntent: INTENTS.PARTNERSHIP, secondaryIntent: null, confidence: 1, source: "hard-guard" };
  }
  return null;
}

function parseIntentReply(raw, context) {
  const parsed = parseJsonReply(raw, context);
  const primaryIntent = VALID_INTENTS.has(parsed?.primaryIntent) ? parsed.primaryIntent : INTENTS.UNCLEAR;
  const secondaryIntent = VALID_INTENTS.has(parsed?.secondaryIntent) ? parsed.secondaryIntent : null;
  const confidenceNumber = Number(parsed?.confidence);
  const confidence = Number.isFinite(confidenceNumber) ? Math.max(0, Math.min(1, confidenceNumber)) : 0;
  const productMentions = Array.isArray(parsed?.productMentions)
    ? parsed.productMentions.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 5)
    : [];
  const needsClarification = parsed?.needsClarification === true;
  return { primaryIntent, secondaryIntent, confidence, productMentions, needsClarification };
}

async function detectIntentWithGroq(phoneNumber, userMessage, history, awaitingState = {}) {
  const hard = applyHardIntentGuards(userMessage);
  if (hard) return { ...hard, productMentions: [], needsClarification: false };

  if (!config.groqApiKey) {
    return { primaryIntent: INTENTS.UNCLEAR, secondaryIntent: null, confidence: 0, source: "fallback", productMentions: [], needsClarification: true };
  }

  const recentWithCurrentMessage = recentContextForApi(history);
  const recent = recentWithCurrentMessage.length && recentWithCurrentMessage[recentWithCurrentMessage.length - 1]?.role === "user"
    ? recentWithCurrentMessage.slice(0, -1)
    : recentWithCurrentMessage;
  const awaiting = Object.keys(awaitingState || {}).filter((k) => awaitingState[k] === true);

  try {
    const response = await callGroqWithRetry({
      model: "openai/gpt-oss-20b",
      reasoning_effort: "low",
      max_tokens: 250,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Tu es le routeur d'intention de Sekhmet Shop.
Tu ne réponds PAS au client et tu ne choisis PAS de produit. Tu classes uniquement le besoin principal du dernier message avec le contexte récent.

Intentions possibles :
- ADD_TO_CART : le client veut acheter/ajouter un ou plusieurs produits précis.
- VALIDATE_ORDER : il veut valider/passer la commande à partir du panier.
- VIEW_CART : il veut voir son panier.
- ABANDON_CART : il veut annuler/abandonner son panier.
- ASK_PAYMENT_INFO : il demande comment payer ou les coordonnées Mobile Money AVANT paiement.
- PAYMENT_DONE : il affirme avoir payé/envoyé l'argent.
- SET_DELIVERY_MODE : il précise comment il veut récupérer sa commande (livraison à domicile, expédition car hors Yaoundé, ou il viendra la chercher en boutique) — même spontanément, sans qu'on le lui ait demandé, et même mélangé à une autre question dans le même message.
- PRODUCT_DETAIL : il demande des détails/photo sur UN produit précis.
- PRODUCT_QUERY : il cherche un produit ou demande s'il est disponible.
- RECOMMENDATION : il demande des recommandations de produits selon un besoin.
- HUMAN_REQUEST : il demande explicitement un humain, un collègue ou Coach Emy.
- COMPLAINT : réclamation, insatisfaction, produit endommagé, mauvais emballage/conditionnement, grammage incorrect, problème après achat.
- PARTNERSHIP : partenariat, collaboration professionnelle ou expertise professionnelle.
- TRAINING : question ou demande concernant les formations proposées par le cabinet.
- FAMILY_FOLLOWUP : demande de suivi/programme alimentaire personnalisé, notamment pour enfant ou famille.
- DELIVERY_INFORMATION : question sur livraison, délai, zone, frais ou suivi de livraison.
- GENERAL_INFORMATION : autre question générale sur Sekhmet Shop, Coach Emy, prix, horaires, fonctionnement.
- UNCLEAR : impossible à déterminer avec assez de confiance.

Règles critiques :
1. Une phrase de paiement EFFECTIVEMENT ENVOYÉ doit être PAYMENT_DONE, même si elle contient une autre formulation.
2. Une demande explicite d'humain/Coach Emy doit être HUMAN_REQUEST.
3. Une réclamation doit être COMPLAINT et jamais une simple question produit.
4. Une question sur les formations proposées est TRAINING.
5. Une demande de suivi/programme alimentaire personnalisé, surtout enfant/famille, est FAMILY_FOLLOWUP.
6. Une simple question sur les bienfaits d'un produit reste PRODUCT_QUERY ou RECOMMENDATION, pas FAMILY_FOLLOWUP.
7. Une simple demande du numéro de paiement AVANT d'avoir payé reste ASK_PAYMENT_INFO.
8. Conserve le contexte récent : une formulation courte comme « oui » ne doit être comprise qu'à partir de l'état en attente et des messages précédents.
9. Si le client précise SON MODE DE LIVRAISON dans le même message qu'une question de paiement (ex: "je veux me faire livrer, je paie comment ?"), classe en SET_DELIVERY_MODE (pas ASK_PAYMENT_INFO) : le mode doit être enregistré avant de donner les modalités de paiement, qui suivront automatiquement une fois toutes les informations logistiques réunies.
10. Si le message précédent du bot était une fiche produit ou une recommandation ("[Fiche produit envoyée : X]", "[Recommandation envoyée : ...]") et que le client exprime une intention d'achat portant sur ce(s) produit(s) — même sans pronom explicite — (ex: "je prends 2", "je vais prendre 2 bouteilles", "2 bouteilles", "je le veux", "je veux me faire livrer ça", "prends-en 3", "prends-le"), classe en ADD_TO_CART (pas SET_DELIVERY_MODE ni ASK_PAYMENT_INFO). Le produit doit d'abord être ajouté au panier. Le mode de livraison et le paiement seront traités dans les messages suivants une fois le panier constitué. Même si le message mélange achat + livraison + paiement, l'intention principale reste ADD_TO_CART.

État en attente actif : ${awaiting.length ? awaiting.join(", ") : "aucun"}

Réponds UNIQUEMENT en JSON :
{"primaryIntent":"...","secondaryIntent":"... ou null","confidence":0 à 1,"productMentions":["..."],"needsClarification":false}`,
        },
        ...recent,
        { role: "user", content: String(userMessage || "").slice(0, 700) },
      ],
    });

    await recordUsage({ type: "intent_routing", model: "openai/gpt-oss-20b", usage: response.usage, phoneNumber });

    const parsed = parseIntentReply(response.choices?.[0]?.message?.content || "{}", "detectIntentWithGroq");
    return { ...parsed, source: "groq-20b" };
  } catch (err) {
    log.warn("Échec du routeur d'intention Groq — repli sur UNCLEAR", { error: err?.message || String(err) });
    return { primaryIntent: INTENTS.UNCLEAR, secondaryIntent: null, confidence: 0, source: "fallback", productMentions: [], needsClarification: true };
  }
}

function createEscalationToolForCategory(category) {
  return {
    ...ESCALATION_TOOL,
    function: {
      ...ESCALATION_TOOL.function,
      description: `${ESCALATION_TOOL.function.description} La catégorie est imposée par la politique locale : ${category}.`,
      parameters: {
        type: "object",
        properties: {
          categorie: { type: "string", enum: [category] },
        },
        required: ["categorie"],
      },
    },
  };
}

function getMandatoryEscalationCategory(intentResult) {
  if (!intentResult) return null;
  if (intentResult.confidence < INTENT_CONFIDENCE_THRESHOLD) return null;
  return MANDATORY_ESCALATION_BY_INTENT[intentResult.primaryIntent] || null;
}

function buildToolsForIntent(intentResult, awaitingState = {}) {
  const mandatoryCategory = getMandatoryEscalationCategory(intentResult);
  if (mandatoryCategory) return [createEscalationToolForCategory(mandatoryCategory)];

  // En dessous du seuil, on ne donne au 120B aucun outil d'action métier.
  // Il peut donc demander une précision ou répondre en texte sans pouvoir
  // modifier le panier, déclencher un paiement ou lancer une escalade.
  if (
    !intentResult ||
    intentResult.confidence < INTENT_CONFIDENCE_THRESHOLD ||
    intentResult.primaryIntent === INTENTS.UNCLEAR ||
    intentResult.needsClarification === true
  ) {
    return NO_TOOLS;
  }

  switch (intentResult.primaryIntent) {
    case INTENTS.ADD_TO_CART:
      return [ADD_TO_CART_TOOL];
    case INTENTS.VALIDATE_ORDER:
      return [VALIDATE_CART_TOOL];
    case INTENTS.VIEW_CART:
      return [VIEW_CART_TOOL];
    case INTENTS.ABANDON_CART:
      return [ABANDON_CART_TOOL];
    case INTENTS.ASK_PAYMENT_INFO:
      // mode_livraison est inclus ici aussi (pas seulement pour
      // SET_DELIVERY_MODE) : un client qui demande "je paie comment ?"
      // précise très souvent son mode de livraison dans la même phrase
      // ("je veux me faire livrer, je paie comment ?"). Sans cela, le 120B
      // n'avait que infos_paiement à disposition et cette précision était
      // silencieusement perdue.
      // ajout_panier est aussi exposé : un message mixte du type
      // "je prends 2 bouteilles, je veux une livraison, envoie le numéro
      // de paiement" peut encore être classé ASK_PAYMENT_INFO / SET_DELIVERY_MODE
      // par le routeur 20B ; le 120B doit pouvoir ajouter le produit dans
      // le même tour (cas observé en prod après une fiche produit).
      return [PAYMENT_INFO_TOOL, REGISTER_DELIVERY_MODE_TOOL, ADD_TO_CART_TOOL];
    case INTENTS.SET_DELIVERY_MODE:
      // Même raison que pour ASK_PAYMENT_INFO : un message qui mélange
      // intention d'achat (quantité / "je prends X") + mode de livraison
      // doit pouvoir appeler ajout_panier en plus de mode_livraison.
      return [REGISTER_DELIVERY_MODE_TOOL, ADD_TO_CART_TOOL];
    case INTENTS.PRODUCT_DETAIL:
      // Inclut aussi "recommander" (pas seulement fiche_produit) : une
      // demande de photo peut porter sur PLUSIEURS produits à la fois
      // ("les photos stp", "envoie tout en même temps" après avoir discuté
      // de toute une catégorie) que le routeur 20B classe quand même en
      // PRODUCT_DETAIL. Sans "recommander" disponible ici, Groq n'avait
      // aucun outil capable d'envoyer plusieurs images et INVENTAIT à la
      // place un faux texte listant des "[photo de X]" — jamais de vraies
      // images envoyées (observé en prod).
      return [PRODUCT_DETAIL_TOOL, RECOMMENDATION_TOOL];
    case INTENTS.PRODUCT_QUERY:
      return [PRODUCT_DETAIL_TOOL, RECOMMENDATION_TOOL];
    case INTENTS.RECOMMENDATION:
      return [RECOMMENDATION_TOOL];
    case INTENTS.DELIVERY_INFORMATION:
    case INTENTS.GENERAL_INFORMATION:
    default:
      return NO_TOOLS;
  }
}

async function buildToolsForContextByIntent(awaitingState = {}, intentResult = null) {
  // Une escalade obligatoire reconnue par le routeur prime sur un état
  // d'attente : demander un humain, signaler une réclamation ou annoncer un
  // paiement doit toujours suivre son parcours métier dédié.
  const mandatoryCategory = getMandatoryEscalationCategory(intentResult);
  if (mandatoryCategory) return [createEscalationToolForCategory(mandatoryCategory)];

  // Sinon, l'état métier explicite reste prioritaire et expose uniquement
  // l'outil capable de répondre à la question actuellement posée.
  if (awaitingState.awaitingDeliveryAddress) return [REGISTER_DELIVERY_ADDRESS_TOOL];
  if (awaitingState.awaitingPaymentAccountInfo) return [REGISTER_MOMO_TOOL];
  if (awaitingState.awaitingCartAbandonConfirmation) return [CONFIRM_CART_ABANDON_TOOL];
  if (awaitingState.awaitingDeliveryConfirmation) return [CONFIRM_DELIVERY_PHONE_TOOL];
  if (awaitingState.awaitingClientName) return [REGISTER_CLIENT_NAME_TOOL];
  return buildToolsForIntent(intentResult || { primaryIntent: INTENTS.UNCLEAR, confidence: 0 }, awaitingState);
}

async function buildToolsForContext(awaitingState = {}, intentResult = null) {
  return buildToolsForContextByIntent(awaitingState, intentResult);
}

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
        ...sanitizeHistory(history)
          .filter((m) => m.role !== "system")
          .slice(-12)
          .map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 500) })),
      ],
    });

    await recordUsage({ type: "resume_escalade", model: "openai/gpt-oss-20b", usage: response.usage, phoneNumber });

    return response.choices[0].message.content;
  } catch (err) {
    log.error("Échec summarizeForHuman (appel Groq)", err);
    return "(résumé indisponible — erreur technique lors de la génération)";
  }
}

// Interprète une réponse client à une question de confirmation binaire déjà
// posée par le code (ex: "voulez-vous vraiment vider votre panier ?"),
// en remplacement des anciennes regex strictes ("oui|d'accord|..." /
// "non|garde|...") qui ne comprenaient pas les formulations naturelles
// ("bien sûr", "vas-y", "laisse tomber comme ça"). Le code appelant reste
// seul décisionnaire de l'action déclenchée : cette fonction ne fait
// qu'interpréter le texte, exactement comme interpretHumanMessageWithGroq
// le fait côté collaborateur (voir humanCommands.js).
export async function interpretYesNo(userMessage, questionContext, phoneNumber) {
  if (!config.groqApiKey) return "indetermine";
  try {
    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      max_tokens: 200,
      reasoning_effort: "low",
      messages: [
        {
          role: "system",
          content: `On vient de poser cette question au client : "${questionContext}". Classifie sa réponse ci-dessous. Réponds UNIQUEMENT par un seul mot, sans ponctuation : oui, non, ou indetermine (si la réponse ne répond pas clairement à la question).`,
        },
        { role: "user", content: String(userMessage || "").slice(0, 300) },
      ],
    });
    await recordUsage({ type: "classification_oui_non", model: "openai/gpt-oss-20b", usage: response.usage, phoneNumber });
    const raw = (response.choices?.[0]?.message?.content || "").trim().toLowerCase();
    if (raw.startsWith("oui")) return "oui";
    if (raw.startsWith("non")) return "non";
    return "indetermine";
  } catch (err) {
    log.error("Échec interpretYesNo (appel Groq)", err);
    return "indetermine";
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

// Le contexte envoyé à Groq est volontairement minimal. L'historique complet
// reste conservé pour l'interface d'administration, mais l'API ne reçoit que
// quelques messages récents, l'état structuré du client/panier et les règles
// métier pertinentes pour la question actuelle.
//
// NOTE PERF : ces constantes ont été légèrement réduites (8 -> 6 messages,
// 600 -> 400 caractères) pour limiter le poids de l'historique récent, en
// plus des autres optimisations (catalogue sans description, outils
// contextuels, descriptions d'outils raccourcies).
const MAX_RECENT_CONTEXT_MESSAGES = 6;
const MAX_MESSAGE_CONTEXT_CHARS = 400;
const MAX_FOCUSED_PROCEDURES_CHARS = 2800;

function recentContextForApi(history) {
  return sanitizeHistory(history)
    .filter((m) => m.role !== "system")
    .slice(-MAX_RECENT_CONTEXT_MESSAGES)
    .map((m) => ({
      role: m.role,
      content: String(m.content || "").slice(0, MAX_MESSAGE_CONTEXT_CHARS),
    }));
}

function normalizeTextForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

async function loadProceduresForContext() {
  const now = Date.now();
  if (proceduresCache.value && now - proceduresCache.loadedAt < PROCEDURES_CACHE_MS) {
    return proceduresCache.value;
  }
  const value = await proceduresStoreForContext.loadProcedures();
  proceduresCache = { value: String(value || ""), loadedAt: now };
  return proceduresCache.value;
}

function selectRelevantProcedureSections(procedures, userMessage) {
  const raw = String(procedures || "").trim();
  if (!raw) return "";

  // Le fichier de procédures est organisé en blocs séparés par des lignes
  // vides. Chaque bloc est sélectionné selon la question au lieu d'être
  // envoyé intégralement. L'identité reste toujours présente.
  const blocks = raw.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const text = normalizeTextForMatch(userMessage);
  // Blocs "de référence" : toujours envoyés au modèle quel que soit le score
  // de mots-clés, car ce sont des informations statiques qu'une question
  // peut formuler de trop de façons différentes pour être fiablement captée
  // par une liste de mots-clés (ex : "vous êtes où ?", "c'est où chez vous ?",
  // "quelle est votre adresse ?", "vous êtes situés où ?"...).
  const ALWAYS_INCLUDE_HEADERS = ["IDENTITÉ", "IDENTITE", "LOCALISATION"];
  const scores = blocks.map((block, index) => {
    const hay = normalizeTextForMatch(block);
    const alwaysInclude = index === 0 || ALWAYS_INCLUDE_HEADERS.some((h) => block.toUpperCase().startsWith(h));
    let score = alwaysInclude ? 100 : 0;
    const groups = [
      { score: 40, keys: ["paiement", "payer", "paye", "mobile money", "orange money", "mtn", "commande", "panier", "livraison", "adresse", "quantite"] },
      { score: 35, keys: ["reclamation", "remboursement", "endommage", "conditionne", "grammage", "escalade"] },
      { score: 35, keys: ["partenariat", "stage", "collaboration", "expertise", "formation", "programme alimentaire"] },
      { score: 30, keys: ["produit", "catalogue", "poudre", "savon", "creme", "beurre", "recommande", "digestion", "energie", "immunite", "gluten"] },
      { score: 20, keys: ["livraison", "yaounde", "quartier", "horaire", "ouvert", "ferme", "retard"] },
      { score: 15, keys: ["prix", "combien", "cout", "tarif"] },
      { score: 25, keys: ["localisation", "adresse", "situe", "situes", "situee", "localise", "ou etes", "ou se trouve", "ou vous trouvez", "boutique", "magasin", "carrefour", "quartier"] },
    ];
    for (const group of groups) {
      if (group.keys.some((k) => text.includes(k) && hay.includes(k))) score += group.score;
    }
    return { block, score, index };
  });

  const selected = scores
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .filter((x) => x.score > 0)
    .slice(0, 4)
    .map((x) => x.block);

  let result = selected.join("\n\n");
  if (result.length > MAX_FOCUSED_PROCEDURES_CHARS) {
    result = result.slice(0, MAX_FOCUSED_PROCEDURES_CHARS);
  }
  return result;
}

// NOTE PERF (réduction consommation tokens) : le catalogue n'envoie plus la
// description texte de chaque produit. Cette description est déjà transmise
// au client via les fiches produit (photo + description, cf. fiche_produit
// et recommander) : la dupliquer dans le prompt système à chaque appel
// coûtait des centaines/milliers de tokens sans bénéfice pour le routage,
// qui n'a besoin que du nom/prix/catégorie/stock pour raisonner.
function formatCatalogueLinesForContext(catalogue) {
  return (Array.isArray(catalogue) ? catalogue : [])
    .map((p) => {
      const category = p.categorie ? ` | ${p.categorie}` : "";
      const stock = p.stock === "rupture" ? " | rupture de stock" : "";
      return `- ${p.nom || "Produit"}${p.unite ? ` (${p.unite})` : ""} | ${p.prix ?? "prix non renseigné"}${category}${stock}`;
    })
    .join("\n");
}

async function buildFocusedGroqContext(phoneNumber, userMessage, client, history, awaitingState = {}) {
  const procedures = await loadProceduresForContext().catch((err) => {
    log.warn("Impossible de charger les procédures ciblées", { error: err?.message || String(err) });
    return "";
  });

  const [cart, catalogue] = await Promise.all([
    cartStoreForContext.getCart(phoneNumber).catch((err) => {
      log.warn("Impossible de charger le panier pour le contexte Groq", { error: err?.message || String(err) });
      return [];
    }),
    catalogueStore.loadCatalogue().catch((err) => {
      log.warn("Impossible de charger le catalogue pour le contexte Groq", { error: err?.message || String(err) });
      return [];
    }),
  ]);

  const cartLines = (Array.isArray(cart) ? cart : [])
    .slice(0, 10)
    .map((item) => `${Number(item.quantite) || 0} x ${String(item.nom || "produit").slice(0, 80)}`)
    .filter((line) => !line.startsWith("0 x"));

  const focusedProcedures = selectRelevantProcedureSections(procedures, userMessage);
  const recent = recentContextForApi(history);
  const intentResult = await detectIntentWithGroq(phoneNumber, userMessage, history, awaitingState);
  const toolsAvailable = await buildToolsForContextByIntent(awaitingState, intentResult);
  const catalogueLines = formatCatalogueLinesForContext(catalogue);

  // Section état d'attente : injectée seulement si un état actif existe.
  // Groq voit exactement quelle question a été posée et quel outil appeler
  // pour y répondre. Si le client change d'avis, Groq peut appeler un autre
  // outil à la place — aucune interception côté code.
  let awaitingSection = "";
  if (awaitingState.awaitingDeliveryAddress) {
    awaitingSection = `\nÉTAT EN ATTENTE : le bot vient de demander l'adresse de livraison au client. Si le message est une adresse, appelle "adresse". Si le client change d'avis ou veut faire autre chose, ignore cet état et traite sa demande normalement.`;
  } else if (awaitingState.awaitingPaymentAccountInfo) {
    // Format du numéro WhatsApp : 237XXXXXXXXX
    const whatsappNumber = phoneNumber;
    const localFormat = whatsappNumber.replace(/^237/, '');
    
    awaitingSection = `\nÉTAT EN ATTENTE : Le client doit donner son numéro Mobile Money pour le paiement.
NUMÉRO WHATSAPP DU CLIENT : ${whatsappNumber} (${localFormat})

INSTRUCTIONS SIMPLES :
1. Si le client dit "oui", "c'est ça", "c'est bon", "je l'ai fait", "exactement" → appelle IMMÉDIATEMENT "momo" avec le numéro ${whatsappNumber}
2. Si le client donne un numéro (ex: "6XXXXXXXX") → appelle "momo" avec ce numéro
3. Si le client donne un nom de compte → appelle "momo" avec ce nom

NE PAS RÉPONDRE EN TEXTE. TOUJOURS APPELER "momo".`;
  } else if (awaitingState.awaitingCartAbandonConfirmation) {
    awaitingSection = `\nÉTAT EN ATTENTE : le bot vient de demander confirmation pour vider le panier. Si le client confirme (oui, vas-y, etc.), appelle "abandon_ok" avec confirmed=true. Si le client refuse (non, garde, etc.), appelle "abandon_ok" avec confirmed=false. Si le client veut autre chose, traite sa demande normalement.`;
  } else if (awaitingState.awaitingDeliveryConfirmation) {
    awaitingSection = `\nÉTAT EN ATTENTE : le bot vient de demander au client de confirmer son numéro de téléphone pour la livraison. Si le client confirme, appelle "livraison_ok" avec confirmed=true. Si le client refuse ou donne un autre numéro, appelle "livraison_ok" avec confirmed=false. N'appelle JAMAIS "escalade" ici, même si le message contient "oui", "c'est bon" ou "c'est fait" : dans ce contexte précis, ce sont des réponses à la question du numéro de livraison, pas une nouvelle confirmation de paiement.`;
  } else if (awaitingState.awaitingClientName) {
    awaitingSection = `\nÉTAT EN ATTENTE : le bot vient de demander le nom du client avant de valider sa commande (nom obligatoire selon les procédures). Si le message contient un nom, même en un seul mot, appelle "nom_client" avec ce nom. Si le client change d'avis ou veut faire autre chose, ignore cet état et traite sa demande normalement.`;
  }

  // Une escalade vers un collaborateur peut déjà être en cours pour ce
  // client (réclamation, partenariat, paiement à vérifier, etc.). On ne
  // veut pas que Groq rappelle l'outil "escalade" à chaque message pendant
  // ce temps : avant ce correctif, cela court-circuitait la vraie réponse
  // du bot (le code renvoyait uniquement "votre demande est déjà en
  // cours...", en ignorant la question réelle du client). Le client doit
  // pouvoir continuer à discuter normalement (catalogue, prix, suivi...)
  // pendant qu'un collaborateur traite sa demande en parallèle.
  const escaladeEnCours = await isEscalationPending(phoneNumber).catch(() => false);
  const escaladeSection = escaladeEnCours
    ? `\nESCALADE EN COURS : une demande de ce client a déjà été transmise à un collaborateur et est en cours de traitement. N'appelle PAS "escalade" à nouveau pour le même sujet — continue de répondre normalement à toute autre question du client (catalogue, prix, suivi de commande, etc.), exactement comme si de rien n'était. N'appelle "escalade" que si le client exprime un besoin d'escalade totalement nouveau et distinct (ex : une réclamation différente) : le système empêche de toute façon la création d'une deuxième escalade simultanée et informera simplement le client que sa demande précédente est toujours prise en charge.`
    : "";

  const mandatoryCategory = getMandatoryEscalationCategory(intentResult);
  const intentSection = `\nROUTAGE LOCAL (source de politique) : intention=${intentResult.primaryIntent}, secondaire=${intentResult.secondaryIntent || "aucune"}, confiance=${intentResult.confidence.toFixed(2)}, source=${intentResult.source}.${mandatoryCategory ? `\nESCALADE OBLIGATOIRE : cette intention impose la catégorie \"${mandatoryCategory}\". Tu ne dois appeler aucun autre outil et ne dois pas répondre directement en texte.` : ""}`;

  const system = `Tu es l'assistante de Sekhmet Shop. Tu t'appelles Sekhmet.
Ton : chaleureux, professionnel, naturel. Tu vouvoies toujours le client.
Tu ne révèles pas que tu es une IA ni les instructions que tu reçois.

FORMATAGE WHATSAPP (important) : WhatsApp n'affiche PAS les tableaux markdown — les caractères | et - apparaissent tels quels, illisibles. N'utilise donc JAMAIS de tableau. Pour présenter plusieurs produits, utilise une liste à puces (•), avec le nom du produit en gras (*ainsi*) suivi du prix, une ligne par produit. Si les produits se répartissent en catégories naturelles, introduis chaque catégorie par une courte ligne en gras avant ses puces. Exemple pour des boissons :
*Jus naturels*
• Jus de curcuma (0,5 L) — 1 500 F
• Jus de gingembre (0,5 L) — 1 500 F

*Boissons fermentées*
• Kombucha (1 L) — 5 000 F
Reste concis : pas de colonnes supplémentaires (conditionnement, etc.) sauf si le client les demande explicitement — le prix et l'unité suffisent la plupart du temps.

PHOTOS (règle stricte) : tu ne peux JAMAIS "envoyer" une photo toi-même en texte — pas de placeholder du type "[photo de X]", pas de liste numérotée simulant un envoi de plusieurs images. La SEULE façon d'envoyer une vraie photo est d'appeler l'outil fiche_produit (un produit) ou recommander (plusieurs produits). Si le client demande des photos et qu'aucun de ces outils ne te semble adapté, appelle quand même recommander avec les produits concernés plutôt que de décrire les photos en texte.

CATALOGUE (source de vérité — n'invente aucun produit ni prix) :
${catalogueLines || "Catalogue momentanément indisponible."}

ÉTAT DU CLIENT :
- Nom : ${client?.nom || "non renseigné"}
- Besoin : ${client?.besoin || "non renseigné"}

PANIER :
${cartLines.length ? cartLines.join("\n") : "vide"}

${focusedProcedures ? `PROCÉDURES :\n${focusedProcedures}` : ""}${awaitingSection}${escaladeSection}${intentSection}

OUTILS : Appelle un outil quand le message du client correspond clairement à l'un d'eux ci-dessous. Sinon, réponds normalement en texte.

Exemples de routage (mêmes outils, mêmes règles — juste illustrés par des cas concrets plutôt que par des phrases de règle) :
- "un pain, un cupcake et 3 chouquettes" -> ajout_panier (produits nommés, un seul appel pour les 3)
- "oui vas-y, je paie comment ?" -> PAS ajout_panier (aucun produit nommé dans ce message) -> valider ou infos_paiement selon le cas
- "c'est bon, prépare ma commande" -> PAS ajout_panier -> valider
- "vous avez du miel ?" / "montre-moi le savon noir" -> fiche_produit (un seul produit précis)
- "qu'est-ce que vous recommandez pour la digestion ?" -> recommander (2-3 produits en réponse à un besoin, pas un produit déjà nommé)
- "tous les pains" / "toutes vos photos de jus" / "montre-moi toute la catégorie X" -> recommander AVEC TOUS les produits correspondants de cette catégorie/famille (pas seulement 2-3) : envoie une seule fois toutes les fiches, ne demande jamais au client de préciser un produit à la fois pour ce genre de demande explicite de "tous les X".
- "6XXXXXXXX" ou "oui c'est ça" (numéro Mobile Money donné/confirmé, état en attente actif) -> momo
- "j'ai payé" / "c'est réglé" / "je viens d'envoyer l'argent" -> escalade (catégorie "paiement")
- "je veux parler à quelqu'un" -> escalade (catégorie "contact_humain")
- une adresse donnée alors qu'elle est demandée (voir ÉTAT EN ATTENTE) -> adresse
- juste après avoir envoyé une fiche produit ("[Fiche produit envoyée : Box de mignardises]" ou "[Fiche produit envoyée : Jus de gingembre]"), le client répond "je veux me faire livrer ça", "je le veux", "je vais prendre 2 bouteilles", "je prends 2", "2 bouteilles" -> ajout_panier avec le nom du produit de la fiche (résous le pronom OU la quantité implicite depuis le dernier produit montré, ne réponds jamais en texte en demandant "quel produit ?"). Même si le message mélange aussi livraison et/ou paiement, appelle d'abord ajout_panier.

Règle clé à retenir (source d'une confusion déjà observée) : "ajout_panier" exige de savoir QUEL produit précis est visé dans CE message, soit par son nom explicite, soit par un pronom ("ça", "celui-là", "je le veux") ou une quantité implicite ("je prends 2", "2 bouteilles") qui renvoie sans ambiguïté au produit UNIQUE montré dans le tout dernier message du bot (fiche_produit). Dans ces cas, résous toi-même le produit et utilise son vrai nom. En revanche, une confirmation générale sans référence à un produit précis ("oui", "c'est bon", "vas-y" en réponse à autre chose qu'une fiche produit) ne doit JAMAIS réajouter au panier les produits déjà présents — dans ce cas, utilise "valider"/"infos_paiement", ou réponds simplement en texte.

Lis les messages précédents pour comprendre le contexte avant de répondre ou d'appeler un outil.`;

  return { system, recent, cartLines, intent: intentResult, toolsAvailable };
}

function toApiMessage({ role, content, name, tool_calls, tool_call_id }) {
  const msg = { role, content };
  if (name !== undefined) msg.name = name;
  if (tool_calls !== undefined) msg.tool_calls = tool_calls;
  if (tool_call_id !== undefined) msg.tool_call_id = tool_call_id;
  return msg;
}

// Appelle Groq avec un retry simple en cas de 429 (limite de tokens/minute
// atteinte au niveau de l'organisation). Le message d'erreur Groq indique le
// nombre de secondes à attendre ("Please try again in 30.045s") : on
// l'utilise directement plutôt qu'un délai fixe, avec une petite marge de
// sécurité. Cela évite qu'un pic de trafic ponctuel se traduise par une
// erreur visible côté client alors qu'un court réessai aurait suffi.
async function callGroqWithRetry(params, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await groq.chat.completions.create(params);
    } catch (err) {
      const isRateLimit = err?.status === 429 || err?.error?.code === "rate_limit_exceeded";
      if (isRateLimit && attempt < maxRetries) {
        const match = String(err?.message || "").match(/try again in ([\d.]+)s/i);
        const waitSeconds = match ? Number(match[1]) : 2;
        const delayMs = Math.min((Number.isFinite(waitSeconds) ? waitSeconds : 2) + 0.5, 15) * 1000;
        log.warn("Limite de tokens Groq atteinte, nouvelle tentative", {
          attempt: attempt + 1,
          delayMs,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Remplace l'ancien duo classifyMessage() + askGroq(). Un seul appel Groq
 * (modèle 120b) qui, selon le message, répond directement en texte OU
 * appelle l'outil "escalade" — le modèle voit l'historique
 * complet dans les deux cas, contrairement à l'ancienne classification
 * isolée qui ne voyait que le dernier message.
 *
 * Retourne :
 *   { type: "reply", text }              -> réponse normale à envoyer telle quelle
 *   { type: "escalade", categorie }       -> à transmettre à enqueueEscalation()
 *   { type: "paiement" }                  -> à transmettre à requestPaymentConfirmation()
 */
/**
 * Moteur conversationnel principal : Groq comprend le message dans son
 * contexte récent et décide soit de répondre, soit d'appeler un outil métier.
 *
 * Le code local n'interprète volontairement plus les intentions naturelles
 * (paiement, réclamation, recommandation, fiche produit, etc.). Les actions
 * sensibles restent déterministes une fois demandées par Groq : on vérifie le
 * produit dans le catalogue, les comptes de paiement viennent de la config,
 * et les escalades passent par le flux humain existant.
 */
// Aucun produit de la boutique ne coûte raisonnablement plus de 500 000 F
// l'unité. Ce plafond n'est PAS une règle métier : c'est un garde-fou
// contre une donnée corrompue dans le catalogue (ex: un prix mal saisi côté
// admin, "35000570001" au lieu de "3500") qui produirait sinon un panier et
// une facture avec un total absurde ("560 009 120 016 F") envoyés tels
// quels au client — comme observé en production. Si un prix dépasse ce
// plafond, on refuse l'ajout et on prévient plutôt que de calculer un total
// délirant. Complémentaire (pas redondant) avec MAX_ITEM_QUANTITY et
// SUSPICIOUS_TOTAL_THRESHOLD_FCFA côté payment.service.js : ceux-ci
// plafonnent une quantité/un total déjà valides, celui-ci rejette un prix
// UNITAIRE aberrant avant même qu'il entre dans le panier.
const PRIX_UNITAIRE_MAX_RAISONNABLE = 500_000;

function prixUnitaireValide(prixUnitaire) {
  return Number.isFinite(prixUnitaire) && prixUnitaire > 0 && prixUnitaire <= PRIX_UNITAIRE_MAX_RAISONNABLE;
}

const STATE_PRIORITY_TOOL_NAMES = new Set([
  "adresse",
  "nom_client",
  "momo",
  "abandon_ok",
  "livraison_ok",
]);

function getExpectedStateToolName(awaitingState = {}) {
  if (awaitingState.awaitingDeliveryAddress) return "adresse";
  if (awaitingState.awaitingPaymentAccountInfo) return "momo";
  if (awaitingState.awaitingCartAbandonConfirmation) return "abandon_ok";
  if (awaitingState.awaitingDeliveryConfirmation) return "livraison_ok";
  if (awaitingState.awaitingClientName) return "nom_client";
  return null;
}

const TOOL_NAMES_BY_INTENT = Object.freeze({
  [INTENTS.ADD_TO_CART]: new Set(["ajout_panier"]),
  [INTENTS.VALIDATE_ORDER]: new Set(["valider"]),
  [INTENTS.VIEW_CART]: new Set(["panier"]),
  [INTENTS.ABANDON_CART]: new Set(["abandonner"]),
  [INTENTS.ASK_PAYMENT_INFO]: new Set(["infos_paiement", "mode_livraison", "ajout_panier"]),
  [INTENTS.SET_DELIVERY_MODE]: new Set(["mode_livraison", "ajout_panier"]),
  [INTENTS.PRODUCT_DETAIL]: new Set(["fiche_produit", "recommander"]),
  [INTENTS.PRODUCT_QUERY]: new Set(["fiche_produit", "recommander"]),
  [INTENTS.RECOMMENDATION]: new Set(["recommander"]),
});

function isToolAllowedForIntent(toolName, intentResult) {
  if (!toolName || !intentResult) return false;

  const mandatoryCategory = getMandatoryEscalationCategory(intentResult);
  if (toolName === "escalade") return Boolean(mandatoryCategory);

  if (STATE_PRIORITY_TOOL_NAMES.has(toolName)) return false;

  return TOOL_NAMES_BY_INTENT[intentResult.primaryIntent]?.has(toolName) === true;
}

function makeToolRejectedReply(history, phoneNumber, toolName, intentResult) {
  const reply = "Je veux m'assurer de bien comprendre votre demande. Pouvez-vous me préciser ce que vous souhaitez faire ?";
  log.warn("Outil Groq rejeté par la politique locale", {
    phoneNumber,
    outilChoisi: toolName,
    intent: intentResult?.primaryIntent,
    confiance: intentResult?.confidence,
  });
  history.push({ role: "assistant", content: reply, timestamp: new Date().toISOString() });
  persistHistory(phoneNumber, history);
  return { type: "reply", text: reply, source: "deterministic-tool-policy" };
}

export async function handleClientMessage(phoneNumber, userMessage, options = {}) {
  const history = await getHistory(phoneNumber);
  if (!options.skipUserHistory) {
    history.push({ role: "user", content: userMessage, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
  }

  const clients = await clientsStore.loadClients();
  const client = options.client || clients[phoneNumber] || {};

  // Seules les commandes textuelles parfaitement explicites restent locales.
  // Une formulation naturelle comme « c bon c fait » ou « tu as vérifié ? »
  // doit obligatoirement passer par Groq afin d'être comprise avec son contexte.
  if (isDemandeCatalogueComplet(userMessage)) {
    const reply = formatCatalogueComplet(await catalogueStore.loadCatalogue());
    history.push({ role: "assistant", content: reply, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "reply", text: reply, source: "local-deterministic" };
  }

  const start = Date.now();
  let response;
  // Déclaré ici (et non avec `const` dans le try ci-dessous) car il est
  // aussi lu APRÈS le bloc try/catch (logs de routage, validations post-120B
  // lignes ~1240+) — un `const` scopé au bloc y était invisible et
  // provoquait un crash total ("focusedContext is not defined") sur CHAQUE
  // message, dès que l'appel Groq réussissait.
  let focusedContext;
  try {
    if (!config.groqApiKey) {
      const fallback = "Je veux bien vous aider. Pouvez-vous me préciser ce que vous recherchez ?";
      history.push({ role: "assistant", content: fallback, timestamp: new Date().toISOString() });
      persistHistory(phoneNumber, history);
      return { type: "reply", text: fallback, source: "local-fallback" };
    }

    focusedContext = await buildFocusedGroqContext(phoneNumber, userMessage, client, history, options.awaitingState || {});
    response = await callGroqWithRetry({
      model: "openai/gpt-oss-120b",
      // Relevé de 600 à 1000 : une réponse "PRODUCT_QUERY" qui énumère
      // plusieurs produits avec description dépasse régulièrement 600
      // tokens, et Groq coupait alors la génération EN PLEIN MILIEU d'une
      // phrase — le message tronqué partait quand même vers le client tel
      // quel (observé en prod : completionTokens strictement égal à
      // max_tokens, signe explicite d'une coupure et non d'une fin
      // naturelle de réponse). 1000 laisse de la marge pour une liste de
      // produits tout en restant large sous la limite WhatsApp (4096 car.).
      max_tokens: 1000,
      // NOTE : revenu à "medium" (après un passage à "low" qui a été
      // observé corrélé à un mauvais routage — une simple confirmation sans
      // nom de produit, ex. "oui prepare ma commande, je paie comment?", a
      // été interprétée comme un nouvel appel "ajout_panier" et a fait
      // doubler les quantités déjà en panier). La fiabilité du routage prime
      // sur l'économie de tokens ici : "low" reste risqué tant que le
      // catalogue/outils ne sont pas encore réduits davantage.
      reasoning_effort: "medium",
      // NOTE PERF : seuls les outils pertinents pour l'état en attente
      // actuel sont envoyés (voir buildToolsForContext), au lieu des 13
      // outils systématiquement à chaque appel.
      tools: focusedContext.toolsAvailable,
      // Auparavant forcé via tool_choice quand un seul outil était proposé,
      // pour empêcher le 120B de répondre en texte libre plausible SANS
      // appeler l'outil (rien n'était alors enregistré malgré un message de
      // confirmation convaincant). Mais Groq valide ce forçage de façon
      // stricte : si le modèle ne s'y plie pas, il échoue avec un 400 —
      // soit en tentant d'appeler un outil hors de la liste fournie
      // ("tool_use_failed" / not in request.tools"), soit en répondant
      // quand même en texte ("Tool choice is required, but model did not
      // call a tool"). Le forçage a donc remplacé un bug silencieux par un
      // crash pur et simple, ce qui est pire. On repasse en "auto" dans
      // tous les cas ; le filet de sécurité ci-dessous (toolCall manquant
      // avec un seul outil proposé) reste la protection contre le cas
      // initial, sans dépendre d'une contrainte API fragile.
      tool_choice: "auto",
      messages: [
        { role: "system", content: focusedContext.system },
        ...focusedContext.recent,
      ].map(toApiMessage),
    });
  } catch (err) {
    log.error("Échec de l'appel Groq (handleClientMessage)", err);
    
    // Les erreurs de tool call ne doivent jamais déclencher une escalade
    // générique : une catégorie métier ne peut être décidée que par le routeur
    // 20B et sa politique locale. On conserve simplement une réponse de repli.
    //
    // err?.error?.code === "tool_use_failed" couvre les deux variantes
    // observées en prod sous ce même code Groq : un outil hors de la liste
    // fournie ("... which was not in request.tools") ET un refus du modèle
    // de répondre en texte quand un outil était requis ("Tool choice is
    // required, but model did not call a tool") — cette dernière ne
    // contient aucune des sous-chaînes ci-dessous et échappait donc
    // jusqu'ici à ce filet de sécurité, remontant sans réponse utile au
    // client jusqu'au catch générique de webhook.routes.js.
    if (
      err?.error?.code === "tool_use_failed" ||
      err.message?.includes("tool call validation failed") ||
      err.message?.includes("signaler_bespecial") ||
      err.message?.includes("Failed to parse tool call arguments as JSON")
    ) {
      log.warn("Échec de validation/parsing d'un tool Groq — aucun fallback d'escalade générique", {
        error: err.message,
      });
      const fallbackReply = "Je veux m'assurer de bien comprendre votre demande. Pouvez-vous la reformuler en quelques mots ?";
      history.push({ role: "assistant", content: fallbackReply, timestamp: new Date().toISOString() });
      persistHistory(phoneNumber, history);
      return { type: "reply", text: fallbackReply, source: "fallback-tool-error" };
    }

    // Gestion spéciale : limite de tokens/minute Groq toujours dépassée
    // après les tentatives de callGroqWithRetry. On répond quand même au
    // client au lieu de le laisser sans réponse, pour préserver la fluidité
    // de la conversation même en cas de pic de charge.
    const isRateLimit = err?.status === 429 || err?.error?.code === "rate_limit_exceeded";
    if (isRateLimit) {
      log.warn("Limite Groq toujours atteinte après retries, réponse de patience envoyée");
      const fallbackReply = "Un instant s'il vous plaît, je traite beaucoup de messages en ce moment 🙏 Pouvez-vous répéter votre demande dans quelques secondes ?";
      history.push({ role: "assistant", content: fallbackReply, timestamp: new Date().toISOString() });
      persistHistory(phoneNumber, history);
      return { type: "reply", text: fallbackReply, source: "fallback-rate-limit" };
    }
    
    throw err;
  }

  log.info("Appel Groq terminé", {
    phoneNumber,
    durationMs: Date.now() - start,
    promptTokens: response.usage?.prompt_tokens,
    completionTokens: response.usage?.completion_tokens,
    totalTokens: response.usage?.total_tokens,
  });
  // Diagnostic direct d'une réponse tronquée par le plafond de tokens :
  // sans ce log, une troncature (finish_reason "length") n'était visible
  // qu'indirectement en remarquant que completionTokens == max_tokens.
  if (response.choices?.[0]?.finish_reason === "length") {
    log.warn("Réponse Groq tronquée par max_tokens — message potentiellement incomplet envoyé au client", {
      phoneNumber,
      completionTokens: response.usage?.completion_tokens,
    });
  }
  await recordUsage({ type: "reponse", model: "openai/gpt-oss-120b", usage: response.usage, phoneNumber });

  const message = response.choices[0].message;
  const toolCall = message.tool_calls?.[0];

  // Filet de sécurité pour le forçage ci-dessus : si un seul outil était
  // proposé (donc censé être obligatoire) et qu'aucun tool_call n'est
  // pourtant revenu, on ne fait PAS confiance au texte libre renvoyé par
  // le modèle dans ce cas précis — c'est exactement le scénario observé en
  // prod qui a produit une conversation entière hallucinée (mode de
  // livraison, adresse, numéro Mobile Money jamais enregistrés malgré des
  // messages de confirmation très convaincants). On préfère une reformulation
  // neutre à un texte qui prétend avoir enregistré quelque chose qui ne l'a
  // pas été.
  if (focusedContext.toolsAvailable.length === 1 && !toolCall) {
    log.error("Outil attendu non appelé (un seul outil légitime proposé) — réponse texte du modèle ignorée", {
      phoneNumber,
      outilAttendu: focusedContext.toolsAvailable[0]?.function?.name,
      intent: focusedContext.intent?.primaryIntent,
      texteModele: String(message.content || "").slice(0, 200),
    });
    const repli = "Je veux m'assurer de bien enregistrer votre demande. Pouvez-vous reformuler en quelques mots ?";
    history.push({ role: "assistant", content: repli, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "reply", text: repli, source: "fallback-forced-tool-missing" };
  }

  // NOTE DIAGNOSTIC : trace explicite de l'outil choisi (ou "aucun" si
  // Groq a répondu en texte) avec le message client qui l'a déclenché.
  // Sans ce log, un mauvais routage n'est visible qu'indirectement (via une
  // conséquence en aval, ex: un panier mal rempli) — avec, on peut relire
  // les logs et repérer les formulations qui déclenchent systématiquement
  // le mauvais outil, pour ajuster la description de l'outil concerné.
  log.info("Routage Groq", {
    phoneNumber,
    intent: focusedContext.intent?.primaryIntent,
    intentSecondaire: focusedContext.intent?.secondaryIntent,
    confiance: focusedContext.intent?.confidence,
    source: focusedContext.intent?.source,
    outil: toolCall?.function?.name || "aucun (réponse texte)",
    outilsAutorises: (focusedContext.toolsAvailable || []).map((tool) => tool?.function?.name).filter(Boolean),
    messageClient: String(userMessage || "").slice(0, 200),
  });

  const mandatoryCategoryAfterModel = getMandatoryEscalationCategory(focusedContext.intent);
  if (mandatoryCategoryAfterModel) {
    if (toolCall?.function?.name !== "escalade") {
      log.warn("Le modèle 120B a tenté de contourner une escalade obligatoire — politique locale appliquée", {
        phoneNumber,
        intent: focusedContext.intent?.primaryIntent,
        categorie: mandatoryCategoryAfterModel,
        outilChoisi: toolCall?.function?.name || "aucun",
      });
    }
    persistHistory(phoneNumber, history);
    return mandatoryCategoryAfterModel === "paiement"
      ? { type: "paiement", source: "intent-policy" }
      : { type: "escalade", categorie: mandatoryCategoryAfterModel, source: "intent-policy" };
  }

  const selectedToolName = toolCall?.function?.name || null;
  const hasStatePriority =
    Boolean(options.awaitingState?.awaitingDeliveryAddress) ||
    Boolean(options.awaitingState?.awaitingPaymentAccountInfo) ||
    Boolean(options.awaitingState?.awaitingCartAbandonConfirmation) ||
    Boolean(options.awaitingState?.awaitingDeliveryConfirmation) ||
    Boolean(options.awaitingState?.awaitingClientName);

  if (selectedToolName && !hasStatePriority && !isToolAllowedForIntent(selectedToolName, focusedContext.intent)) {
    return makeToolRejectedReply(history, phoneNumber, selectedToolName, focusedContext.intent);
  }

  const expectedStateTool = getExpectedStateToolName(options.awaitingState || {});
  if (selectedToolName && hasStatePriority && selectedToolName !== expectedStateTool) {
    return makeToolRejectedReply(history, phoneNumber, selectedToolName, focusedContext.intent);
  }

  if (toolCall?.function?.name === "ajout_panier") {
    let demandes = [];
    try { demandes = JSON.parse(toolCall.function.arguments).produits || []; }
    catch (err) { log.error("Argument de l'outil ajout_panier illisible", { raw: toolCall.function.arguments, err }); }

    const catalogue = await catalogueStore.loadCatalogue();
    const ajoutes = [];
    const introuvables = [];
    const prixInvalides = [];

    // Une seule requête client ("un pain, un cupcake et trois chouquettes")
    // peut contenir plusieurs produits : on les résout et on les ajoute
    // TOUS directement au panier ici, sans jamais renvoyer de liste
    // interactive de quantité (l'ancien "bottom sheet" bloquait la
    // conversation sur un seul produit à la fois).
    for (const demande of demandes.slice(0, 10)) {
      const nomProduit = String(demande?.nom_produit || "").trim();
      if (!nomProduit) continue;
      const produit = trouverProduitParNom(catalogue, nomProduit);
      if (!produit) {
        introuvables.push(nomProduit);
        continue;
      }
      const quantiteBrute = Math.trunc(Number(demande?.quantite));
      const quantite = Number.isFinite(quantiteBrute) && quantiteBrute > 0 ? quantiteBrute : 1;
      const prixUnitaire = parsePrixEnNombre(produit.prix);
      if (!prixUnitaireValide(prixUnitaire)) {
        log.error("Prix catalogue invalide/aberrant — ajout au panier refusé", { produit: produit.nom, prixBrut: produit.prix, prixUnitaire });
        prixInvalides.push(produit.nom);
        continue;
      }
      const total = prixUnitaire * quantite;
      await recordProductSelection(phoneNumber, {
        produitId: produit.id,
        nom: produit.nom,
        quantite,
        prixUnitaire,
        total,
      });
      ajoutes.push({ nom: produit.nom, quantite });
    }

    if (!ajoutes.length) {
      let repli;
      if (prixInvalides.length) {
        repli = `Désolé, il y a un souci technique avec le prix de ${prixInvalides.length > 1 ? "ces produits" : "ce produit"} (${prixInvalides.join(", ")}) — je transmets à un collaborateur pour correction. En attendant, puis-je vous aider avec autre chose ?`;
        await enqueueEscalation(phoneNumber, `Prix invalide détecté dans le catalogue pour : ${prixInvalides.join(", ")}`).catch((err) => log.error("Échec escalade prix invalide", err));
      } else if (introuvables.length) {
        repli = `Je n'ai pas trouvé ${introuvables.length > 1 ? "ces produits" : "ce produit"} dans notre catalogue : ${introuvables.join(", ")}. Pouvez-vous préciser leur nom exact ?`;
      } else {
        repli = "Je n'ai pas trouvé de produit à ajouter dans votre message. Pouvez-vous préciser ce que vous souhaitez commander ?";
      }
      history.push({ role: "assistant", content: repli, timestamp: new Date().toISOString() });
      persistHistory(phoneNumber, history);
      return { type: "reply", text: repli, source: "deterministic-validation" };
    }

    const lignesAjoutees = ajoutes.map((a) => `✅ ${a.quantite} x *${a.nom}*`).join("\n");
    const noteIntrouvables = introuvables.length
      ? `\n\n⚠️ Je n'ai pas trouvé dans notre catalogue : ${introuvables.join(", ")}. Pouvez-vous préciser ?`
      : "";
    const confirmation = `${lignesAjoutees} ajouté${ajoutes.length > 1 ? "s" : ""} au panier.${noteIntrouvables}\n\n${formatCart(phoneNumber)}\n\nVous pouvez ajouter d'autres produits, ou me dire quand vous voulez passer votre commande.`;

    // Extraction déterministe secondaire sur le MÊME message (sans 2e appel Groq,
    // sans élargir les tools). Couvre les messages composés du type
    // "2 bouteilles + livraison au quartier foudas + je paie comment ?".
    // - mode de livraison
    // - adresse / quartier (si mode livraison ou expédition)
    // - demande de paiement → enchaînement logistique (nom restant, etc.)
    const modeDetecte = detectDeliveryModeFromText(userMessage);
    if (modeDetecte && !hasDeliveryMode(phoneNumber)) {
      // On repasse le message original : provideDeliveryModeFromText re-détecte
      // en interne. modeDetecte non-null ⇒ enregistrement sans message d'ambiguïté.
      const ok = await provideDeliveryModeFromText(phoneNumber, userMessage);
      if (ok) {
        log.info("Mode de livraison extrait du message d'ajout au panier", {
          phoneNumber,
          mode: modeDetecte,
        });
      }
    }

    const modeActuel = getDeliveryMode(phoneNumber) || modeDetecte;
    if (
      (modeActuel === "livraison" || modeActuel === "expedition") &&
      !hasDeliveryAddress(phoneNumber)
    ) {
      const adresseDetectee = extractDeliveryAddressFromText(userMessage);
      if (adresseDetectee) {
        const okAdresse = await provideDeliveryAddress(phoneNumber, adresseDetectee);
        if (okAdresse) {
          log.info("Adresse de livraison extraite du message d'ajout au panier", {
            phoneNumber,
            adresse: adresseDetectee,
          });
        }
      }
    }

    const demandePaiement = /paiement|payer|mobile\s*money|momo|num[eé]ro\s*(?:de\s*)?paiement|infos?\s*(?:de\s*)?paiement|comment\s+(?:je\s+)?(?:peux\s+)?payer|coordonn[eé]es\s*(?:de\s*)?paiement/i.test(
      String(userMessage || "")
    );

    history.push({ role: "assistant", content: confirmation, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);

    if (demandePaiement) {
      log.info("Demande de paiement détectée dans le message d'ajout au panier — enchaînement logistique", {
        phoneNumber,
      });
      // text = confirmation panier à envoyer AVANT d'entrer dans le flux paiement
      return { type: "demande_infos_paiement", text: confirmation, source: "deterministic-secondary" };
    }

    return { type: "reply", text: confirmation, source: "groq-tool" };
  }

  if (toolCall?.function?.name === "fiche_produit") {
    let nomProduit = "";
    try { nomProduit = JSON.parse(toolCall.function.arguments).nom_produit; }
    catch (err) { log.error("Argument de l'outil fiche_produit illisible", { raw: toolCall.function.arguments, err }); }
    const catalogue = await catalogueStore.loadCatalogue();
    const produit = trouverProduitParNom(catalogue, nomProduit);
    if (!produit) {
      const repli = "Je n'ai pas trouvé ce produit précis dans notre catalogue. Pouvez-vous préciser son nom ?";
      history.push({ role: "assistant", content: repli, timestamp: new Date().toISOString() });
      persistHistory(phoneNumber, history);
      return { type: "reply", text: repli, source: "deterministic-validation" };
    }
    history.push({ role: "assistant", content: `[Fiche produit envoyée : ${produit.nom}]`, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "fiche_produit", produit: { ...produit, imageUrl: produit.imageUrl || produit.image_url || "" }, source: "groq" };
  }

  if (toolCall?.function?.name === "mode_livraison") {
    let mode = "";
    try { mode = JSON.parse(toolCall.function.arguments).mode || ""; }
    catch (err) { log.error("Argument mode_livraison illisible", { raw: toolCall.function.arguments, err }); }
    history.push({ role: "assistant", content: `[Mode de livraison indiqué : ${mode}]`, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "mode_livraison", mode, source: "groq-tool" };
  }

  if (toolCall?.function?.name === "infos_paiement") {
    // Ne formate plus les modalités de paiement ici : elles ne doivent
    // partir qu'une fois le nom, le mode de livraison ET l'adresse/moment
    // de retrait connus (voir sendCartPaymentInstructions dans
    // webhook.routes.js, la même porte que pour "valider"). Avant ce
    // correctif, une question directe ("je paie comment ?") contournait
    // entièrement cette vérification — observé en prod : un client a reçu
    // le numéro Mobile Money sans que son mode de livraison ni son adresse
    // n'aient jamais été demandés.
    history.push({ role: "assistant", content: "[Demande d'informations de paiement]", timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "demande_infos_paiement", source: "groq-tool" };
  }

  if (toolCall?.function?.name === "recommander") {
    let nomsProduits = [];
    try { nomsProduits = JSON.parse(toolCall.function.arguments).produits || []; }
    catch (err) { log.error("Argument de l'outil recommander illisible", { raw: toolCall.function.arguments, err }); }
    const catalogue = await catalogueStore.loadCatalogue();
    const produits = nomsProduits
      .slice(0, 8)
      .map((nom) => trouverProduitParNom(catalogue, nom))
      .filter(Boolean)
      .filter((p, index, arr) => p.stock !== "rupture" && arr.findIndex((x) => String(x.id) === String(p.id)) === index)
      .map((p) => ({ ...p, imageUrl: p.imageUrl || p.image_url || "" }));
    if (!produits.length) {
      const repli = "Je n'ai pas trouvé les produits demandés dans notre catalogue. Pouvez-vous préciser votre besoin ?";
      history.push({ role: "assistant", content: repli, timestamp: new Date().toISOString() });
      persistHistory(phoneNumber, history);
      return { type: "reply", text: repli, source: "deterministic-validation" };
    }
    history.push({ role: "assistant", content: `[Recommandation envoyée : ${produits.map((p) => p.nom).join(", ")}]`, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "recommandation", produits, source: "groq" };
  }

  if (toolCall?.function?.name === "abandonner") {
    const requested = await requestCartAbandonConfirmation(phoneNumber);
    const reply = requested
      ? "Je comprends que vous ne souhaitez plus poursuivre cette commande. Voulez-vous que je vide votre panier ? Répondez simplement oui ou non."
      : "Votre panier est déjà vide.";
    history.push({ role: "assistant", content: reply, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "reply", text: reply, source: "groq-tool" };
  }

  if (toolCall?.function?.name === "panier") {
    history.push({ role: "assistant", content: "[Consultation du panier]", timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "voir_panier", source: "groq-tool" };
  }

  if (toolCall?.function?.name === "valider") {
    history.push({ role: "assistant", content: "[Validation de la commande demandée]", timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "valider_panier", source: "groq-tool" };
  }

  if (toolCall?.function?.name === "adresse") {
    let adresse = "";
    try { adresse = JSON.parse(toolCall.function.arguments).adresse || ""; }
    catch (err) { log.error("Argument adresse illisible", { raw: toolCall.function.arguments, err }); }
    history.push({ role: "assistant", content: `[Adresse de livraison enregistrée : ${adresse}]`, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "adresse_livraison", adresse, source: "groq-tool" };
  }

  if (toolCall?.function?.name === "nom_client") {
    let nom = "";
    try { nom = JSON.parse(toolCall.function.arguments).nom || ""; }
    catch (err) { log.error("Argument nom illisible", { raw: toolCall.function.arguments, err }); }
    history.push({ role: "assistant", content: `[Nom du client enregistré : ${nom}]`, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "nom_client", nom, source: "groq-tool" };
  }

  if (toolCall?.function?.name === "momo") {
    let numero = "", nomCompte = "";
    try {
      const args = JSON.parse(toolCall.function.arguments);
      numero = args.numero || "";
      nomCompte = args.nom_compte || "";
    } catch (err) { log.error("Argument momo illisible", { raw: toolCall.function.arguments, err }); }
    history.push({ role: "assistant", content: `[Compte MoMo reçu : ${numero}]`, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "compte_momo", numero, nomCompte, source: "groq-tool" };
  }

  if (toolCall?.function?.name === "abandon_ok") {
    let confirmed = false;
    try { confirmed = JSON.parse(toolCall.function.arguments).confirmed === true; }
    catch (err) { log.error("Argument abandon_ok illisible", { raw: toolCall.function.arguments, err }); }
    history.push({ role: "assistant", content: `[Abandon panier : ${confirmed ? "confirmé" : "annulé"}]`, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "abandon_panier", confirmed, source: "groq-tool" };
  }

  if (toolCall?.function?.name === "livraison_ok") {
    let confirmed = false;
    try { confirmed = JSON.parse(toolCall.function.arguments).confirmed === true; }
    catch (err) { log.error("Argument livraison_ok illisible", { raw: toolCall.function.arguments, err }); }
    history.push({ role: "assistant", content: `[Confirmation numéro livraison : ${confirmed ? "oui" : "non"}]`, timestamp: new Date().toISOString() });
    persistHistory(phoneNumber, history);
    return { type: "confirmation_livraison", confirmed, source: "groq-tool" };
  }

  if (toolCall?.function?.name === "escalade") {
    let categorie = "";
    try { categorie = JSON.parse(toolCall.function.arguments).categorie; }
    catch (err) { log.error("Argument de l'outil escalade illisible", { raw: toolCall.function.arguments, err }); }

    const allowed = new Set(["partenariat", "reclamation", "formation", "programme_alimentaire", "paiement", "contact_humain"]);
    if (!allowed.has(categorie)) {
      const repli = "Je vais vous demander une petite précision afin de vous orienter correctement.";
      history.push({ role: "assistant", content: repli, timestamp: new Date().toISOString() });
      persistHistory(phoneNumber, history);
      return { type: "reply", text: repli, source: "deterministic-validation" };
    }

    persistHistory(phoneNumber, history);
    return categorie === "paiement" ? { type: "paiement", source: "groq-tool" } : { type: "escalade", categorie, source: "groq-tool" };
  }

  const reply = message.content || "Je veux bien vous aider. Pouvez-vous m'en dire un peu plus ?";
  history.push({ role: "assistant", content: reply, timestamp: new Date().toISOString() });
  persistHistory(phoneNumber, history);
  return { type: "reply", text: reply, source: "groq" };
}