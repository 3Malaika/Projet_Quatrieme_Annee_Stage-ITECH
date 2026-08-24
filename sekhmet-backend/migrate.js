/**
 * Script de migration unique — données JSON → Supabase
 *
 * À exécuter UNE SEULE FOIS depuis le répertoire sekhmet-backend/ :
 *   node migrate.js
 *
 * Prérequis : SUPABASE_URL et SUPABASE_SERVICE_KEY doivent être définis
 * dans .env (ou dans l'environnement shell).
 */

import "dotenv/config";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("❌  SUPABASE_URL et SUPABASE_SERVICE_KEY doivent être définis dans .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function readJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf-8"));
  } catch {
    console.warn(`⚠️  Fichier introuvable ou invalide : ${path} — ignoré`);
    return fallback;
  }
}

function readText(path, fallback = "") {
  try {
    return fs.readFileSync(path, "utf-8").trim();
  } catch {
    console.warn(`⚠️  Fichier introuvable : ${path} — ignoré`);
    return fallback;
  }
}

async function run() {
  console.log("🚀 Démarrage de la migration...\n");

  // 1. Catalogue
  const catalogue = readJson("./catalogue.json", []);
  if (catalogue.length > 0) {
    const { error } = await supabase.from("produits").upsert(
      catalogue.map((p) => ({
        id: String(p.id),
        nom: p.nom,
        unite: p.unite || "",
        prix: String(p.prix),
        stock: p.stock || "disponible",
        categorie: p.categorie || "autres",
      }))
    );
    if (error) console.error("❌  Catalogue :", error.message);
    else console.log(`✅  Catalogue : ${catalogue.length} produit(s) migrés`);
  } else {
    console.log("⏭️  Catalogue : vide, ignoré");
  }

  // 2. Clients
  const clientsMap = readJson("./clients.json", {});
  const clients = Object.values(clientsMap);
  if (clients.length > 0) {
    const { error } = await supabase.from("clients").upsert(
      clients.map((c) => ({
        phone: c.phone,
        nom: c.nom || null,
        besoin: c.besoin || null,
      }))
    );
    if (error) console.error("❌  Clients :", error.message);
    else console.log(`✅  Clients : ${clients.length} client(s) migrés`);
  } else {
    console.log("⏭️  Clients : vide, ignoré");
  }

  // 3. Conversations
  const convsMap = readJson("./conversations.json", {});
  const convRows = Object.entries(convsMap).map(([phone, messages]) => ({
    phone,
    messages: messages.filter((m) => m.role !== "system"), // on n'stocke pas le system prompt
  }));
  if (convRows.length > 0) {
    const { error } = await supabase.from("conversations").upsert(convRows);
    if (error) console.error("❌  Conversations :", error.message);
    else console.log(`✅  Conversations : ${convRows.length} conversation(s) migrées`);
  } else {
    console.log("⏭️  Conversations : vide, ignoré");
  }

  // 4. Catégories
  const categories = readJson("./categories.json", []);
  if (categories.length > 0) {
    const { error } = await supabase
      .from("categories")
      .upsert(categories.map((name) => ({ name })));
    if (error) console.error("❌  Catégories :", error.message);
    else console.log(`✅  Catégories : ${categories.length} catégorie(s) migrées`);
  } else {
    console.log("⏭️  Catégories : vide, les valeurs par défaut du schéma SQL seront utilisées");
  }

  // 5. Textes de configuration
  const textes = [
    { cle: "bienfaits", path: "./bienfaits.txt", fallback: "" },
    { cle: "procedures", path: "./procedures.txt", fallback: "Aucune procédure spécifique enregistrée." },
    { cle: "message_ouverture", path: "./message_ouverture.txt", fallback: "Bonjour 👋 et merci de nous avoir contactés !" },
  ];

  for (const { cle, path, fallback } of textes) {
    const contenu = readText(path, fallback);
    const { error } = await supabase
      .from("config_textes")
      .upsert({ cle, contenu });
    if (error) console.error(`❌  ${cle} :`, error.message);
    else console.log(`✅  ${cle} migré`);
  }

  console.log("\n🎉 Migration terminée.");
}

run().catch((e) => {
  console.error("Erreur fatale :", e.message);
  process.exit(1);
});
