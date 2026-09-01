import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { analyzeLocalMessage } from "./services/localNlp.service.js";

const rl = readline.createInterface({ input, output });

console.log("\n=== Test interactif du moteur NLP local ===");
console.log("Écris une phrase puis Entrée. Tape 'exit' ou 'quit' pour quitter.\n");

function pct(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function printScores(title, scores) {
  const entries = Object.entries(scores || {})
    .filter(([, score]) => Number(score) > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (!entries.length) {
    console.log(`${title}: aucun résultat`);
    return;
  }
  console.log(title + ":");
  for (const [intent, score] of entries) console.log(`  - ${intent.padEnd(24)} ${pct(score)}`);
}

while (true) {
  const message = (await rl.question("> ")).trim();
  if (!message) continue;
  if (["exit", "quit", "q"].includes(message.toLowerCase())) break;

  try {
    const a = await analyzeLocalMessage(message);

    console.log("\nRésultat");
    console.log(`  Intention        : ${a.intent}`);
    console.log(`  Confiance        : ${pct(a.confidence)}`);
    console.log(`  Écart avec #2    : ${pct(a.margin)}`);
    console.log(`  Décision          : ${a.requiresGroq ? "GROQ (message ambigu ou complexe)" : "LOCAL"}`);

    console.log("\nInformations extraites");
    console.log(`  Nom              : ${a.name || "—"}`);
    console.log(`  Besoin            : ${a.need || "—"}`);
    console.log(`  Quantité          : ${a.entities?.quantity ?? "—"}`);
    console.log(`  Budget            : ${a.entities?.budget ?? "—"}`);
    console.log(`  Paiement mentionné: ${a.entities?.moneyMentioned ? "oui" : "non"}`);
    console.log(`  Téléphone mentionné: ${a.entities?.phoneMentioned ? "oui" : "non"}`);

    printScores("\nIntentions combinées", a.scores);
    printScores("Scores des règles", a.ruleScores);
    printScores("Scores TF-IDF", a.semanticScores);

    console.log(`\nCaractéristiques NLP : ${a.classicFeatures?.join(" | ") || "—"}`);
    console.log();
  } catch (error) {
    console.error(`Erreur d'analyse : ${error?.message || error}`);
  }
}

rl.close();
console.log("Test interactif terminé.");
