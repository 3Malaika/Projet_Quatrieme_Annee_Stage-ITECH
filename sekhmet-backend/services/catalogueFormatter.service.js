const CATEGORY_LABELS = {
  poudres: "🌿 POUDRES NATURELLES",
  farines: "🥣 FARINES",
  sels: "🧂 SELS NATURELS",
  graines: "🌰 GRAINES & LÉGUMINEUSES",
  grignotages: "🍯 GRIGNOTAGES SAINS",
  assaisonnements: "🧂 ASSAISONNEMENTS & SAUCES",
  produits_sales: "🧀 PRODUITS SALÉS",
  laitiers_boissons: "🥛 PRODUITS LAITIERS & BOISSONS",
  patisseries: "🥐 PÂTISSERIES",
  boissons_naturelles: "🥤 BOISSONS NATURELLES",
  packs_amincissant: "🍃 PACKS AMINCISSANT",
  pains: "🍞 NOS DIFFÉRENTS PAINS",
  suivi: "🩺 SUIVI ALIMENTAIRE & BIEN-ÊTRE",
  livraisons: "🥗 LIVRAISONS DES REPAS DIÉTÉTIQUES",
  autres: "🛒 AUTRES PRODUITS",
};

export function formatCatalogueForPrompt(catalogue) {
  return (Array.isArray(catalogue) ? catalogue : []).map((product) => {
    const unite = product?.unite ? ` (${product.unite})` : "";
    const stock = product?.stock === "rupture" ? "rupture de stock" : product?.stock || "disponible";
    return `- ${product?.nom || "Produit"}${unite} : ${product?.prix ?? "prix non renseigné"} — ${stock}`;
  }).join("\n");
}

export function formatCatalogueComplet(catalogue) {
  const grouped = {};
  for (const produit of Array.isArray(catalogue) ? catalogue : []) {
    const cat = produit?.categorie || "autres";
    (grouped[cat] ||= []).push(produit);
  }

  const sections = Object.entries(grouped).map(([category, products]) => {
    const label = CATEGORY_LABELS[category] || CATEGORY_LABELS.autres;
    const lignes = products
      .filter((product) => product?.stock !== "rupture")
      .map((product) => {
        const unite = product?.unite ? ` (${product.unite})` : "";
        return `* ${product.nom}${unite} : ${product.prix}`;
      });
    return lignes.length ? `*${label}*\n${lignes.join("\n")}` : null;
  }).filter(Boolean);

  return "*CATALOGUE DE NOS DIFFÉRENTS PRODUITS NATURELS*\n\n" +
    sections.join("\n\n") +
    "\n\n_Nous livrons à Yaoundé et expédions partout. Merci pour votre confiance !_";
}

const CATALOGUE_KEYWORDS = [
  "catalogue", "tous vos produits", "toute la liste", "liste complète",
  "liste des produits", "tous les produits", "voir tous vos produits",
  "envoyer le catalogue", "menu complet",
];
const CATALOGUE_SHORT_CIRCUIT_MAX_CHARS = 60;

export function isDemandeCatalogueComplet(userMessage) {
  const texte = String(userMessage || "").trim();
  if (!texte || texte.length > CATALOGUE_SHORT_CIRCUIT_MAX_CHARS) return false;
  return CATALOGUE_KEYWORDS.some((keyword) => texte.toLowerCase().includes(keyword));
}

function normaliserVolume(text) {
  return String(text || "")
    .replace(/(\d+)[.,](\d+)\s*l(?:itre)?s?\b/gi, "$1 $2 l")
    .replace(/\b(\d+)\s*l(?:itre)?s?\b/gi, "$1 l")
    .replace(/\b(\d+)\s*ml\b/gi, "$1 ml");
}

