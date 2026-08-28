import fs from "fs";

const CATALOGUE_PATH = "./catalogue.json";

export function loadCatalogue() {
  try {
    const raw = fs.readFileSync(CATALOGUE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Erreur lecture catalogue:", err.message);
    return [];
  }
}

export function saveCatalogue(catalogue) {
  fs.writeFileSync(CATALOGUE_PATH, JSON.stringify(catalogue, null, 2));
}

// Bug corrigé : produits.routes.js importe { loadCatalogue, saveProduit,
// deleteProduit } quel que soit le mode de stockage (voir la bascule
// JSON/Supabase en tête de ce fichier de routes). Comme ce module
// n'exportait que saveCatalogue, cet import nommé faisait planter le
// chargement du module en mode JSON (SUPABASE_URL non défini) : le serveur
// ne démarrait pas du tout. En mode JSON, produits.routes.js appelle ces
// fonctions avec le catalogue complet déjà mis à jour (comme saveCatalogue),
// donc un simple alias suffit — pas besoin de logique supplémentaire ici.
export const saveProduit = saveCatalogue;
export const deleteProduit = saveCatalogue;
