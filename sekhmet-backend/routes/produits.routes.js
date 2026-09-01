import { Router } from "express";
import fs from "fs/promises";
import path from "path";
import { requireAdmin } from "../middleware/adminAuth.js";
import { config } from "../config/env.js";

// Bascule automatiquement sur Supabase si les variables sont définies
const { loadCatalogue, saveProduit, deleteProduit } = config.supabaseUrl
  ? await import("../data/catalogue.store.supabase.js")
  : await import("../data/catalogue.store.js");

const router = Router();

// Même nom de bucket que routes/upload.routes.js — c'est là que sont
// stockées les photos produit quand on est en mode Supabase.
const BUCKET = "produits";

// Retrouve le chemin du fichier dans le bucket à partir de l'URL publique
// Supabase Storage renvoyée à l'upload (.../object/public/produits/<path>),
// pour pouvoir le supprimer du bucket. Renvoie null si l'URL ne vient pas
// de ce bucket (ex: lien externe collé à la main) — dans ce cas on ne
// supprime que la référence sur le produit, pas de fichier à nettoyer.
function extractStoragePath(url) {
  if (!url) return null;
  const marker = `/object/public/${BUCKET}/`;
  const idx = url.indexOf(marker);
  return idx === -1 ? null : url.slice(idx + marker.length);
}

// La quantité est un champ numérique indépendant du statut disponible/rupture
// (qui reste géré manuellement, sans changement). On la normalise ici pour
// ne jamais stocker autre chose qu'un entier positif, quel que soit le mode
// de stockage.
function normaliseQuantite(value) {
  if (value === undefined) return undefined;
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

router.get("/", requireAdmin, async (req, res) => {
  try {
    const catalogue = await loadCatalogue();
    // En mode Supabase, la colonne est "image_url" (snake_case, comme le
    // reste du schéma) — on la remonte en "imageUrl" pour que le front
    // n'ait qu'une seule convention à gérer, quel que soit le mode de stockage.
    const normalise = config.supabaseUrl
      ? catalogue.map(({ image_url, ...p }) => ({ ...p, imageUrl: image_url || "" }))
      : catalogue;
    res.json(normalise);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", requireAdmin, async (req, res) => {
  const { nom, unite, prix, stock, categorie, description, imageUrl, quantite } = req.body;
  if (!nom || !prix) {
    return res.status(400).json({ error: "nom et prix sont obligatoires" });
  }

  try {
    if (config.supabaseUrl) {
      // Supabase : upsert d'un nouveau produit (l'id est généré par la DB)
      const newProduct = {
        nom,
        unite: unite || "",
        prix,
        stock: stock || "disponible",
        categorie: categorie || "autres",
        description: description || "",
        image_url: imageUrl || "",
        quantite: normaliseQuantite(quantite) ?? 0,
      };
      const saved = await saveProduit(newProduct);
      return res.status(201).json(saved);
    }

    // Fallback JSON
    const catalogue = await loadCatalogue();
    const newProduct = {
      id: String(Date.now()),
      nom,
      unite: unite || "",
      prix,
      stock: stock || "disponible",
      categorie: categorie || "autres",
      description: description || "",
      imageUrl: imageUrl || "",
      quantite: normaliseQuantite(quantite) ?? 0,
    };
    catalogue.push(newProduct);
    await saveProduit(catalogue); // saveCatalogue en mode JSON
    res.status(201).json(newProduct);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/:id", requireAdmin, async (req, res) => {
  try {
    if (config.supabaseUrl) {
      // Le front envoie "imageUrl" (camelCase, cohérent avec le reste de
      // l'API) mais la colonne Supabase est "image_url" (snake_case, comme
      // le reste du schéma) — on convertit ici pour ne pas propager le
      // camelCase jusqu'à la base.
      const { imageUrl, quantite, ...rest } = req.body;
      const payload = { ...rest, id: req.params.id };
      if (imageUrl !== undefined) payload.image_url = imageUrl;
      if (quantite !== undefined) payload.quantite = normaliseQuantite(quantite);
      const updated = await saveProduit(payload);
      return res.json(updated);
    }

    // Stockage local : supprimer aussi le fichier image si l'URL pointe vers
    // le dossier d'uploads du serveur.
    const catalogue = await loadCatalogue();
    const index = catalogue.findIndex((p) => p.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Produit introuvable" });
    const body = { ...req.body };
    if (body.quantite !== undefined) body.quantite = normaliseQuantite(body.quantite);
    catalogue[index] = { ...catalogue[index], ...body, id: catalogue[index].id };
    await saveProduit(catalogue);
    res.json(catalogue[index]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Supprime uniquement la photo d'un produit (le produit lui-même reste).
// Séparé du PUT générique pour pouvoir aussi nettoyer le fichier dans
// Supabase Storage — un simple PUT avec imageUrl: "" ne supprimait que la
// référence et laissait le fichier orphelin dans le bucket.
router.delete("/:id/image", requireAdmin, async (req, res) => {
  try {
    if (config.supabaseUrl) {
      const catalogue = await loadCatalogue();
      const produit = catalogue.find((p) => String(p.id) === String(req.params.id));
      if (!produit) return res.status(404).json({ error: "Produit introuvable" });

      const currentUrl = produit.image_url || produit.imageUrl;
      const path = extractStoragePath(currentUrl);
      if (path) {
        const { supabase } = await import("../data/supabase.client.js");
        const { error: removeError } = await supabase.storage.from(BUCKET).remove([path]);
        // Non bloquant : si le fichier est déjà absent du bucket ou que la
        // suppression échoue pour une autre raison, on retire quand même la
        // référence sur le produit plutôt que de bloquer l'admin.
        if (removeError) console.error("Suppression fichier Storage:", removeError.message);
      }

      const updated = await saveProduit({ id: req.params.id, image_url: "" });
      const { image_url, ...rest } = updated;
      return res.json({ ...rest, imageUrl: image_url || "" });
    }

    // Stockage local : supprimer aussi le fichier image si l'URL pointe vers
    // le dossier d'uploads du serveur.
    const catalogue = await loadCatalogue();
    const index = catalogue.findIndex((p) => p.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Produit introuvable" });
    const currentUrl = catalogue[index].imageUrl || "";
    const marker = "/uploads/produits/";
    const markerIndex = currentUrl.indexOf(marker);
    if (markerIndex !== -1) {
      const filename = decodeURIComponent(currentUrl.slice(markerIndex + marker.length).split("?")[0]);
      const uploadRoot = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads/produits"));
      const candidate = path.resolve(uploadRoot, filename);
      if (candidate.startsWith(uploadRoot + path.sep)) {
        try { await fs.unlink(candidate); } catch (error) {
          if (error.code !== "ENOENT") console.warn("Suppression image locale :", error.message);
        }
      }
    }
    catalogue[index] = { ...catalogue[index], imageUrl: "" };
    await saveProduit(catalogue);
    res.json(catalogue[index]);
  } catch (e) {
    console.error("ERREUR DELETE IMAGE:", e);
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    if (config.supabaseUrl) {
      await deleteProduit(req.params.id);
      return res.status(204).send();
    }

    // Fallback JSON
    const catalogue = await loadCatalogue();
    const filtered = catalogue.filter((p) => p.id !== req.params.id);
    if (filtered.length === catalogue.length)
      return res.status(404).json({ error: "Produit introuvable" });
    await saveProduit(filtered);
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
