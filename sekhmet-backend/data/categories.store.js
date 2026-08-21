import fs from "fs";

const CATEGORIES_PATH = "./categories.json";
const DEFAULT_CATEGORIES = [
  "poudres",
  "farines",
  "sels",
  "graines",
  "grignotages",
  "assaisonnements",
  "produits_sales",
  "laitiers_boissons",
  "patisseries",
  "boissons_naturelles",
  "packs_amincissant",
  "pains",
  "suivi",
  "livraisons",
  "autres",
];

export function loadCategories() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CATEGORIES_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed : DEFAULT_CATEGORIES;
  } catch {
    return DEFAULT_CATEGORIES;
  }
}

export function saveCategories(categories) {
  fs.writeFileSync(CATEGORIES_PATH, JSON.stringify(categories, null, 2));
}