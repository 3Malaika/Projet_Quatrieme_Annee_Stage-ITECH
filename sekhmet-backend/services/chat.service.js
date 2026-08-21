import Groq from "groq-sdk";
import { config } from "../config/env.js";
import { buildSystemPrompt } from "./systemPrompt.service.js";
import { loadCatalogue } from "../data/catalogue.store.js";
import {
  formatCatalogueComplet,
  isDemandeCatalogueComplet,
} from "./catalogueFormatter.service.js";

const groq = new Groq({ apiKey: config.groqApiKey });

// Sélection dynamique des stores selon l'environnement
const clientsStore = config.supabaseUrl
  ? await import("../data/clients.store.supabase.js")
  : await import("../data/clients.store.js");

const convStore = config.supabaseUrl
  ? await import("../data/conversations.store.supabase.js")
  : await import("../data/conversations.store.js");

// Cache en mémoire des conversations (peuplé au démarrage)
const conversations = await convStore.loadConversations();

export function getHistory(phoneNumber) {
  if (!conversations[phoneNumber]) {
    conversations[phoneNumber] = [
      { role: "system", content: buildSystemPrompt() },
    ];
    // Persistance asynchrone — on ne bloque pas l'exécution
    convStore.saveConversations(conversations).catch((e) =>
      console.error("Erreur sauvegarde conversation:", e.message)
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
    client_id: clients[phone]?.client_id || null,
    besoins: clients[phone]?.besoins || [],
    contacts_at: clients[phone]?.contacts_at || [],
    messageCount: history.filter((m) => m.role !== "system").length,
    lastMessage: [...history].reverse().find((m) => m.role !== "system")?.content || null,
  }));
}

export async function getConversation(phoneNumber) {
  const clients = await clientsStore.loadClients();
  return {
    phone: phoneNumber,
    nom: clients[phoneNumber]?.nom || null,
    client_id: clients[phoneNumber]?.client_id || null,
    besoins: clients[phoneNumber]?.besoins || [],
    contacts_at: clients[phoneNumber]?.contacts_at || [],
    messages: conversations[phoneNumber]?.filter((m) => m.role !== "system") || [],
  };
}

export async function extractClientInfo(userMessage) {
  const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-20b",
    max_tokens: 60,
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

  try {
    const parsed = JSON.parse(response.choices[0].message.content);
    return { nom: parsed.nom || null, besoin: parsed.besoin || null };
  } catch {
    return { nom: null, besoin: null };
  }
}

export async function classifyMessage(userMessage) {
  const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-20b",
    max_tokens: 50,
    messages: [
      {
        role: "system",
        content: `Classifie le message suivant dans UNE SEULE de ces catégories :
- "partenariat" : demande ou proposition de partenariat, expertise, collaboration professionnelle, ou recherche de stage
- "reclamation" : plainte, produit endommagé, mal conditionné, grammage incorrect, ou insatisfaction sur un produit déjà acheté
- "formation" : le client veut suivre une formation, apprendre auprès du cabinet, ou demande s'il existe des formations proposées
- "programme_alimentaire" : le client veut qu'on lui établisse un vrai suivi ou programme alimentaire personnalisé (coaching nutritionnel individuel), pas juste une question générale sur un produit
- "normal" : toute autre demande (commande de produit, question sur le catalogue/prix, recommandation de produit selon un besoin, horaires, suivi de livraison, questions générales sur les bienfaits d'un produit, etc.)

Note : une simple question sur les bienfaits d'un produit ou une demande de recommandation de produit reste "normal". Ce n'est "programme_alimentaire" que si le client veut un accompagnement personnalisé et suivi dans la durée.

Réponds UNIQUEMENT avec un objet JSON de la forme {"categorie": "..."}, sans aucun autre texte.`,
      },
      { role: "user", content: userMessage },
    ],
  });

  try {
    const parsed = JSON.parse(response.choices[0].message.content);
    return parsed.categorie;
  } catch {
    return "normal";
  }
}

export async function summarizeForHuman(phoneNumber) {
  const history = getHistory(phoneNumber);

  const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-20b",
    max_tokens: 150,
    messages: [
      {
        role: "system",
        content:
          "Résume cette conversation client en 2-3 phrases maximum, pour qu'un collaborateur comprenne vite la situation avant de répondre.",
      },
      ...history.filter((m) => m.role !== "system"),
    ],
  });

  return response.choices[0].message.content;
}

export async function askGroq(phoneNumber, userMessage) {
  const history = getHistory(phoneNumber);
  history.push({ role: "user", content: userMessage });

  // Sauvegarde du message utilisateur
  if (config.supabaseUrl) {
    convStore.saveConversation(phoneNumber, history).catch((e) =>
      console.error("Erreur sauvegarde message user:", e.message)
    );
  } else {
    convStore.saveConversations(conversations).catch((e) =>
      console.error("Erreur sauvegarde conversations:", e.message)
    );
  }

  if (isDemandeCatalogueComplet(userMessage)) {
    const reply = formatCatalogueComplet(loadCatalogue());
    history.push({ role: "assistant", content: reply });
    if (config.supabaseUrl) {
      convStore.saveConversation(phoneNumber, history).catch(() => {});
    } else {
      convStore.saveConversations(conversations).catch(() => {});
    }
    return reply;
  }

  const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-120b",
    max_tokens: 1200,
    messages: history,
  });

  const reply = response.choices[0].message.content;
  history.push({ role: "assistant", content: reply });

  if (config.supabaseUrl) {
    convStore.saveConversation(phoneNumber, history).catch((e) =>
      console.error("Erreur sauvegarde réponse:", e.message)
    );
  } else {
    convStore.saveConversations(conversations).catch((e) =>
      console.error("Erreur sauvegarde conversations:", e.message)
    );
  }

  return reply;
}
