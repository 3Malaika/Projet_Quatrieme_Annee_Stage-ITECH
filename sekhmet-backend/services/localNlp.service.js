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

export const LOCAL_NLP_ENGINE = "classic-nlp+rules+tfidf";

// Seuils volontairement prudents : le moteur local n'a pas pour objectif de
// deviner. Il traite les cas simples et laisse Groq gérer l'ambiguïté.
export const LOCAL_NLP_THRESHOLDS = Object.freeze({
  minConfidence: 0.78,
  minMargin: 0.12,
  strongRule: 0.80,
  strongSemantic: 0.78,
});

const FRENCH_STOPWORDS = new Set(`a ai ait as au aux avec ce ceci cela comme dans de des du elle en es est et eu eux il ils j je la le les lui ma mais me mes moi mon ne nos notre nous on ou par pas pour que quel quelle quelles quels qui sa se sera son sont sur ta te tes toi ton tu un une vos votre vous d de l les y`.split(/\s+/));

const INTENT_PRIORITY = [
  "paymentDone", "paymentRequest", "tracking", "order", "stock", "price",
  "productInfo", "catalogue", "human", "farewell", "thanks", "greeting",
];

// Expressions et mots discriminants. Les règles sont plus fortes que TF-IDF
// lorsqu'une formulation est explicitement reconnue.
const DEFAULT_INTENTS = {
  greeting: [
    "bonjour", "bonsoir", "salut", "coucou", "hello", "hi", "hey", "bjr", "slt",
    "bien le bonjour", "je viens vous saluer", "je voulais vous saluer", "petit bonjour",
  ],
  farewell: [
    "au revoir", "aurevoir", "a bientot", "a plus", "a pluss", "bye", "ciao",
    "bonne journee", "bonne soiree", "je vous laisse", "je dois y aller", "je vais devoir vous laisser",
    "je reviendrai plus tard", "a la prochaine", "on se reparle", "merci je reviendrai plus tard", "je reviendrai",
  ],
  thanks: [
    "merci", "merci beaucoup", "je vous remercie", "thanks", "thank you", "c est gentil",
    "c est tres gentil", "merci pour votre aide", "merci pour toutes ces informations",
  ],
  catalogue: [
    "catalogue", "tous vos produits", "toute la liste", "liste complete", "liste des produits",
    "tous les produits", "voir tous vos produits", "envoyer le catalogue", "menu complet",
  ],
  paymentRequest: [
    "comment payer", "comment je paie", "comment puis je payer", "ou payer", "numero de paiement",
    "numero pour payer", "compte pour payer", "envoyer l argent", "faire le paiement", "comment faire le paiement",
    "payer par mobile money", "orange money", "mtn momo", "mtn mobile money", "moyen de paiement",
    "comment effectuer le paiement", "sur quel numero envoyer", "numero a crediter", "quels moyens de paiement acceptez vous", "quels modes de paiement acceptez vous", "je peux regler par mobile money", "ou dois je effectuer le paiement", "comment je regle ma commande", "le paiement se fait comment", "moyens de paiement", "modes de paiement", "ou effectuer le paiement",
  ],
  paymentDone: [
    "j ai paye", "j ai deja paye", "je viens de payer", "paiement effectue", "paiement effectué",
    "argent envoye", "argent envoyé", "virement effectue", "virement effectué", "transaction faite",
    "transaction effectuee", "j ai fait le paiement", "je viens de faire le paiement", "reglement effectue",
    "reglement effectué", "c est paye", "c est payé", "voila j ai paye", "paiement vient d etre effectue", "le paiement vient detre effectue", "voila j ai fait le paiement", "je vous confirme que j ai paye", "le reglement est deja fait", "c est bon j ai paye", "le paiement a ete effectue", "j ai deja effectue le reglement", "je vous ai deja envoye le paiement", "mon paiement est deja effectue", "transaction effectuee", "paiement deja effectue",
  ],
  tracking: [
    "ou en est ma commande", "suivre ma commande", "suivi de ma commande", "ma commande est ou",
    "ma commande en est ou", "livraison en est ou", "quand vais je recevoir", "quand vais je recevoir ma commande",
    "quand vais je recevoir mon colis", "quand je vais recevoir", "je vais le recevoir quand", "ca arrive quand",
    "ca arrive qd", "arrive quand", "ou est mon colis", "mon colis", "ma livraison", "suivi livraison",
    "delai de livraison", "quand arrive la livraison", "je peux savoir ou en est la livraison", "je n ai toujours pas recu ma commande", "le colis est deja parti", "je voudrais savoir quand je serai livree", "quand serai je livree", "quand vais je etre livree", "ou en est la livraison",
  ],
  price: [
    "combien", "prix", "tarif", "cout", "ca coute", "a combien", "quel est le prix", "quel tarif",
    "quel montant", "combien faut il prevoir", "combien dois je payer", "a quel prix", "vous le faites a combien",
    "ca revient a combien", "quel budget faut il compter", "montant a prevoir", "quel budget faut il prevoir", "quel budget prevoir", "budget a prevoir", "je dois prevoir quel budget",
  ],
  stock: [
    "disponible", "en stock", "rupture", "reste t il", "vous avez encore", "est ce que vous en avez encore",
    "il vous en reste", "vous en avez toujours", "toujours disponible", "encore disponible", "il en reste encore",
    "je peux encore en avoir", "je peux encore en commander", "encore en stock", "vous en avez actuellement", "est ce qu il reste des articles", "vous etes toujours approvisionnes", "il reste des articles", "toujours approvisionnes",
  ],
  order: [
    "je commande", "je voudrais commander", "je veux commander", "passer commande", "commander", "acheter",
    "je prends", "je prend", "je veux prendre", "je vais prendre", "mettez moi", "mettez-moi",
    "je souhaite passer commande", "je souhaite commander", "je souhaite acheter", "je le prends", "je le prend",
    "reserve moi", "réservez moi", "mettre de cote", "mettre de côté", "je peux passer ma commande", "on peut me reserver celui ci", "on peut me réserver celui-ci", "je confirme ma commande", "confirmer ma commande", "reserver celui ci", "réserver celui-ci",
  ],
  productInfo: [
    "photo", "fiche", "details", "plus d informations", "parlez moi de", "description de", "montrez moi ce produit",
    "montrez moi", "je veux voir le produit", "je voudrais voir le produit", "donnez moi les details",
    "plus de details", "informations sur ce produit",
  ],
  human: [
    "parler a quelqu un", "parler à quelqu'un", "parler a une personne", "parler à une personne",
    "parler a un conseiller", "parler à un conseiller", "avoir quelqu un", "avoir quelqu'un",
    "une personne de votre equipe", "une personne de votre équipe", "quelqu un au telephone", "quelqu'un au téléphone",
    "au telephone avec quelqu un", "au téléphone avec quelqu'un", "un conseiller humain", "humain",
    "service client humain", "mettre en relation", "joindre quelqu un", "joindre quelqu'un", "j aimerais echanger avec une personne", "j aimerais echanger avec quelqu un", "je prefere parler directement a quelqu un", "je peux avoir un conseiller", "je voudrais joindre votre equipe", "je veux parler a une vraie personne", "j aimerais discuter avec un conseiller", "parler directement a quelqu un", "joindre votre equipe", "un conseiller",
  ],
};

