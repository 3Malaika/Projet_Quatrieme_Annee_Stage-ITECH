import { Router } from "express";
import multer from "multer";
import { requireAdmin } from "../middleware/adminAuth.js";
import { config } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("upload");

// Fichier reçu en mémoire (pas écrit sur disque) : on le relaie directement
// vers Supabase Storage, aucun besoin de stockage intermédiaire.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo — largement suffisant pour une photo produit
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Seules les images sont acceptées"));
    }
    cb(null, true);
  },
});

const BUCKET = "produits";

const router = Router();

router.post("/produit-image", requireAdmin, upload.single("image"), async (req, res) => {
  // L'upload de photos passe par Supabase Storage, indépendamment du mode
  // de stockage choisi pour le catalogue (JSON ou Supabase) : sans
  // SUPABASE_URL/SUPABASE_SERVICE_KEY configurés, il n'y a nulle part où
  // héberger le fichier, donc on refuse clairement plutôt que d'échouer
  // silencieusement plus loin.
  if (!config.supabaseUrl) {
    return res.status(501).json({
      error:
        "L'upload de photos nécessite Supabase Storage. Configurez SUPABASE_URL et SUPABASE_SERVICE_KEY, ou collez un lien d'image existant.",
    });
  }

  if (!req.file) {
    return res.status(400).json({ error: "Aucun fichier reçu (champ attendu : \"image\")." });
  }

  try {
    const { supabase } = await import("../data/supabase.client.js");

    const extension = (req.file.originalname.split(".").pop() || "jpg").toLowerCase();
    // Nom de fichier unique : évite d'écraser une photo existante si deux
    // produits ont un nom proche, ou si la même photo est réuploadée.
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (uploadError) {
      log.error("Échec upload Supabase Storage", uploadError);
      return res.status(500).json({
        error: `Échec de l'upload : ${uploadError.message}. Vérifiez que le bucket "${BUCKET}" existe et est public.`,
      });
    }

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    log.info("Photo produit uploadée", { path, url: data.publicUrl });
    res.status(201).json({ url: data.publicUrl });
  } catch (err) {
    log.error("Erreur inattendue lors de l'upload", err);
    res.status(500).json({ error: err.message || "Erreur interne du serveur" });
  }
});

// Filet de sécurité multer : fichier trop gros, mauvais type, etc. — sans
// ce handler, l'erreur multer remonterait comme une 500 générique et
// masquerait le vrai message ("fichier trop volumineux" par ex.).
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err) {
    return res.status(400).json({ error: err.message || "Fichier invalide" });
  }
  next();
});

export default router;
