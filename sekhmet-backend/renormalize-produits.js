/**
 * Script ponctuel : renormalise toutes les photos déjà présentes dans le
 * bucket Supabase "produits" (mêmes règles que routes/upload.routes.js) :
 * conversion en JPEG RGB 8 bits/canal, orientation EXIF appliquée,
 * transparence aplatie sur fond blanc, taille plafonnée à 1600x1600.
 *
 * Le fichier est écrasé AU MÊME NOM (upsert), donc les URLs déjà stockées
 * dans la table "produits" (colonne image_url) restent valides : aucune
 * mise à jour de la base n'est nécessaire après ce script.
 *
 * Utilisation :
 *   1) npm install sharp @supabase/supabase-js   (si pas déjà présents)
 *   2) SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/renormalize-produits.js
 *      (SUPABASE_SERVICE_KEY = clé "service_role", pas la clé publique —
 *       nécessaire pour écrire dans le bucket)
 *
 * Le script est idempotent : le relancer sur des images déjà normalisées
 * ne change rien de visible (juste un léger ré-encodage JPEG).
 */
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = "produits";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Merci de définir SUPABASE_URL et SUPABASE_SERVICE_KEY (clé service_role) avant de lancer ce script.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function normaliseImage(buffer) {
  return sharp(buffer)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

async function listAllFiles() {
  const files = [];
  let offset = 0;
  const pageSize = 100;
  for (;;) {
    const { data, error } = await supabase.storage.from(BUCKET).list("", {
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(`Listage du bucket : ${error.message}`);
    if (!data || data.length === 0) break;
    // Ignore les entrées "dossier" (id null) — normalement absentes ici
    // puisque toutes les photos sont stockées à plat, mais on filtre par sécurité.
    files.push(...data.filter((f) => f.id));
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return files;
}

async function run() {
  console.log(`Connexion au bucket "${BUCKET}"...`);
  const files = await listAllFiles();
  console.log(`${files.length} fichier(s) trouvé(s). Début de la renormalisation.\n`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const path = file.name;
    try {
      const { data: blob, error: downloadError } = await supabase.storage.from(BUCKET).download(path);
      if (downloadError) throw new Error(`téléchargement : ${downloadError.message}`);

      const buffer = Buffer.from(await blob.arrayBuffer());
      const normalised = await normaliseImage(buffer);

      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, normalised, {
        contentType: "image/jpeg",
        upsert: true,
      });
      if (uploadError) throw new Error(`ré-upload : ${uploadError.message}`);

      console.log(`OK   ${path}  (${buffer.length} -> ${normalised.length} octets)`);
      ok++;
    } catch (err) {
      // Une image totalement corrompue / illisible par sharp est signalée
      // mais ne bloque pas le traitement des suivantes.
      console.error(`ÉCHEC ${path} : ${err.message}`);
      failed++;
    }
  }

  console.log(`\nTerminé. ${ok} image(s) renormalisée(s), ${failed} échec(s), ${skipped} ignorée(s).`);
  if (failed > 0) {
    console.log("Les échecs correspondent probablement à des fichiers corrompus ou non-image : à vérifier/ré-uploader manuellement depuis l'admin.");
  }
}

run().catch((err) => {
  console.error("Erreur fatale :", err.message);
  process.exit(1);
});
