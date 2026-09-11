// Ce service résout le problème des réponses tronquées : au lieu de laisser
// le modèle "résumer" le catalogue de tête (et couper des produits), on
// construit ici le texte complet et exact à partir du catalogue.json.

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

// Version condensée injectée dans le prompt système (une ligne par produit).
export function formatCatalogueForPrompt(catalogue) {
  return catalogue
    .map((p) => {
      const unite = p.unite ? ` (${p.unite})` : "";
      return `- ${p.nom}${unite} : ${p.prix} — ${p.stock}`;
    })
    .join("\n");
}

// Version complète, groupée par catégorie, avec émojis — c'est EXACTEMENT
// ce texte que le bot envoie tel quel quand le client demande le catalogue
// complet, sans passer par le LLM : donc jamais coupé, jamais résumé.
export function formatCatalogueComplet(catalogue) {
  const grouped = {};
  for (const produit of catalogue) {
    const cat = produit.categorie || "autres";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(produit);
  }

  const sections = Object.entries(grouped).map(([cat, produits]) => {
    const label = CATEGORY_LABELS[cat] || CATEGORY_LABELS.autres;
    const lignes = produits
      .filter((p) => p.stock !== "rupture")
      .map((p) => {
        const unite = p.unite ? ` (${p.unite})` : "";
        return `* ${p.nom}${unite} : ${p.prix}`;
      });
    return `*${label}*\n${lignes.join("\n")}`;
  });

  return (
    "*CATALOGUE DE NOS DIFFÉRENTS PRODUITS NATURELS*\n\n" +
    sections.join("\n\n") +
    "\n\n_Nous livrons à Yaoundé et expédions partout. Merci pour votre confiance !_"
  );
}

// Détection simple d'une demande de catalogue complet, pour court-circuiter
// le LLM et garantir une réponse intégrale — mais UNIQUEMENT quand le
// message est essentiellement cette demande, pas quand le mot-clé apparaît
// au milieu d'une question plus longue. Sinon un message comme "Votre
// catalogue est-il à jour, j'ai une question sur le prix du miel" se
// voyait répondre par le catalogue brut, sans jamais traiter la vraie
// question du client.
const CATALOGUE_KEYWORDS = [
  "catalogue",
  "tous vos produits",
  "toute la liste",
  "liste complète",
  "liste des produits",
  "tous les produits",
  "voir tous vos produits",
  "envoyer le catalogue",
  "menu complet",
];

const CATALOGUE_SHORT_CIRCUIT_MAX_CHARS = 60;

export function isDemandeCatalogueComplet(userMessage) {
  const texte = String(userMessage || "").trim();
  if (!texte || texte.length > CATALOGUE_SHORT_CIRCUIT_MAX_CHARS) return false;
  const lower = texte.toLowerCase();
  return CATALOGUE_KEYWORDS.some((kw) => lower.includes(kw));
}

// Recherche tolérante : le nom donné par le LLM (extrait du message client)
// ne correspond pas forcément mot pour mot au nom exact en base ("poudre
// moringa" doit trouver "Poudre de Moringa"). On matche dans les deux sens
// pour couvrir les noms partiels ou légèrement plus longs.
// Normalise les abréviations de volume pour le matching produit :
// "1L", "1 litre" => "1 l" ; "0,5L" => "0 5 l" ; "5L" => "5 l"
function normaliserVolume(text) {
  return text
    .replace(/(\d+)[.,](\d+)\s*l(?:itre)?s?\b/gi, "$1 $2 l")
    .replace(/\b(\d+)\s*l(?:itre)?s?\b/gi,        "$1 l")
    .replace(/\b(\d+)\s*ml\b/gi,                   "$1 ml");
}

