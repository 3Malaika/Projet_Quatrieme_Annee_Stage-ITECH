import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { loadCatalogue, saveCatalogue } from "../data/catalogue.store.js";

const router = Router();

router.get("/", requireAdmin, (req, res) => {
  res.json(loadCatalogue());
});

router.post("/", requireAdmin, (req, res) => {
  const { nom, unite, prix, stock, categorie } = req.body;
  if (!nom || !prix) {
    return res.status(400).json({ error: "nom et prix sont obligatoires" });
  }

  const catalogue = loadCatalogue();
  const newProduct = {
    id: String(Date.now()),
    nom,
    unite: unite || "",
    prix,
    stock: stock || "disponible",
    categorie: categorie || "autres",
  };
  catalogue.push(newProduct);
  saveCatalogue(catalogue);

  res.status(201).json(newProduct);
});

router.put("/:id", requireAdmin, (req, res) => {
  const catalogue = loadCatalogue();
  const index = catalogue.findIndex((p) => p.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: "Produit introuvable" });
  }

  catalogue[index] = { ...catalogue[index], ...req.body, id: catalogue[index].id };
  saveCatalogue(catalogue);

  res.json(catalogue[index]);
});

router.delete("/:id", requireAdmin, (req, res) => {
  const catalogue = loadCatalogue();
  const filtered = catalogue.filter((p) => p.id !== req.params.id);
  if (filtered.length === catalogue.length) {
    return res.status(404).json({ error: "Produit introuvable" });
  }

  saveCatalogue(filtered);
  res.status(204).send();
});

export default router;
