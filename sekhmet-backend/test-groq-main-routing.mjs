import fs from "node:fs";

const chat = fs.readFileSync(new URL("./services/chat.service.js", import.meta.url), "utf8");
const webhook = fs.readFileSync(new URL("./routes/webhook.routes.js", import.meta.url), "utf8");

const required = [
  ["main Groq model", 'model: "openai/gpt-oss-120b"'],
  ["payment tool", 'name: "infos_paiement"'],
  ["escalation tool", 'name: "escalade"'],
  ["cart tool", 'name: "ajout_panier"'],
  ["usage persistence", 'await recordUsage({ type: "reponse"'],
];

for (const [label, needle] of required) {
  if (!chat.includes(needle)) throw new Error(`Missing ${label}: ${needle}`);
}

const forbiddenLocalRouting = [
  "if (analysis.paymentDone)",
  "if (analysis.paymentRequest)",
  "analysis.requiresGroq",
  "getRecommendationCandidates(\n",
  "buildLocalNaturalReply(analysis",
];
for (const needle of forbiddenLocalRouting) {
  if (chat.includes(needle)) throw new Error(`Local conversational routing still present: ${needle}`);
}

if (!webhook.includes("function extractClientEntities(message)")) throw new Error("Deterministic client entity extraction helper is missing.");
if (!webhook.includes("handleClientMessage(from, userMessage")) throw new Error("Webhook must delegate natural messages to the main chat engine.");
if (!chat.includes("isDemandeCatalogueComplet")) throw new Error("Deterministic catalogue shortcut should remain available.");

console.log("OK - Groq is the main conversational router; deterministic controls remain around it.");