function normaliserRecherche(value) {
  const base = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['\u2019\u2018]/g, " ");
  const avecVolumes = normaliserVolume(base);
  return avecVolumes
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Score de recouvrement token-à-token entre deux chaînes normalisées.
// Retourne une valeur entre 0 et 1 : fraction des tokens de `query`
// présents (en tant que tokens entiers) dans `target`.
function scoreTokens(query, target) {
  const qTokens = query.split(" ").filter(Boolean);
  const tTokens = new Set(target.split(" ").filter(Boolean));
  if (!qTokens.length) return 0;
  return qTokens.filter(w => tTokens.has(w)).length / qTokens.length;
}

export function trouverProduitParNom(catalogue, nomRecherche) {
  if (!nomRecherche || !Array.isArray(catalogue)) return null;
  const cible = normaliserRecherche(nomRecherche);
  if (!cible) return null;

  const candidates = catalogue.map((p) => {
    const nomNorm  = normaliserRecherche(p.nom);
    const uniteNorm = normaliserRecherche(p.unite || "");
    return {
      produit: p,
      nom: nomNorm,
      cle: uniteNorm ? `${nomNorm} ${uniteNorm}` : nomNorm,
    };
  });

  // 1. Correspondance exacte sur la clé nom+unite
  const exactCle = candidates.find(({ cle }) => cle === cible);
  if (exactCle) return exactCle.produit;

  // 2. Correspondance exacte sur le nom seul (sans unite)
  const exactNom = candidates.find(({ nom }) => nom === cible);
  if (exactNom) {
    const sameNom = candidates.filter(({ nom }) => nom === cible);
    if (sameNom.length === 1) return sameNom[0].produit;
    // Plusieurs variantes : scorer par recouvrement token avec la cible
    let best = null;
    for (const c of sameNom) {
      const s = scoreTokens(cible, c.cle);
      if (!best || s > best.s) best = { c, s };
    }
    return best.c.produit;
  }

  // 3. Scoring token-à-token sur nom+unite.
  // Chaque candidat reçoit deux scores :
  //   - coverage : fraction des tokens de la cible présents dans la clé
  //   - precision : fraction des tokens de la clé présents dans la cible
  // On combine les deux (F-score) pour favoriser la clé la plus précise
  // sans pénaliser les noms longs qui contiennent tous les tokens cherchés.
  let best = null;
  for (const candidate of candidates) {
    const coverage  = scoreTokens(cible, candidate.cle);
    const precision = scoreTokens(candidate.cle, cible);
    // F-score harmonique ; on pondère coverage (0.7) > precision (0.3)
    // pour tolérer les mots supplémentaires dans la recherche ("format", etc.)
    if (coverage === 0) continue;
    const fscore = coverage * 0.7 + precision * 0.3;
    if (!best || fscore > best.fscore) best = { produit: candidate.produit, fscore };
  }
  if (best && best.fscore >= 0.4) return best.produit;
  return null;
}

// Convertit un prix affiché ("5 000 F", "5000 FCFA", "5.000F"...) en nombre
// exploitable (ex: pour calculer un total quantité × prix). Retourne null si
// aucun chiffre n'est trouvé, plutôt que de faire planter un calcul en aval.
//
// IMPORTANT : pour les champs multi-prix ("3 500 F (0,5 L) / 7 000 F (1 L)"),
// cette fonction extrait le PREMIER prix trouvé — filet de sécurité en cas de
// produit non encore splitté. La vraie solution est d'avoir un produit par prix
// dans le catalogue (un produit = un champ prix simple).
export function parsePrixEnNombre(prixAffiche) {
  if (!prixAffiche) return null;
  const str = String(prixAffiche);
  // Cherche le premier nombre de type "3 500", "3500", "10 000" etc.
  // On accepte les séparateurs de milliers espace/point/apostrophe.
  const match = str.match(/\b(\d{1,3}(?:[\s.'\u00a0]\d{3})*|\d+)\s*(?:F|FCFA|XAF)?\b/i);
  if (!match) return null;
  const nombre = Number(match[1].replace(/[\s.'\u00a0]/g, ""));
  return Number.isFinite(nombre) && nombre > 0 ? nombre : null;
}

// Formate un montant numérique en FCFA, séparateur de milliers façon "5 000 F".
export function formatMontantFcfa(montant) {
  return `${montant.toLocaleString("fr-FR")} F`;
}

// Texte envoyé en légende de l'image produit (ou en repli texte si pas
// d'image) : description longue si elle existe, sinon les infos de base.
export function formatFicheProduit(produit) {
  const unite = produit.unite ? ` (${produit.unite})` : "";
  const entete = `Voici les informations sur ce produit :\n\n*${produit.nom}${unite}* — ${produit.prix}`;
  const dispo = produit.stock === "rupture" ? "\n⚠️ Actuellement en rupture de stock." : "";
  const description = produit.description ? `\n\n${produit.description}` : "";
  return `${entete}${description}${dispo}`;
}
