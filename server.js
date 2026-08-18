import "dotenv/config";
import express from "express";
import fs from "fs";
import Groq from "groq-sdk";

//------------  initialize express app ------------
const app = express();
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const HUMAN_AGENT_NUMBER = process.env.HUMAN_AGENT_NUMBER; // numéro WhatsApp du collaborateur

//------------  BLOC 1 : catalogue dynamique ------------
// Relu à chaque appel : quand ton interface visuelle modifiera catalogue.json
// (ou une base de données plus tard), le bot reflète le changement immédiatement.
function loadCatalogue() {
  try {
    const raw = fs.readFileSync("./catalogue.json", "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Erreur lecture catalogue:", err.message);
    return [];
  }
}

function formatCatalogueForPrompt(catalogue) {
  return catalogue
    .map((p) => `- ${p.nom} (${p.unite}) : ${p.prix} — ${p.stock}`)
    .join("\n");
}

function saveCatalogue(catalogue) {
  fs.writeFileSync("./catalogue.json", JSON.stringify(catalogue, null, 2));
}

//------------  BLOC 2 : procédures de l'entreprise ------------
function loadProcedures() {
  try {
    return fs.readFileSync("./procedures.txt", "utf-8");
  } catch (err) {
    return "Aucune procédure spécifique enregistrée.";
  }
}

//------------  BLOC 3 : construction du prompt système ------------
// Le persona est explicitement conçu pour ne JAMAIS révéler qu'il s'agit
// d'un agent automatique, conformément au formulaire de cadrage.
function buildSystemPrompt() {
  const catalogue = loadCatalogue();
  const procedures = loadProcedures();

  return `
Tu es l'assistant en ligne de Sekhmet Shop, une boutique de produits alimentaires orientée bien-être et santé.

RÈGLE ABSOLUE : le client ne doit jamais se douter qu'il parle à un programme automatique.
N'utilise JAMAIS les mots "bot", "intelligence artificielle", "IA", "assistant virtuel", "automatique", "modèle de langage".
Comporte-toi et exprime-toi comme le ferait une personne de l'équipe Sekhmet Shop.

TON : chaleureux, bienveillant, tu vouvoies toujours le client.

CATALOGUE ACTUEL :
${formatCatalogueForPrompt(catalogue)}

PROCÉDURES ET RÈGLES MÉTIER :
${procedures}

CONSIGNES SUPPLÉMENTAIRES :
- Si un produit n'est pas dans le catalogue, dis simplement que tu ne le proposes pas actuellement.
- Ne propose jamais toi-même une réduction, un remboursement ou un geste commercial : ce type de décision revient toujours à un collaborateur.
- Si tu ne sais pas répondre avec certitude, dis que tu transmets la question à un collaborateur plutôt que d'inventer une réponse.
`;
}

//------------  BLOC 4 : mémoire des conversations ------------
const conversations = {};

function getHistory(phoneNumber) {
  if (!conversations[phoneNumber]) {
    conversations[phoneNumber] = [
      { role: "system", content: buildSystemPrompt() },
    ];
  }
  return conversations[phoneNumber];
}

