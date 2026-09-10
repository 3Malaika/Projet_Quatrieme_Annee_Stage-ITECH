import { Router } from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import { fileURLToPath } from "url";
import { requireAdmin } from "../middleware/adminAuth.js";
import { config } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("upload");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, "../uploads/produits"));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => file.mimetype.startsWith("image/") ? cb(null, true) : cb(new Error("Seules les images sont acceptées")),
});
const BUCKET = "produits";
const router = Router();

// Normalise n'importe quelle image reçue (CMYK, HEIC renommé .jpeg, PNG
// 16 bits, profil couleur exotique, EXIF orienté, etc.) en un JPEG RGB
// 8 bits/canal standard, seul format garanti accepté par l'API WhatsApp
// (cf. erreur 131053 "Media upload error" observée en production sur des
// photos passées jusqu'ici sans transformation). On applique aussi une
// taille maximale raisonnable pour éviter les fichiers inutilement lourds.
async function normaliseImage(buffer) {
  return sharp(buffer)
    .rotate() // applique l'orientation EXIF puis la retire, évite les photos de travers
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }) // aplati toute transparence sur fond blanc, force RGB
    .jpeg({ quality: 85, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

router.post("/produit-image", requireAdmin, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu (champ attendu : "image").' });

  let normalisedBuffer;
  try {
    normalisedBuffer = await normaliseImage(req.file.buffer);
  } catch (err) {
    log.error("Échec de la normalisation de l'image (fichier corrompu ou format non décodable)", err);
    return res.status(400).json({ error: "Image illisible ou corrompue. Merci d'essayer un autre fichier." });
  }

  try {
    const storageMode = config.storageMode;
    // La normalisation ré-encode toujours en JPEG : on force donc l'extension
    // et le type MIME correspondants, quel que soit le format d'origine.
    const filename = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.jpg`;

    if (storageMode === "supabase") {
      const { supabase } = await import("../data/supabase.client.js");
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(filename, normalisedBuffer, {
        contentType: "image/jpeg",
        upsert: false,
      });
      if (uploadError) {
        log.error("Échec upload Supabase Storage", uploadError);
        return res.status(500).json({ error: `Échec de l'upload : ${uploadError.message}` });
      }
      const { data } = supabase.storage.from(BUCKET).getPublicUrl(filename);
      return res.status(201).json({ url: data.publicUrl });
    }

    await fs.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
    await fs.writeFile(path.join(LOCAL_UPLOAD_DIR, filename), normalisedBuffer);
    const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const url = `${baseUrl.replace(/\/$/, "")}/uploads/produits/${filename}`;
    log.info("Photo produit enregistrée localement", { filename });
    return res.status(201).json({ url });
  } catch (err) {
    log.error("Erreur inattendue lors de l'upload", err);
    return res.status(500).json({ error: err.message || "Erreur interne du serveur" });
  }
});

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err) return res.status(400).json({ error: err.message || "Fichier invalide" });
  next(err);
});

export default router;