function normaliserRecherche(value) {
  const base = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019']/g, " ");
  return normaliserVolume(base)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function scoreTokens(query, target) {
  const qTokens = String(query || "").split(" ").filter(Boolean);
  const tTokens = new Set(String(target || "").split(" ").filter(Boolean));
  if (!qTokens.length) return 0;
  return qTokens.filter((token) => tTokens.has(token)).length / qTokens.length;
}

export function trouverProduitParNom(catalogue, nomRecherche) {
  if (!nomRecherche || !Array.isArray(catalogue)) return null;
  const cible = normaliserRecherche(nomRecherche);
  if (!cible) return null;

  const candidates = catalogue.map((product) => {
    const nom = normaliserRecherche(product?.nom);
    const unite = normaliserRecherche(product?.unite || "");
    return { produit: product, nom, cle: unite ? `${nom} ${unite}` : nom };
  });

  const exactCle = candidates.find((candidate) => candidate.cle === cible);
  if (exactCle) return exactCle.produit;

  const sameNom = candidates.filter((candidate) => candidate.nom === cible);
  if (sameNom.length === 1) return sameNom[0].produit;
  if (sameNom.length > 1) {
    let best = null;
    for (const candidate of sameNom) {
      const score = scoreTokens(cible, candidate.cle);
      if (!best || score > best.score) best = { candidate, score };
    }
    return best?.candidate?.produit || null;
  }

  let best = null;
  for (const candidate of candidates) {
    const coverage = scoreTokens(cible, candidate.cle);
    const precision = scoreTokens(candidate.cle, cible);
    if (coverage === 0) continue;
    const fscore = coverage * 0.7 + precision * 0.3;
    if (!best || fscore > best.fscore) best = { produit: candidate.produit, fscore };
  }
  return best && best.fscore >= 0.4 ? best.produit : null;
}

// Variante de trouverProduitParNom qui, au lieu de renvoyer silencieusement
// SON meilleur candidat, signale explicitement une AMBIGUÏTÉ quand plusieurs
// produits différents sont des correspondances quasi équivalentes pour la
// même recherche (ex: "pain mie" pour "Pain mie au moringa" ET "Pain mie
// (brique)"). Avant ce correctif, ce cas silencieux menait le bot à deviner
// — et à deviner DIFFÉREMMENT d'un message à l'autre pour une recherche
// quasi identique, ce qui est le pire des deux mondes pour le client.
// Retourne { produit, ambigus } : `produit` est non-null seulement s'il n'y
// a pas d'ambiguïté ; `ambigus` liste les candidats quasi à égalité sinon.
export function trouverProduitOuAmbiguite(catalogue, nomRecherche, ecartAmbiguite = 0.12) {
  if (!nomRecherche || !Array.isArray(catalogue)) return { produit: null, ambigus: [] };
  const cible = normaliserRecherche(nomRecherche);
  if (!cible) return { produit: null, ambigus: [] };

  const candidates = catalogue.map((product) => {
    const nom = normaliserRecherche(product?.nom);
    const unite = normaliserRecherche(product?.unite || "");
    return { produit: product, nom, cle: unite ? `${nom} ${unite}` : nom };
  });

  const exactCle = candidates.find((candidate) => candidate.cle === cible);
  if (exactCle) return { produit: exactCle.produit, ambigus: [] };

  const sameNom = candidates.filter((candidate) => candidate.nom === cible);
  if (sameNom.length === 1) return { produit: sameNom[0].produit, ambigus: [] };
  if (sameNom.length > 1) {
    // Même nom, unités différentes (ex: deux "Miel pur") : demande de
    // préciser l'unité plutôt que de deviner laquelle.
    return { produit: null, ambigus: sameNom.map((c) => c.produit) };
  }

  const scored = candidates
    .map((candidate) => {
      const coverage = scoreTokens(cible, candidate.cle);
      const precision = scoreTokens(candidate.cle, cible);
      if (coverage === 0) return null;
      return { produit: candidate.produit, fscore: coverage * 0.7 + precision * 0.3 };
    })
    .filter(Boolean)
    .filter((c) => c.fscore >= 0.4)
    .sort((a, b) => b.fscore - a.fscore);

  if (!scored.length) return { produit: null, ambigus: [] };
  const top = scored[0].fscore;
  const proches = scored.filter((c) => top - c.fscore <= ecartAmbiguite);
  if (proches.length > 1) return { produit: null, ambigus: proches.map((c) => c.produit) };
  return { produit: scored[0].produit, ambigus: [] };
}

export function parsePrixEnNombre(prixAffiche) {
  if (!prixAffiche) return null;
  const match = String(prixAffiche).match(/\b(\d{1,3}(?:[\s.'\u00a0]\d{3})*|\d+)\s*(?:F|FCFA|XAF)?\b/i);
  if (!match) return null;
  const nombre = Number(match[1].replace(/[\s.'\u00a0]/g, ""));
  return Number.isFinite(nombre) && nombre > 0 ? nombre : null;
}

export function formatMontantFcfa(montant) {
  return `${Number(montant || 0).toLocaleString("fr-FR")} F`;
}

export function formatFicheProduit(produit) {
  const unite = produit?.unite ? ` (${produit.unite})` : "";
  const entete = `*${produit?.nom || "Produit"}${unite}* — ${produit?.prix ?? "prix non renseigné"}`;
  const dispo = produit?.stock === "rupture" ? "\n⚠️ Actuellement en rupture de stock." : "";
  const description = produit?.description ? `\n\n${produit.description}` : "";
  return `${entete}${description}${dispo}`;
}

// Regroupe plusieurs produits SANS photo en une seule liste à puces, au lieu
// d'envoyer un message séparé par produit (formatFicheProduit) — qui, sans
// image jointe pour donner du contexte visuel, apparaît comme une rafale de
// bulles de texte à une ligne, ressemblant à des boutons tronqués plutôt
// qu'à une vraie liste. Voir webhook.routes.js, result.type === "recommandation".
export function formatProductListBullets(produits, intro = null) {
  const lignes = (Array.isArray(produits) ? produits : []).map((p) => {
    const unite = p?.unite ? ` (${p.unite})` : "";
    const rupture = p?.stock === "rupture" ? " — rupture de stock" : "";
    return `• *${p?.nom || "Produit"}${unite}* — ${p?.prix ?? "prix non renseigné"}${rupture}`;
  });
  const entete = intro || "Voici les informations sur ces produits :";
  return `${entete}\n\n${lignes.join("\n")}`;
}