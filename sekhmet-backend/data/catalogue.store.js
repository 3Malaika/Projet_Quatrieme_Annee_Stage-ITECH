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
