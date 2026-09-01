import { db, parseJson, getSetting, setSetting } from "./sqlite.db.js";
const DEFAULT_CATEGORIES = ["poudres","farines","sels","graines","grignotages","assaisonnements","produits_sales","laitiers_boissons","patisseries","boissons_naturelles","packs_amincissant","pains","suivi","livraisons","autres"];
export function loadCategories() { return parseJson(getSetting("categories", JSON.stringify(DEFAULT_CATEGORIES)), DEFAULT_CATEGORIES); }
export function saveCategories(categories) { setSetting("categories", categories); }
