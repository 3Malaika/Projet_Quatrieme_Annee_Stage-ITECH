import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeLocalMessage } from "./services/localNlp.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultCsv = path.join(__dirname, "tests", "questions.csv");
const csvPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultCsv;

function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      fields.push(field.trim());
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field.trim());
  return fields;
}

function parseCsv(content) {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];

  const headers = parseCsvLine(lines[0]).map((x) => x.toLowerCase());
  const intentIndex = headers.indexOf("intent");
  const questionIndex = headers.indexOf("question");
  if (intentIndex < 0 || questionIndex < 0) {
    throw new Error('Le CSV doit contenir les colonnes "intent" et "question".');
  }

  return lines.slice(1).map((line, index) => {
    const fields = parseCsvLine(line);
    return {
      line: index + 2,
      expected: fields[intentIndex]?.trim(),
      message: fields[questionIndex]?.trim(),
    };
  }).filter((row) => row.expected && row.message);
}

function pct(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

const content = await fs.readFile(csvPath, "utf8");
const cases = parseCsv(content);
if (!cases.length) throw new Error("Aucune question exploitable dans le CSV.");

console.log(`\n=== Test NLP depuis CSV ===`);
console.log(`Fichier : ${csvPath}`);
console.log(`Questions : ${cases.length}\n`);

let recognized = 0;
let localCount = 0;
let groqCount = 0;
const confusion = new Map();

for (const row of cases) {
  const analysis = await analyzeLocalMessage(row.message);
  const correct = analysis.intent === row.expected;
  if (correct) recognized += 1;
  if (analysis.requiresGroq) groqCount += 1;
  else localCount += 1;

  const key = `${row.expected} -> ${analysis.intent}`;
  confusion.set(key, (confusion.get(key) || 0) + 1);

  console.log(
    `${correct ? "OK " : "ERR"} ${String(row.expected).padEnd(22)} -> ${String(analysis.intent).padEnd(22)} ` +
    `confidence=${pct(analysis.confidence).padEnd(7)} margin=${pct(analysis.margin).padEnd(7)} ` +
    `decision=${analysis.requiresGroq ? "GROQ" : "LOCAL"} | ${row.message}`
  );
}

const accuracy = recognized / cases.length;
console.log(`\n=== Résumé ===`);
console.log(`Reconnaissance intention : ${recognized}/${cases.length} (${pct(accuracy)})`);
console.log(`Décisions LOCAL          : ${localCount}`);
console.log(`Transferts GROQ          : ${groqCount}`);

const errors = [...confusion.entries()]
  .filter(([key]) => !key.split(" -> ")[0].includes(key.split(" -> ")[1]))
  .sort((a, b) => b[1] - a[1]);

if (errors.length) {
  console.log("\nConfusions :");
  for (const [key, count] of errors) console.log(`  ${count}x ${key}`);
}

console.log();
if (accuracy < 0.8) process.exitCode = 1;