const INTENT_EXAMPLES = {
  greeting: ["Bonjour", "Bonsoir", "Salut, comment allez-vous ?", "Coucou 😊", "Hello", "Je viens vous saluer"],
  farewell: ["Au revoir", "À bientôt", "Je vous laisse", "Bonne journée", "Je dois y aller", "Je reviendrai plus tard"],
  thanks: ["Merci beaucoup", "Je vous remercie", "C'est gentil, merci", "Merci pour votre aide"],
  catalogue: ["Je voudrais voir tous vos produits", "Pouvez-vous m'envoyer le catalogue ?", "Quels sont tous les produits que vous proposez ?"],
  paymentRequest: ["Comment puis-je payer ?", "Sur quel numéro dois-je envoyer l'argent ?", "Je veux payer par Mobile Money", "Comment faire le paiement ?"],
  paymentDone: ["J'ai déjà payé", "Le paiement vient d'être effectué", "Je viens d'envoyer l'argent", "La transaction est faite"],
  tracking: ["Où en est ma commande ?", "Je voudrais suivre ma commande", "Quand vais-je recevoir ma commande ?", "Pouvez-vous me dire où en est la livraison ?"],
  price: ["Quel est le prix de ce produit ?", "Combien ça coûte ?", "À combien est-il ?", "Quel est le tarif ?"],
  stock: ["Est-ce que ce produit est encore disponible ?", "Vous en avez encore ?", "Est-ce qu'il reste du stock ?"],
  order: ["Je voudrais commander", "Je veux acheter ce produit", "Je prends celui-ci", "Comment passer commande ?"],
  productInfo: ["Je voudrais voir la photo et les détails de ce produit", "Pouvez-vous me montrer ce produit ?", "Parlez-moi davantage de ce produit"],
  human: ["Je voudrais parler à quelqu'un", "Je préfère parler à un conseiller", "Est-ce que je peux avoir une personne ?"],
};

