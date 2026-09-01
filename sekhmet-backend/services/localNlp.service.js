import { config } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("localNlp");

const textStores = config.supabaseUrl
  ? await import("../data/configTextes.store.supabase.js")
  : {
      ...(await import("../data/procedures.store.js")),
      ...(await import("../data/bienfaits.store.js")),
      ...(await import("../data/openingMessage.store.js")),
    };

const { loadProcedures, loadBienfaits, loadOpeningMessage } = textStores;

// Analyse locale sans dépendance native ni LLM génératif.
// Le classifieur sémantique léger repose sur TF-IDF + similarité cosinus.
// Il est volontairement déterministe et peut être enrichi par les textes
// administrables (procédures, bienfaits et message d'accueil).
const LOCAL_NLP_ENGINE = "classic-nlp+rules+tfidf";

// Mots-outils français : ils sont ignorés pour la similarité et la détection
// de termes afin de mieux distinguer le sens utile du message.
const FRENCH_STOPWORDS = new Set(`a ai ait as au aux avec ce ceci cela comme dans de des du elle en es est et eu eux il ils j je la le les lui ma mais me mes moi mon ne nos notre nous on ou par pas pour que quel quelle quelles quels qui sa se sera son sont sur ta te tes toi ton tu un une vos votre vous y d un une`.split(/\s+/));

const INTENT_PRIORITY = [
  "farewell", "greeting", "thanks", "paymentDone", "paymentRequest",
  "tracking", "order", "catalogue", "productInfo", "price", "stock", "human",
];

const DEFAULT_INTENTS = {
  greeting: ["bonjour", "bonsoir", "salut", "coucou", "hello", "hi", "hey", "bjr", "slt", "je voulais vous dire bonjour"],
  farewell: ["au revoir", "aurevoir", "a bientot", "a plus", "a pluss", "bye", "ciao", "bonne journee", "bonne soiree", "je vous laisse", "je dois y aller"],
  thanks: ["merci", "merci beaucoup", "je vous remercie", "thanks", "thank you", "c'est gentil", "vous êtes gentils"],
  catalogue: ["catalogue", "tous vos produits", "toute la liste", "liste complete", "liste des produits", "tous les produits", "voir tous vos produits", "envoyer le catalogue", "menu complet"],
  paymentRequest: ["comment payer", "comment je paie", "ou payer", "numero de paiement", "numero pour payer", "compte pour payer", "envoyer l argent", "faire le paiement", "payer par mobile money", "orange money", "mtn momo"],
  paymentDone: ["j ai paye", "paiement effectue", "j ai envoyé", "argent envoyé", "virement effectué", "transaction faite", "j ai fait le paiement"],
  tracking: ["ou en est ma commande", "suivre ma commande", "suivi de ma commande", "ma commande est ou", "ma commande en est ou", "livraison en est ou", "quand vais je recevoir", "delai de livraison"],
  price: ["combien", "prix", "tarif", "cout", "ca coute", "a combien", "quel est le prix"],
  stock: ["disponible", "en stock", "rupture", "reste t il", "vous avez encore", "est ce que vous en avez encore"],
  order: ["je commande", "je voudrais commander", "je veux commander", "passer commande", "commander", "acheter", "je prends", "je prend", "je veux prendre"],
  productInfo: ["photo", "fiche", "details", "plus d informations", "parlez moi de", "description de", "montrez moi ce produit"],
  human: ["parler a quelqu un", "parler à quelqu'un", "parler à un conseiller", "humain", "conseiller", "une personne"],
};

