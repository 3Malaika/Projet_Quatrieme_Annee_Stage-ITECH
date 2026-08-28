import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { config } from "../config/env.js";

// Bascule automatiquement sur Supabase si les variables sont définies
const { loadCatalogue, saveProduit, deleteProduit } = config.supabaseUrl
  ? await import("../data/catalogue.store.supabase.js")
  : await import("../data/catalogue.store.js");

const router = Router();

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

    // Fallback JSON
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