const EXCLUSION_TERMS = {
  human: ["conseiller un produit", "conseillez moi un produit", "conseiller un article", "conseil produit", "conseille moi", "conseillez-moi"],
  paymentRequest: ["j ai deja paye", "j ai paye", "je viens de payer", "paiement effectue", "paiement effectué", "argent envoye", "argent envoyé"],
  paymentDone: ["comment payer", "comment je paie", "numero pour payer", "numero de paiement", "comment faire le paiement", "moyen de paiement"],
  tracking: ["je veux commander", "je voudrais commander", "passer commande", "je prends"],
  stock: ["combien", "prix", "tarif", "ca coute", "a combien"],
};

function normalize(text = "") {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\bsv\p{L}*/gu, "")
    .replace(/\bsvp\b/gu, "s il vous plait")
    .replace(/\bqd\b/gu, "quand")
    .replace(/\bbjr\b/gu, "bonjour")
    .replace(/\bslt\b/gu, "salut")
    .replace(/\bc\b/gu, "c")
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
    /(?:moi c['’]est|je m['’]appelle|je m['’]appele|je m['’]appel|mon prénom est|mon prenom est|mon nom est|appelez[- ]moi|vous pouvez m['’]appeler)\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,40}?)(?=\s+(?:et|je|j['’]ai|je cherche|je veux|j['’]aimerais|j['’]voudrais|pour)\b|[.!?,;:]|$)/i,
    /(?:nom\s*[:=]|prénom\s*[:=]|prenom\s*[:=])\s*([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,40}?)(?=\s+(?:et|je|j['’]ai|je cherche|je veux|pour)\b|[.!?,;:]|$)/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m?.[1]) return m[1].trim().replace(/[.!?,;:]+$/, "");
  }
  // Réponse courte typique lorsque le bot vient de demander le nom.
  // On ne l'active que pour un ou deux mots alphabétiques afin d'éviter de
  // transformer arbitrairement une demande courte en nom client.
  if (/^[A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,40}(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,40})?$/.test(raw)) return raw;
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

function stemFrench(token) {
  let t = token;
  if (t.length <= 4) return t;
  for (const suffix of ["issements", "issement", "ations", "ation", "ements", "ement", "erais", "erait", "eront", "eraient", "es", "ent", "e", "s"]) {
    if (t.length - suffix.length >= 4 && t.endsWith(suffix)) return t.slice(0, -suffix.length);
  }
  return t;
}

function classicTokens(text) {
  const normalized = normalize(text);
  return normalized
    .split(/\s+/)
    .filter((token) => token && !FRENCH_STOPWORDS.has(token))
    .map(stemFrench);
}

function classicFeatures(text) {
  const tokens = classicTokens(text);
  const features = [...tokens];
  for (let i = 0; i < tokens.length - 1; i += 1) features.push(`${tokens[i]}_${tokens[i + 1]}`);
  return [...new Set(features)];
}

function editDistance(a, b) {
  const aa = String(a), bb = String(b);
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
    const matched = target.filter((wanted) => tokens.some((got) =>
      got === wanted || stemFrench(got) === stemFrench(wanted) || (wanted.length >= 5 && editDistance(got, wanted) <= 1)
    )).length;
    best = Math.max(best, matched / target.length);
  }
  return best;
}

