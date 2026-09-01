import { Router } from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
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

router.post("/produit-image", requireAdmin, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu (champ attendu : "image").' });

  try {
    const storageMode = config.storageMode;
    const extension = (req.file.originalname.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const filename = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${extension}`;

    if (storageMode === "supabase") {
      const { supabase } = await import("../data/supabase.client.js");
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
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
    await fs.writeFile(path.join(LOCAL_UPLOAD_DIR, filename), req.file.buffer);
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
