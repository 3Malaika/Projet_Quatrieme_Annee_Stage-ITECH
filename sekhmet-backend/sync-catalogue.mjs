/**
 * sync-catalogue.mjs
 * Compare le catalogue.json local avec Supabase et insère les produits manquants.
 * Un produit est considéré "manquant" si aucun produit dans Supabase ne correspond
 * au même nom + même unité (la combinaison nom+unité identifie une variante unique).
 *
 * Usage : node sync-catalogue.mjs
 *         node sync-catalogue.mjs --dry-run   (simulation sans écriture)
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes("--dry-run");

// Chargement des variables d'environnement
const env = Object.fromEntries(
  readFileSync(join(__dirname, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const [k, ...v] = l.split("=");
      return [k.trim(), v.join("=").trim()];
    })
);

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

// Normalise un nom pour la comparaison (minuscules, sans accents, sans espaces superflus)
function normaliser(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Clé d'unicité : nom normalisé + unité normalisée
function cle(nom, unite) {
  return `${normaliser(nom)}|${normaliser(unite)}`;
}

console.log(DRY_RUN ? "=== MODE SIMULATION (--dry-run) ===\n" : "");

// 1. Charger le catalogue local
const catalogueLocal = JSON.parse(
  readFileSync(join(__dirname, "catalogue.json"), "utf8")
);
console.log(`Catalogue local : ${catalogueLocal.length} produits`);

// 2. Charger les produits déjà présents dans Supabase
const { data: produitsSupabase, error } = await sb
  .from("produits")
  .select("id,nom,unite,prix,categorie,stock");

if (error) {
  console.error("Erreur lors du chargement Supabase :", error.message);
  process.exit(1);
}
console.log(`Supabase actuel : ${produitsSupabase.length} produits`);

// 3. Construire un Set des clés déjà présentes dans Supabase
const clesSupa = new Set(produitsSupabase.map((p) => cle(p.nom, p.unite)));

// 4. Identifier les produits manquants
const manquants = catalogueLocal.filter(
  (p) => !clesSupa.has(cle(p.nom, p.unite))
);

console.log(`\nProduits manquants dans Supabase : ${manquants.length}`);
if (manquants.length === 0) {
  console.log("Rien à insérer. Supabase est déjà à jour.");
  process.exit(0);
}

// Afficher la liste des produits à insérer
manquants.forEach((p) => {
  console.log(
    `  + [${p.id}] ${p.nom}${p.unite ? ` (${p.unite})` : ""} | ${p.prix}`
  );
});

if (DRY_RUN) {
  console.log("\nSimulation terminée. Relancez sans --dry-run pour insérer.");
  process.exit(0);
}

// 5. Insérer les produits manquants (sans l'id local : Supabase crée le sien)
console.log("\nInsertion en cours...");
let nbInseres = 0;
let nbEchecs = 0;

for (const p of manquants) {
  // On n'envoie pas l'id local (26a, 26b, etc.) : Supabase génère le sien
  // unite : on envoie toujours une chaîne (jamais null) car la colonne est NOT NULL
  const payload = {
    nom: p.nom,
    unite: p.unite ?? "",
    prix: p.prix,
    categorie: p.categorie || null,
    stock: p.stock || "disponible",
    ...(p.description ? { description: p.description } : {}),
    updated_at: new Date().toISOString(),
  };

  // Supprimer d'abord un éventuel doublon fantôme (duplicate key sur pkey)
  // avant d'insérer — ne lève pas d'erreur si rien à supprimer.
  await sb.from("produits")
    .delete()
    .eq("nom", payload.nom)
    .eq("unite", payload.unite)
    .eq("prix", payload.prix);

  const { data: inserted, error: insertError } = await sb
    .from("produits")
    .insert(payload)
    .select("id,nom,unite")
    .single();

  if (insertError) {
    console.error(
      `  ✗ Échec [${p.id}] ${p.nom} (${p.unite}) : ${insertError.message}`
    );
    nbEchecs++;
  } else {
    console.log(
      `  ✓ Inséré  [ID Supabase: ${inserted.id}] ${inserted.nom}${inserted.unite ? ` (${inserted.unite})` : ""}`
    );
    nbInseres++;
  }
}

console.log(`\n=== Terminé : ${nbInseres} insérés, ${nbEchecs} échecs ===`);