function patternScore(text, intent) {
  const n = normalize(text);
  const patterns = {
    stock: [
      /\b(?:vous|tu)\s+(?:en\s+)?avez\s+(?:encore|actuellement|toujours)\b/,
      /\b(?:il|en)\s+(?:vous\s+)?reste(?:nt)?\b/,
      /\b(?:reste|restent)\s+(?:encore|des)\s+(?:articles|produits|savons)\b/,
      /\bdisponib(?:le|les)\b/,
      /\b(?:toujours|encore)\s+(?:approvisionn|en\s+stock)\w*\b/,
      /\b(?:encore)\s+(?:en\s+)?commander\b/
    ],
    price: [
      /\b(?:combien|quel)\s+(?:ca|faut|dois|doit)\b/,
      /\bbudget\b/,
      /\b(?:a|à)\s+combien\b/,
      /\b(?:quel|combien)\s+(?:prix|tarif|montant|cout|coût)\b/,
      /\b(?:prevoir|prévoir)\b.*\b(?:budget|montant|combien)\b/
    ],
    order: [
      /\b(?:je|on)\s+(?:peux|voudrais|veux|vais|souhaite)\s+(?:passer|faire)\s+(?:une\s+)?commande\b/,
      /\bje\s+(?:confirme|prends|reserve|réserve)\b/,
      /\b(?:reserver|réserver)\b/,
      /\b(?:acheter|commander)\b/,
      /\b(?:mettre|mettez)\s+(?:moi|de\s+cote|de\s+côté)\b/
    ],
    paymentRequest: [
      /\b(?:comment|ou|quel(?:s)?|quels)\b.*\b(?:payer|paie|paiement|regler|régler|moyens?|modes?)\b/,
      /\b(?:ou|où)\s+(?:dois|peux|effectuer|faire)\b.*\b(?:paiement|payer|reglement|règlement)\b/,
      /\b(?:paiement|reglement|règlement)\b.*\b(?:comment|se\s+fait|effectuer|faire)\b/,
      /\b(?:mobile\s+money|orange\s+money|mtn\s+(?:momo|mobile\s+money))\b.*\b(?:payer|regler|régler|accepte|accepté)\b/,
      /\b(?:moyens?|modes?)\s+de\s+paiement\b/,
      /\b(?:numero|numéro)\b.*\b(?:payer|paiement)\b/
    ],
    paymentDone: [
      /\b(?:j['’]?ai|je\s+viens\s+de|voila|voilà|c['’]?est\s+bon|mon)\b.*\b(?:pay[eé]|paiement|reglement|règlement|transaction|argent)\b/,
      /\b(?:paiement|reglement|règlement|transaction)\b.*\b(?:effectu[eé]|fait|deja|déjà)\b/,
      /\b(?:j['’]?ai|je\s+viens\s+de)\b.*\b(?:effectu[eé]|envoy[eé]|regl[eé])\b.*\b(?:paiement|reglement|règlement|argent)\b/
    ],
    tracking: [
      /\b(?:ou|où)\s+en\s+est\b.*\b(?:commande|livraison|colis)\b/,
      /\b(?:quand|a\s+quelle\s+date)\b.*\b(?:recevoir|livr[eé]e?|colis|commande|livraison)\b/,
      /\b(?:pas\s+re[cç]u|toujours\s+pas\s+re[cç]u|colis\s+parti|n['’]?ai\s+pas\s+re[cç]u)\b/,
      /\b(?:suivre|suivi)\b.*\b(?:commande|colis|livraison)\b/,
      /\b(?:livraison|colis)\b.*\b(?:quand|parti|ou|où)\b/
    ],
    human: [
      /\b(?:personne|humain|conseiller|equipe|équipe)\b/,
      /\bparler\b.*\b(?:personne|quelqu|conseiller|humain)\b/,
      /\b(?:mettre|mettrez)\b.*\b(?:relation|contact)\b/,
      /\b(?:joindre|echanger|échanger|discuter)\b.*\b(?:personne|conseiller|equipe|équipe|quelqu)\b/,
      /\b(?:vraie|vrai)\s+personne\b/
    ],
  };
  return (patterns[intent] || []).some((re) => re.test(n)) ? 0.94 : 0;
}

// Motifs de décision très explicites. Ils servent de garde-fou au TF-IDF :
// une formulation évidente doit être reconnue même si ses mots ne figurent
// pas exactement dans les exemples d'entraînement.
function decisiveIntent(text) {
  const n = normalize(text);

  // Une confirmation de paiement est différente d'une demande de moyen de paiement.
  if (/(?:j['’]?ai|je\s+viens\s+de|voila|voilà|c['’]?est\s+bon)\b.*\b(?:pay[eé]|paiement|reglement|règlement|transaction|argent)\b/.test(n) ||
      /\b(?:paiement|reglement|règlement|transaction)\b.*\b(?:effectu[eé]|fait|deja|déjà)\b/.test(n) ||
      /\b(?:j['’]?ai|je\s+viens\s+de)\b.*\b(?:envoy[eé]|effectu[eé]|regl[eé])\b/.test(n)) {
    return 'paymentDone';
  }
  if (/(?:comment|ou|où|quel(?:s)?|quels)\b.*\b(?:payer|paie|paiement|regler|régler|moyens?|modes?)/.test(n) ||
      /\b(?:moyens?|modes?)\s+de\s+paiement\b/.test(n) ||
      /\b(?:paiement|reglement|règlement)\b.*\b(?:comment|se\s+fait|effectuer|faire)\b/.test(n)) {
    return 'paymentRequest';
  }
  if (/\b(?:toujours\s+pas\s+re[cç]u|n['’]?ai\s+pas\s+re[cç]u)\b/.test(n) ||
      /\b(?:livraison|colis)\b.*\b(?:parti|quand|ou|où)\b/.test(n)) return 'tracking';
  if (/\b(?:personne|humain|conseiller|quelqu|equipe|équipe)\b/.test(n) &&
      /\b(?:parler|echanger|échanger|discuter|joindre|avoir|mettre|relation|contact)\b/.test(n)) return 'human';
  if (/\bbudget\b/.test(n) || (/\b(?:prevoir|prévoir)\b/.test(n) && /\b(?:combien|prix|montant|cout|coût|tarif)\b/.test(n))) return 'price';
  if (/\b(?:encore|toujours|reste|restent|disponible|approvisionn)\w*\b/.test(n) && /\b(?:avez|reste|commander|stock|article|produit|savon)\b/.test(n)) return 'stock';
  if (/\b(?:confirme|réserve|reserve|prends|prendre|acheter|commander)\b/.test(n) || /\bpasser\s+(?:une\s+)?commande\b/.test(n)) return 'order';
  return null;
}

function scoreIntent(text, terms) {
  const normalized = normalize(text);
  let best = 0;
  for (const term of terms) {
    const p = normalize(term);
    if (!p) continue;
    if (normalized === p) best = Math.max(best, 1);
    else if (phrasePresent(normalized, p)) best = Math.max(best, p.split(/\s+/).length >= 2 ? 0.92 : 0.84);
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

function tokenize(text) { return classicFeatures(text); }

function makeTfidfVectors(texts) {
  const tokenized = texts.map(tokenize);
  const documentFrequency = new Map();
  for (const tokens of tokenized) for (const token of new Set(tokens)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
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
  return { vocabulary, index, vectors, documentFrequency, totalDocs };
}

function vectorize(text, model) {
  const tokens = tokenize(text);
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  const vector = new Array(model.vocabulary.length).fill(0);
  for (const [token, count] of counts) {
    const i = model.index.get(token);
    if (i === undefined) continue;
    const df = model.documentFrequency.get(token) || 0;
    const idf = Math.log((1 + model.totalDocs) / (1 + df)) + 1;
    vector[i] = (1 + Math.log(count)) * idf;
  }
  return vector;
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

let semanticCache = { key: "", examples: [], model: null };

function buildSemanticExamples(config) {
  const examples = new Map(Object.entries(INTENT_EXAMPLES).map(([intent, values]) => [intent, [...values]]));
  for (const [intent, values] of Object.entries(DEFAULT_INTENTS)) {
    if (!examples.has(intent)) examples.set(intent, []);
    examples.get(intent).push(...values.slice(0, 12));
  }
  for (const [category, aliases] of Object.entries(config?.procedureConfig?.escalations || {})) {
    const intent = category === "paiement" ? "paymentDone" : category;
    if (!examples.has(intent)) examples.set(intent, []);
    examples.get(intent).push(...aliases.map((alias) => `Je demande de l'aide pour ${alias}`));
  }
  return [...examples.entries()].map(([intent, texts]) => ({ intent, texts: [...new Set(texts)] }));
}

async function semanticIntentScores(message, config) {
  const examples = buildSemanticExamples(config);
  const key = examples.map((x) => `${x.intent}:${x.texts.join("|")}`).join("\n");
  if (semanticCache.key !== key) {
    const flat = examples.flatMap((x) => x.texts.map((text) => ({ intent: x.intent, text })));
    semanticCache = { key, examples: flat, model: makeTfidfVectors(flat.map((x) => x.text)) };
  }
  const query = vectorize(message, semanticCache.model);
  const scores = {};
  for (let i = 0; i < semanticCache.examples.length; i += 1) {
    const { intent } = semanticCache.examples[i];
    scores[intent] = Math.max(scores[intent] || 0, cosineSimilarity(query, semanticCache.model.vectors[i]));
  }
  return scores;
}

function detectCompoundIntent(text, scores) {
  const normalized = normalize(text);
  const active = Object.entries(scores)
    .filter(([intent, score]) => !intent.startsWith("escalation:") && score >= 0.55)
    .sort((a, b) => b[1] - a[1]);
  if (active.length < 2) return false;

  const connectors = /\b(?:et|mais|avant|puis|aussi|ensuite|ainsi que|egalement)\b/;
  const hasConnector = connectors.test(normalized);
  const close = active[0][1] - active[1][1] < 0.18;
  const distinct = active[0][0] !== active[1][0];
  return distinct && (hasConnector || close);
}

function hasExclusion(intent, text) {
  return (EXCLUSION_TERMS[intent] || []).some((term) => phrasePresent(text, term));
}

function rankScores(combined) {
  return Object.entries(combined)
    .sort((a, b) => {
      const diff = b[1] - a[1];
      if (Math.abs(diff) > 0.0001) return diff;
      return INTENT_PRIORITY.indexOf(a[0]) - INTENT_PRIORITY.indexOf(b[0]);
    });
}

export async function getLocalChatConfig() {
  const [procedures, bienfaits, openingMessage] = await Promise.all([loadProcedures(), loadBienfaits(), loadOpeningMessage()]);
  return { procedures, bienfaits, openingMessage, procedureConfig: extractProcedureConfig(procedures), benefitMap: extractBenefitMap(bienfaits) };
}

export async function analyzeLocalMessage(message, options = {}) {
  const config = options.config || await getLocalChatConfig();
  const text = normalize(message);
  const ruleScores = {};
  for (const [intent, terms] of Object.entries(DEFAULT_INTENTS)) ruleScores[intent] = scoreIntent(text, terms);

  for (const [category, terms] of Object.entries(config.procedureConfig.escalations || {})) ruleScores[`escalation:${category}`] = scoreIntent(text, terms);

  // Paiement : une confirmation de paiement doit toujours battre une simple
  // mention d'un moyen de paiement. Inversement, demander comment payer ne
  // doit jamais être classé comme paiement déjà effectué.
  const explicitPaymentDone = DEFAULT_INTENTS.paymentDone.some((x) => phrasePresent(text, x));
  const explicitPaymentRequest = DEFAULT_INTENTS.paymentRequest.some((x) => phrasePresent(text, x));
  if (explicitPaymentDone) {
    ruleScores.paymentDone = 0.99;
    ruleScores.paymentRequest = Math.min(ruleScores.paymentRequest || 0, 0.18);
  } else if (explicitPaymentRequest) {
    ruleScores.paymentRequest = 0.99;
    ruleScores.paymentDone = Math.min(ruleScores.paymentDone || 0, 0.08);
  }

  const decisive = decisiveIntent(message);
  if (decisive) {
    ruleScores[decisive] = Math.max(ruleScores[decisive] || 0, 0.985);
    for (const other of Object.keys(DEFAULT_INTENTS)) {
      if (other !== decisive && (other === 'paymentDone' || other === 'paymentRequest' || other === 'tracking' || other === 'stock' || other === 'order' || other === 'human' || other === 'price')) {
        if (ruleScores[other]) ruleScores[other] *= 0.25;
      }
    }
  }

  let semanticScores = {};
  try {
    semanticScores = await semanticIntentScores(message, config);
  } catch (error) {
    log.warn("Analyse sémantique locale échouée — règles conservées", { error: error?.message || String(error) });
  }

  const combined = {};
  const allIntents = new Set([...Object.keys(ruleScores), ...Object.keys(semanticScores)]);
  for (const intent of allIntents) {
    const rule = ruleScores[intent] || 0;
    const semantic = semanticScores[intent] || 0;
    const lexical = DEFAULT_INTENTS[intent] ? lexicalApproximation(message, DEFAULT_INTENTS[intent]) : 0;
    const pattern = patternScore(message, intent);

    // Règle explicite > motifs conversationnels > TF-IDF > rapprochement lexical.
    let score = rule * 0.55 + pattern * 0.20 + semantic * 0.18 + lexical * 0.07;
    if (rule >= 0.90) score += 0.18;
    else if (rule >= 0.84) score += 0.10;
    if (hasExclusion(intent, text)) score *= 0.18;
    combined[intent] = Math.min(0.99, score);
  }

  const ranked = rankScores(combined);
  const top = ranked[0]?.[0] || null;
  const topScore = ranked[0]?.[1] || 0;
  const secondScore = ranked[1]?.[1] || 0;
  const margin = Math.max(0, topScore - secondScore);
  const compoundIntent = detectCompoundIntent(text, combined);

  let intent = "normal";
  if (top?.startsWith("escalation:") && topScore >= 0.68) intent = top.slice("escalation:".length);
  else if (topScore >= 0.50) intent = top;

  // Un message avec deux intentions fortes est volontairement marqué comme
  // ambigu. Groq possède alors l'historique et peut déterminer l'action finale.
  const confidenceBase = Math.min(0.99, topScore);
  const separation = Math.min(1, margin / 0.20);
  const confidence = Math.min(0.99, confidenceBase * (0.72 + 0.28 * separation));

  const entities = detectSpecialEntities(message);
  const name = findName(message);
  const need = findNeed(message);
  const explicitSimpleIntent = ["greeting", "farewell", "thanks"].includes(intent) && ruleScores[intent] >= LOCAL_NLP_THRESHOLDS.strongRule;
  const paymentExplicit = explicitPaymentDone || explicitPaymentRequest;
  const escalationExplicit = intent && ["partenariat", "reclamation", "formation", "programme_alimentaire"].includes(intent) && (ruleScores[`escalation:${intent}`] || 0) >= 0.80;
  const confidenceEnough = confidence >= LOCAL_NLP_THRESHOLDS.minConfidence;
  const marginEnough = margin >= LOCAL_NLP_THRESHOLDS.minMargin || topScore >= 0.90;

  // `requiresGroq` signifie : le moteur local ne doit pas prendre seul la
  // décision conversationnelle. Les demandes simples peuvent rester locales;
  // les demandes complexes, faibles ou ambiguës sont confiées à Groq.
  const supportedIntent = [
    "greeting", "farewell", "thanks", "catalogue", "paymentDone", "paymentRequest",
    "tracking", "price", "stock", "order", "productInfo", "human",
  ].includes(intent);
  const highConfidence = topScore >= 0.72 && confidence >= 0.78;
  const veryClear = topScore >= 0.88 && margin >= 0.08;
  const localSafe = !compoundIntent && supportedIntent && (
    explicitSimpleIntent || paymentExplicit || escalationExplicit ||
    (highConfidence && marginEnough) || veryClear
  );

  return {
    engine: LOCAL_NLP_ENGINE,
    intent,
    confidence,
    margin,
    ambiguous: compoundIntent || !confidenceEnough || !marginEnough,
    requiresGroq: !localSafe,
    entities,
    name,
    need,
    paymentDone: explicitPaymentDone || (intent === "paymentDone" && topScore >= 0.82),
    paymentRequest: explicitPaymentRequest || (intent === "paymentRequest" && topScore >= 0.82),
    normalized: text,
    scores: combined,
    ruleScores,
    semanticScores,
    classicFeatures: classicFeatures(message),
    config,
  };
}

export function buildLocalNaturalReply(analysis, config, client = {}) {
  const name = client?.nom || analysis.name;
  switch (analysis.intent) {
    case "greeting":
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