const INTENT_EXAMPLES = {
  greeting: [
    "Bonjour",
    "Bonsoir",
    "Salut, comment allez-vous ?",
    "Coucou 😊",
    "Hello",
    "Je voulais juste vous dire bonjour",
  ],
  farewell: [
    "Au revoir",
    "À bientôt",
    "Je vous laisse",
    "Bonne journée",
    "Bonne soirée et merci",
    "Je dois y aller",
  ],
  thanks: [
    "Merci beaucoup",
    "Je vous remercie",
    "C'est gentil, merci",
    "Merci pour votre aide",
  ],
  catalogue: [
    "Je voudrais voir tous vos produits",
    "Pouvez-vous m'envoyer le catalogue ?",
    "Quels sont tous les produits que vous proposez ?",
  ],
  paymentRequest: [
    "Comment puis-je payer ?",
    "Sur quel numéro dois-je envoyer l'argent ?",
    "Je veux payer par Mobile Money",
    "Comment faire le paiement ?",
  ],
  paymentDone: [
    "J'ai déjà payé",
    "Le paiement vient d'être effectué",
    "Je viens d'envoyer l'argent",
    "La transaction est faite",
  ],
  tracking: [
    "Où en est ma commande ?",
    "Je voudrais suivre ma commande",
    "Quand vais-je recevoir ma commande ?",
    "Pouvez-vous me dire où en est la livraison ?",
  ],
  price: [
    "Quel est le prix de ce produit ?",
    "Combien ça coûte ?",
    "À combien est-il ?",
    "Quel est le tarif ?",
  ],
  stock: [
    "Est-ce que ce produit est encore disponible ?",
    "Vous en avez encore ?",
    "Est-ce qu'il reste du stock ?",
  ],
  order: [
    "Je voudrais commander",
    "Je veux acheter ce produit",
    "Je prends celui-ci",
    "Comment passer commande ?",
  ],
  productInfo: [
    "Je voudrais voir la photo et les détails de ce produit",
    "Pouvez-vous me montrer ce produit ?",
    "Parlez-moi davantage de ce produit",
  ],
  human: [
    "Je voudrais parler à quelqu'un",
    "Je préfère parler à un conseiller",
    "Est-ce que je peux avoir une personne ?",
  ],
};

