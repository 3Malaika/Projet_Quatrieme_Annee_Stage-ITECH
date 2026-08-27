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
// le LLM et garantir une réponse intégrale.
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

export function isDemandeCatalogueComplet(userMessage) {
  const texte = userMessage.toLowerCase();
  return CATALOGUE_KEYWORDS.some((kw) => texte.includes(kw));
}

// Recherche tolérante : le nom donné par le LLM (extrait du message client)
// ne correspond pas forcément mot pour mot au nom exact en base ("poudre
// moringa" doit trouver "Poudre de Moringa"). On matche dans les deux sens
// pour couvrir les noms partiels ou légèrement plus longs.
export function trouverProduitParNom(catalogue, nomRecherche) {
  if (!nomRecherche) return null;
  const cible = nomRecherche.toLowerCase().trim();

  const exact = catalogue.find((p) => p.nom?.toLowerCase().trim() === cible);
  if (exact) return exact;

  const partiel = catalogue.find(
    (p) => p.nom?.toLowerCase().includes(cible) || cible.includes(p.nom?.toLowerCase() ?? "\0")
  );
  return partiel || null;
}

// Texte envoyé en légende de l'image produit (ou en repli texte si pas
// d'image) : description longue si elle existe, sinon les infos de base.
export function formatFicheProduit(produit) {
  const unite = produit.unite ? ` (${produit.unite})` : "";
  const entete = `*${produit.nom}${unite}* — ${produit.prix}`;
  const dispo = produit.stock === "rupture" ? "\n⚠️ Actuellement en rupture de stock." : "";
  const description = produit.description ? `\n\n${produit.description}` : "";
  return `${entete}${description}${dispo}`;
}
