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
function normaliserRecherche(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function trouverProduitParNom(catalogue, nomRecherche) {
  if (!nomRecherche || !Array.isArray(catalogue)) return null;
  const cible = normaliserRecherche(nomRecherche);
  if (!cible) return null;

  const exact = catalogue.find((p) => normaliserRecherche(p.nom) === cible);
  if (exact) return exact;

  const candidates = catalogue.map((p) => ({
    produit: p,
    nom: normaliserRecherche(p.nom),
  }));

  // Recherche par inclusion, en privilégiant le nom le plus court/pertinent.
  const partials = candidates.filter(({ nom }) => nom.includes(cible) || cible.includes(nom));
  if (partials.length) {
    partials.sort((a, b) => Math.abs(a.nom.length - cible.length) - Math.abs(b.nom.length - cible.length));
    return partials[0].produit;
  }

  // Tolérance légère aux fautes de frappe : on exige un bon recouvrement des mots.
  const words = cible.split(" ").filter((w) => w.length >= 3);
  if (!words.length) return null;
  let best = null;
  for (const candidate of candidates) {
    const score = words.filter((w) => candidate.nom.includes(w)).length / words.length;
    if (score >= 0.5 && (!best || score > best.score)) best = { produit: candidate.produit, score };
  }
  return best?.produit || null;
}

// Convertit un prix affiché ("5 000 F", "5000 FCFA", "5.000F"...) en nombre
// exploitable (ex: pour calculer un total quantité × prix). Retourne null si
// aucun chiffre n'est trouvé, plutôt que de faire planter un calcul en aval.
export function parsePrixEnNombre(prixAffiche) {
  if (!prixAffiche) return null;
  const chiffres = String(prixAffiche).replace(/[^\d]/g, "");
  if (!chiffres) return null;
  return Number(chiffres);
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