function normalize(text = "") {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function phrasePresent(text, phrase) {
  const p = normalize(phrase);
  if (!p) return false;
  return ` ${text} `.includes(` ${p} `) || text.includes(p);
}

function extractSection(text, startPattern, endPatterns = []) {
  const raw = String(text || "");
  const start = raw.search(startPattern);
  if (start < 0) return "";
  let end = raw.length;
  for (const pattern of endPatterns) {
    const re = new RegExp(pattern, "i");
    const match = re.exec(raw.slice(start + 1));
    if (match) end = Math.min(end, start + 1 + match.index);
  }
  return raw.slice(start, end);
}

function extractProcedureConfig(procedures) {
  const raw = String(procedures || "");
  const normalized = normalize(raw);
  const cfg = {
    companyName: (raw.match(/nom de l'entreprise est\s*["“”]?([^"“”\n]+)/i)?.[1] || "Sekhmet Shop").trim(),
    deliveryHours: raw.match(/horaires humains\s*:\s*([^\n]+)/i)?.[1]?.trim() || "8h30 à 17h30",
    deliveryZone: raw.match(/livraison à\s*([^,\n]+).*expédition possible\s*([^\n]+)/i)?.[0]?.trim() || "Livraison à Yaoundé et expédition possible ailleurs.",
    paymentMethods: raw.match(/moyen de paiement accepté\s*:\s*([^\n]+)/i)?.[1]?.trim() || "Mobile Money (Orange Money / MTN MoMo)",
    deliveryDelay: raw.match(/délai de livraison moyen\s*:\s*([^\n]+)/i)?.[1]?.trim() || "1 à 2 heures",
    escalations: {},
  };

  const section = extractSection(raw, /CAS D'ESCALADE OBLIGATOIRE/i, [/COMMENT FORMULER UNE ESCALADE/i, /DISPONIBILITÉ DES COLLABORATEURS/i]);
  const lines = section.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const categories = ["partenariat", "reclamation", "formation", "programme_alimentaire", "paiement"];
  for (const category of categories) {
    const aliases = [category.replace("_", " ")];
    if (category === "reclamation") aliases.push("réclamation", "plainte", "produit endommagé", "mal conditionné", "grammage");
    if (category === "partenariat") aliases.push("partenariat", "expertise", "collaboration", "stage");
    if (category === "formation") aliases.push("formation", "formations");
    if (category === "programme_alimentaire") aliases.push("programme alimentaire", "suivi alimentaire", "coaching nutritionnel");
    if (category === "paiement") aliases.push("paiement", "mobile money", "orange money", "mtn momo");
    const relevant = lines.filter((line) => aliases.some((a) => normalize(line).includes(normalize(a))));
    if (relevant.length) cfg.escalations[category] = [...new Set(aliases)];
  }
  return { ...cfg, normalized };
}

function extractBenefitMap(text) {
  const raw = String(text || "");
  const result = [];
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let current = null;
  for (const line of lines) {
    if (/^[A-ZÉÈÊËÀÂÎÏÔÛÙÜÇ /_-]{4,}$/.test(line) && !line.startsWith("GUIDE DES")) {
      current = normalize(line);
      continue;
    }
    if (current && /^[-•]/.test(line)) {
      const body = line.replace(/^[-•]\s*/, "");
      const products = body.split(":").pop() || body;
      result.push({ need: current, text: body, products: products.split(/,|\bet\b/).map((p) => p.trim()).filter(Boolean) });
    }
  }
  return result;
}

function findName(text) {
  const raw = String(text || "").trim();
  const patterns = [
    /(?:moi c['’]est|je m['’]appelle|mon prénom est|mon prenom est|appelez[- ]moi|vous pouvez m['’]appeler)\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,40}?)(?=\s+(?:et|je|j['’]ai|je cherche|je veux|j['’]aimerais|j['’]voudrais|pour)\b|[.!?,;:]|$)/i,
    /(?:nom\s*[:=]|prénom\s*[:=]|prenom\s*[:=])\s*([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,40}?)(?=\s+(?:et|je|j['’]ai|je cherche|je veux|pour)\b|[.!?,;:]|$)/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m?.[1]) return m[1].trim().replace(/[.!?,;:]+$/, "");
  }
  return null;
}

function findNeed(text) {
  const raw = String(text || "").trim();
  const patterns = [
    /(?:mon besoin est|besoin\s*[:=]|je cherche|j['’]aimerais|je voudrais|je veux|j['’]ai besoin de|je souhaite)\s+(.{3,160})$/i,
    /(?:pour|concernant)\s+(.{3,120})$/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m?.[1]) return m[1].trim().replace(/[.!?]+$/, "");
  }
  const lower = normalize(raw);
  for (const token of ["formation", "suivi alimentaire", "produits finis", "produits", "catalogue", "commande"]) {
    if (lower.includes(normalize(token))) return token;
  }
  return null;
}

function scoreIntent(text, terms) {
  // Score de règle normalisé sur 0..1. Une correspondance exacte d'une
  // expression connue doit être suffisamment forte pour reconnaître les
  // intentions simples sans dépendre du TF-IDF.
  let best = 0;
  for (const term of terms) {
    if (phrasePresent(text, term)) {
      const weight = term.includes(" ") ? 1 : 0.9;
      best = Math.max(best, weight);
    }
  }
  return best;
}

function buildSemanticExamples(config) {
  const examples = new Map(Object.entries(INTENT_EXAMPLES).map(([intent, values]) => [intent, [...values]]));
  for (const [intent, values] of Object.entries(DEFAULT_INTENTS)) {
    if (!examples.has(intent)) examples.set(intent, []);
    examples.get(intent).push(...values.slice(0, 8));
  }
  for (const [category, aliases] of Object.entries(config.procedureConfig.escalations || {})) {
    const intent = category === "paiement" ? "paymentDone" : category;
    if (!examples.has(intent)) examples.set(intent, []);
    examples.get(intent).push(...aliases.map((alias) => `Je demande de l'aide pour ${alias}`));
  }
  // Les procédures sont la source de vérité : on ajoute seulement des
  // formulations sémantiquement proches des éléments explicitement présents,
  // sans inventer de nouvelles catégories d'escalade.
  const payment = config.procedureConfig.paymentMethods;
  if (payment) examples.get("paymentRequest")?.push(`Je veux payer avec ${payment}`);
  return [...examples.entries()].map(([intent, texts]) => ({
    intent,
    texts: [...new Set(texts.map(normalize).filter(Boolean))],
  }));
}

// NLP classique léger, sans modèle ni dépendance native : tokenisation,
// suppression des mots-outils, normalisation morphologique prudente et
// génération de bigrammes. Cela ne remplace pas un parseur linguistique
// complet, mais améliore nettement la robustesse du classement lexical.
function stemFrench(token) {
  let t = token;
  if (t.length < 5) return t;
  const suffixes = [
    "issements", "issement", "ements", "ement", "ations", "ation",
    "ements", "ment", "ances", "ence", "ences", "iques", "ique",
    "ables", "able", "euses", "euse", "eurs", "eur", "es", "s", "e"
  ];
  for (const suffix of suffixes) {
    if (t.endsWith(suffix) && t.length - suffix.length >= 3) {
      t = t.slice(0, -suffix.length);
      break;
    }
  }
  return t;
}

function classicTokens(text) {
  return normalize(text)
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((token) => token.length >= 2)
    .filter((token) => !FRENCH_STOPWORDS.has(token));
}

function classicFeatures(text) {
  const tokens = classicTokens(text);
  const stems = tokens.map(stemFrench);
  const bigrams = [];
  for (let i = 0; i < stems.length - 1; i += 1) bigrams.push(`${stems[i]}_${stems[i + 1]}`);
  return [...new Set([...stems, ...bigrams])];
}

function editDistance(a, b) {
  const aa = String(a);
  const bb = String(b);
  if (!aa) return bb.length;
  if (!bb) return aa.length;
  const prev = Array.from({ length: bb.length + 1 }, (_, i) => i);
  for (let i = 1; i <= aa.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= bb.length; j += 1) {
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (aa[i - 1] === bb[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j < cur.length; j += 1) prev[j] = cur[j];
  }
  return prev[bb.length];
}

function lexicalApproximation(text, terms) {
  const tokens = classicTokens(text);
  let best = 0;
  for (const term of terms) {
    const target = classicTokens(term);
    if (!target.length) continue;
    const matched = target.filter((wanted) =>
      tokens.some((got) => got === wanted || stemFrench(got) === stemFrench(wanted) ||
        (wanted.length >= 5 && editDistance(got, wanted) <= 1))
    ).length;
    best = Math.max(best, matched / target.length);
  }
  return best;
}

function extractQuantity(text) {
  const raw = String(text || "");
  const digit = raw.match(/\b(\d{1,3})\s*(?:x|fois|unites?|unités?|pieces?|pièces?)?\b/i);
  if (digit) return Number(digit[1]);
  const words = { un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };
  const match = normalize(raw).match(/\b(un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b/);
  return match ? words[match[1]] : null;
}

function extractBudget(text) {
  const raw = String(text || "");
  const match = raw.match(/(?:moins de|maximum|max|budget(?: de)?|autour de|environ|a peu pres|à peu près|pour)\s*[:=]?\s*(\d[\d .]*)\s*(?:f|fcfa|francs?)?\b/i);
  if (!match) return null;
  const value = Number(match[1].replace(/[ .]/g, ""));
  return Number.isFinite(value) ? value : null;
}

function detectSpecialEntities(text) {
  return {
    quantity: extractQuantity(text),
    budget: extractBudget(text),
    phoneMentioned: /(?:\+?237\s*)?(?:6\d{8}|2\d{8})\b/.test(String(text || "").replace(/[ -]/g, "")),
    moneyMentioned: /fcfa|francs?|orange money|mtn momo|mobile money/i.test(String(text || "")),
  };
}

function tokenize(text) {
  return classicFeatures(text);
}

function makeTfidfVectors(texts) {
  const tokenized = texts.map(tokenize);
  const documentFrequency = new Map();
  for (const tokens of tokenized) {
    for (const token of new Set(tokens)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  const totalDocs = texts.length || 1;
  const vocabulary = [...documentFrequency.keys()];
  const index = new Map(vocabulary.map((token, i) => [token, i]));
  const vectors = tokenized.map((tokens) => {
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    const vector = new Array(vocabulary.length).fill(0);
    for (const [token, count] of counts) {
      const i = index.get(token);
      if (i === undefined) continue;
      const tf = 1 + Math.log(count);
      const idf = Math.log((1 + totalDocs) / (1 + (documentFrequency.get(token) || 0))) + 1;
      vector[i] = tf * idf;
    }
    return vector;
  });
  return { vocabulary, index, vectors };
}

function vectorize(text, model) {
  const tokens = tokenize(text);
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  const vector = new Array(model.vocabulary.length).fill(0);
  for (const [token, count] of counts) {
    const i = model.index.get(token);
    if (i === undefined) continue;
    vector[i] = 1 + Math.log(count);
  }
  return vector;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

let semanticCache = { key: "", examples: [], model: null };

async function semanticIntentScores(message, config) {
  const examples = buildSemanticExamples(config);
  const key = examples.map((x) => `${x.intent}:${x.texts.join("|")}`).join("\n");
  if (semanticCache.key !== key) {
    const flat = examples.flatMap((x) => x.texts.map((text) => ({ intent: x.intent, text })));
    const model = makeTfidfVectors(flat.map((x) => x.text));
    semanticCache = { key, examples: flat, model };
  }
  if (!semanticCache.model) return {};
  const query = vectorize(message, semanticCache.model);
  const scores = {};
  for (let i = 0; i < semanticCache.examples.length; i += 1) {
    const { intent } = semanticCache.examples[i];
    const similarity = cosineSimilarity(query, semanticCache.model.vectors[i]);
    scores[intent] = Math.max(scores[intent] || 0, similarity);
  }
  return scores;
}

export async function getLocalChatConfig() {
  const [procedures, bienfaits, openingMessage] = await Promise.all([
    loadProcedures(),
    loadBienfaits(),
    loadOpeningMessage(),
  ]);
  return {
    procedures,
    bienfaits,
    openingMessage,
    procedureConfig: extractProcedureConfig(procedures),
    benefitMap: extractBenefitMap(bienfaits),
  };
}

export async function analyzeLocalMessage(message, options = {}) {
  const config = options.config || await getLocalChatConfig();
  const text = normalize(message);
  const scores = {};
  for (const [intent, terms] of Object.entries(DEFAULT_INTENTS)) scores[intent] = scoreIntent(text, terms);

  for (const [category, terms] of Object.entries(config.procedureConfig.escalations || {})) {
    scores[`escalation:${category}`] = scoreIntent(text, terms);
  }

  let semanticScores = {};
  try {
    semanticScores = await semanticIntentScores(message, config);
  } catch (error) {
    log.warn("Analyse sémantique locale échouée — règles conservées", { error: error?.message || String(error) });
  }

  // Les règles explicites restent prioritaires. Le classifieur local couvre
  // les formulations proches sans dépendre d’un modèle natif vulnérable.
  const combined = {};
  const allIntents = new Set([...Object.keys(scores), ...Object.keys(semanticScores)]);
  for (const intent of allIntents) {
    const rule = scores[intent] || 0;
    const semantic = semanticScores[intent] || 0;
    // Les règles explicites sont la preuve la plus forte pour les intentions
    // courtes et sensibles (salutation, paiement, commande...). Le TF-IDF et
    // le NLP lexical servent à généraliser aux formulations inconnues.
    combined[intent] = Math.min(0.99, rule * 0.62 + Math.max(0, semantic) * 0.23);
  }

  // Couche NLP classique : variantes morphologiques et petites fautes de
  // frappe. Elle complète les règles et le TF-IDF, sans décider seule.
  for (const [intent, terms] of Object.entries(DEFAULT_INTENTS)) {
    const lexical = lexicalApproximation(message, terms);
    combined[intent] = Math.min(0.99, (combined[intent] || 0) + lexical * 0.15);
  }

  const best = Object.entries(combined).sort((a, b) => b[1] - a[1]);
  const top = best[0]?.[0] || null;
  const topScore = best[0]?.[1] || 0;
  const secondScore = best[1]?.[1] || 0;

  let intent = "normal";
  if (top?.startsWith("escalation:") && topScore >= 0.68) intent = top.slice("escalation:".length);
  else if (topScore >= 0.55) intent = top;

  const name = findName(message);
  const need = findNeed(message);
  const entities = detectSpecialEntities(message);
  const lower = normalize(message);
  const margin = Math.max(0, topScore - secondScore);
  // Une intention très nette doit pouvoir rester locale. En revanche, deux
  // intentions proches (ex. "bonne soirée et merci") doivent faire baisser
  // fortement la confiance afin de laisser Groq utiliser le contexte.
  const separation = Math.min(1, margin / 0.20);
  const confidence = Math.min(0.99, topScore * (0.70 + 0.30 * separation));
  const explicitPaymentDone = DEFAULT_INTENTS.paymentDone.some((x) => phrasePresent(lower, x));
  const explicitPaymentRequest = DEFAULT_INTENTS.paymentRequest.some((x) => phrasePresent(lower, x));

  return {
    intent,
    confidence,
    margin,
    entities,
    requiresGroq: !(intent !== "normal" && confidence >= 0.76 && [
      "greeting", "farewell", "thanks", "catalogue", "paymentRequest",
      "paymentDone", "human", "partenariat", "reclamation", "formation",
      "programme_alimentaire"
    ].includes(intent)),
    name,
    need,
    paymentDone: explicitPaymentDone || (intent === "paymentDone" && topScore >= 0.82),
    paymentRequest: explicitPaymentRequest || (intent === "paymentRequest" && topScore >= 0.82),
    normalized: text,
    scores: combined,
    ruleScores: scores,
    semanticScores,
    classicFeatures: classicFeatures(message),
    config,
  };
}

export function buildLocalNaturalReply(analysis, config, client = {}) {
  const name = client?.nom || analysis.name;
  switch (analysis.intent) {
    case "greeting":
      // Le message d'accueil administrable reste la source de vérité pour le
      // premier contact. Ce texte n'est utilisé que pour une salutation après
      // l'accueil initial, et reste volontairement court.
      return `Bonjour${name ? ` ${name}` : ""} 😊 Comment puis-je vous aider aujourd'hui ?`;
    case "farewell":
      return "Avec plaisir 😊 Je vous souhaite une excellente journée et reste à votre disposition si vous avez besoin de nous.";
    case "thanks":
      return "Avec plaisir 😊 N'hésitez pas si vous avez besoin de quoi que ce soit.";
    default:
      return null;
  }
}

export function getRecommendationCandidates(catalogue, config, needText) {
  const n = normalize(needText || "");
  if (!n) return [];
  const scored = catalogue.map((product) => {
    const haystack = normalize(`${product.nom} ${product.description || ""} ${product.categorie || ""}`);
    let score = 0;
    for (const entry of config.benefitMap || []) {
      const needWords = entry.need.split(/\s+/).filter((w) => w.length >= 4);
      const needScore = needWords.reduce((s, w) => (n.includes(w) ? s + 1 : s), 0);
      if (needScore > 0 && entry.products.some((p) => haystack.includes(normalize(p).slice(0, 8)))) score += needScore + 1;
    }
    for (const word of n.split(/\s+/).filter((w) => w.length >= 5)) if (haystack.includes(word)) score += 0.25;
    return { product, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((x) => x.product);
}
