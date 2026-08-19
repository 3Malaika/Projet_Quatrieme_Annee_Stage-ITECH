import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { config } from "../config/env.js";

// Bascule automatiquement sur Supabase si les variables sont définies
const { loadCatalogue, saveProduit, deleteProduit } = config.supabaseUrl
  ? await import("../data/catalogue.store.supabase.js")
  : await import("../data/catalogue.store.js");

const router = Router();

router.get("/", requireAdmin, async (req, res) => {
  try {
    const catalogue = await loadCatalogue();
    res.json(catalogue);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", requireAdmin, async (req, res) => {
  const { nom, unite, prix, stock, categorie } = req.body;
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
      const updated = await saveProduit({ ...req.body, id: req.params.id });
      return res.json(updated);
    }

    // Fallback JSON
    const catalogue = await loadCatalogue();
    const index = catalogue.findIndex((p) => p.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Produit introuvable" });
    catalogue[index] = { ...catalogue[index], ...req.body, id: catalogue[index].id };
    await saveProduit(catalogue);
    res.json(catalogue[index]);
  } catch (e) {
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