//------------  BLOC 5 : classification du message (escalade obligatoire) ------------
async function classifyMessage(userMessage) {
  const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-20b",
    max_tokens: 50,
    messages: [
      {
        role: "system",
        content: `Classifie le message suivant dans UNE SEULE de ces catégories :
- "partenariat" : demande ou proposition de partenariat, expertise, collaboration professionnelle, ou recherche de stage
- "reclamation" : plainte, produit endommagé, mal conditionné, grammage incorrect, ou insatisfaction sur un produit déjà acheté
- "normal" : toute autre demande (commande, question sur le catalogue, horaires, suivi de livraison, etc.)

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

//------------  BLOC 6 : résumé pour le collaborateur ------------
async function summarizeForHuman(phoneNumber) {
  const history = getHistory(phoneNumber);

  const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-20b",
    max_tokens: 150,
    messages: [
      {
        role: "system",
        content: "Résume cette conversation client en 2-3 phrases maximum, pour qu'un collaborateur comprenne vite la situation avant de répondre.",
      },
      ...history.filter((m) => m.role !== "system"),
    ],
  });

  return response.choices[0].message.content;
}

//------------  BLOC 7 : file d'attente d'escalade (tâche de fond) ------------
// Plusieurs clients peuvent déclencher une escalade en même temps.
// On les transmet au collaborateur UN PAR UN, dans l'ordre d'arrivée,
// mais SANS bloquer le reste de la conversation de ces clients :
// le bot continue de répondre normalement à leurs autres questions.
const escalationQueue = [];
const pendingEscalations = {}; // { "237...": timestamp } -> une demande de CE client est en cours de traitement
let isProcessingEscalation = false;

// Sécurité : si le collaborateur oublie de clôturer, l'escalade expire toute seule.
const ESCALATION_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 heures

function isPending(from) {
  const ts = pendingEscalations[from];
  if (!ts) return false;
  if (Date.now() - ts > ESCALATION_TIMEOUT_MS) {
    delete pendingEscalations[from]; // expiré : on nettoie automatiquement
    return false;
  }
  return true;
}

async function enqueueEscalation(from, userMessage) {
  pendingEscalations[from] = Date.now();
  escalationQueue.push({ from, userMessage });
  logEscalation(from, userMessage);

  await sendWhatsappMessage(
    from,
    "Je transmets votre demande à un collaborateur, il revient vers vous très rapidement."
  );

  processEscalationQueue(); // tâche de fond : ne bloque pas la réponse au client
}

async function processEscalationQueue() {
  if (isProcessingEscalation) return; // un traitement est déjà en cours, on ne double pas
  if (escalationQueue.length === 0) return;

  isProcessingEscalation = true;
  const { from, userMessage } = escalationQueue.shift(); // premier arrivé, premier traité

  try {
    const summary = await summarizeForHuman(from);
    await sendWhatsappMessage(
      HUMAN_AGENT_NUMBER,
      `⚠️ Nouvelle escalade — client ${from}\n\nRésumé : ${summary}\n\nDernier message : "${userMessage}"`
    );
  } catch (err) {
    console.error("Erreur lors de l'escalade:", err.message);
  }

  isProcessingEscalation = false;
  processEscalationQueue(); // on enchaîne sur la suivante s'il y en a
}

//------------  BLOC 7ter : journal des escalades (pour l'interface) ------------
// Historique persistant de toutes les escalades, consultable via l'API.
// Séparé de escalationQueue, qui ne sert qu'à l'ordre de traitement en tâche de fond.
const escalationsLog = []; // { id, from, userMessage, status, createdAt, closedAt }
let escalationIdCounter = 1;

function logEscalation(from, userMessage) {
  const entry = {
    id: String(escalationIdCounter++),
    from,
    userMessage,
    status: "en_attente", // ou "cloturee"
    createdAt: new Date().toISOString(),
    closedAt: null,
  };
  escalationsLog.push(entry);
  return entry;
}

function closeEscalationLog(from) {
  const entry = [...escalationsLog].reverse().find((e) => e.from === from && e.status === "en_attente");
  if (entry) {
    entry.status = "cloturee";
    entry.closedAt = new Date().toISOString();
  }
}

//------------  BLOC 7bis : commandes du collaborateur (clôture d'escalade) ------------
// Le collaborateur écrit au numéro du bot avec une commande, ex:
//   /resolu 237696784809                  -> clôture simplement l'escalade
//   /repondre 237696784809 Votre colis...  -> relaie le message au client ET clôture
async function handleHumanCommand(text) {
  const parts = text.trim().split(" ");
  const command = parts[0];

  if (command === "/resolu") {
    const clientNumber = parts[1];
    delete pendingEscalations[clientNumber];
    closeEscalationLog(clientNumber);
    await sendWhatsappMessage(HUMAN_AGENT_NUMBER, `✅ Escalade clôturée pour ${clientNumber}.`);
    return;
  }

  if (command === "/repondre") {
    const clientNumber = parts[1];
    const messageToClient = parts.slice(2).join(" ");
    if (!messageToClient) {
      await sendWhatsappMessage(HUMAN_AGENT_NUMBER, "Format: /repondre <numero> <message>");
      return;
    }
    await sendWhatsappMessage(clientNumber, messageToClient);
    delete pendingEscalations[clientNumber];
    closeEscalationLog(clientNumber);
    await sendWhatsappMessage(HUMAN_AGENT_NUMBER, `✅ Message envoyé à ${clientNumber}, escalade clôturée.`);
    return;
  }

  await sendWhatsappMessage(
    HUMAN_AGENT_NUMBER,
    "Commandes disponibles:\n/resolu <numero>\n/repondre <numero> <message>"
  );
}

//------------  BLOC 8 : appel à Groq pour une réponse normale ------------
async function askGroq(phoneNumber, userMessage) {
  const history = getHistory(phoneNumber);
  history.push({ role: "user", content: userMessage });

  const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-120b",
    max_tokens: 500,
    messages: history,
  });

  const reply = response.choices[0].message.content;
  history.push({ role: "assistant", content: reply });

  return reply;
}

//------------  BLOC 9 : envoi de messages WhatsApp ------------
async function sendWhatsappMessage(to, text) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      text: { body: text },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("Erreur envoi WhatsApp:", JSON.stringify(data, null, 2));
  }
}

//------------  BLOC 10 : API pour l'interface d'administration ------------
// Protégée par un token simple : le header "Authorization: Bearer <ADMIN_TOKEN>"
// doit correspondre à la variable d'environnement ADMIN_TOKEN.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization; // ex: "Bearer abc123"
  if (auth !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  next();
}

// --- Catalogue : lecture, création, modification, suppression ---

app.get("/api/produits", requireAdmin, (req, res) => {
  res.json(loadCatalogue());
});

app.post("/api/produits", requireAdmin, (req, res) => {
  const { nom, unite, prix, stock } = req.body;
  if (!nom || !prix) {
    return res.status(400).json({ error: "nom et prix sont obligatoires" });
  }

  const catalogue = loadCatalogue();
  const newProduct = {
    id: String(Date.now()), // simple et suffisant pour ce volume
    nom,
    unite: unite || "",
    prix,
    stock: stock || "disponible",
  };
  catalogue.push(newProduct);
  saveCatalogue(catalogue);

  res.status(201).json(newProduct);
});

app.put("/api/produits/:id", requireAdmin, (req, res) => {
  const catalogue = loadCatalogue();
  const index = catalogue.findIndex((p) => p.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: "Produit introuvable" });
  }

  catalogue[index] = { ...catalogue[index], ...req.body, id: catalogue[index].id };
  saveCatalogue(catalogue);

  res.json(catalogue[index]);
});

app.delete("/api/produits/:id", requireAdmin, (req, res) => {
  const catalogue = loadCatalogue();
  const filtered = catalogue.filter((p) => p.id !== req.params.id);
  if (filtered.length === catalogue.length) {
    return res.status(404).json({ error: "Produit introuvable" });
  }

  saveCatalogue(filtered);
  res.status(204).send();
});

// --- Procédures : lecture et modification (texte libre) ---

app.get("/api/procedures", requireAdmin, (req, res) => {
  res.json({ content: loadProcedures() });
});

app.put("/api/procedures", requireAdmin, (req, res) => {
  const { content } = req.body;
  if (typeof content !== "string") {
    return res.status(400).json({ error: "content (texte) est obligatoire" });
  }
  fs.writeFileSync("./procedures.txt", content);
  res.json({ content });
});

// --- Escalades : consultation et clôture depuis l'interface ---

app.get("/api/escalades", requireAdmin, (req, res) => {
  res.json(escalationsLog.slice().reverse()); // les plus récentes en premier
});

app.patch("/api/escalades/:id/cloturer", requireAdmin, (req, res) => {
  const entry = escalationsLog.find((e) => e.id === req.params.id);
  if (!entry) {
    return res.status(404).json({ error: "Escalade introuvable" });
  }
  entry.status = "cloturee";
  entry.closedAt = new Date().toISOString();
  delete pendingEscalations[entry.from];
  res.json(entry);
});

//------------  BLOC 11 : webhook de vérification ------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

//------------  BLOC 11 : webhook de réception des messages ------------
app.post("/webhook", async (req, res) => {
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
    if (from === HUMAN_AGENT_NUMBER) {
      await handleHumanCommand(userMessage);
      return;
    }

    // 1. Ce nouveau message déclenche-t-il lui-même une escalade obligatoire ?
    const categorie = await classifyMessage(userMessage);
    if (categorie === "partenariat" || categorie === "reclamation") {
      await enqueueEscalation(from, userMessage);
      return;
    }

    // 2. Sinon, réponse normale de l'IA — que le client ait ou non
    //    une escalade en attente par ailleurs (non bloquant).
    let reply = await askGroq(from, userMessage);

    if (isPending(from)) {
      reply += "\n\n(Par ailleurs, votre précédente demande est toujours en cours de traitement par notre collaborateur, il ne va plus tarder.)";
    }

    await sendWhatsappMessage(from, reply);
  } catch (err) {
    console.error("Erreur:", err.message);
    await sendWhatsappMessage(from, "Désolé, une erreur est survenue. Veuillez réessayer plus tard.");
  }
});

//------------  BLOC 12 : démarrage du serveur ------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
