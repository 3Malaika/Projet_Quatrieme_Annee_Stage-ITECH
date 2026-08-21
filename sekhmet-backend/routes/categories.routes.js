import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { loadCategories, saveCategories } from "../data/categories.store.js";

const router = Router();

router.get("/", requireAdmin, (req, res) => {
  res.json(loadCategories().map((name) => ({ id: name, name })));
});

router.post("/", requireAdmin, (req, res) => {
  const name = String(req.body.name ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!name) return res.status(400).json({ error: "Le nom de la catégorie est obligatoire" });
  const categories = loadCategories();
  if (categories.includes(name)) return res.status(409).json({ error: "Cette catégorie existe déjà" });
  categories.push(name);
  saveCategories(categories);
  res.status(201).json({ id: name, name });
});

router.put("/:id", requireAdmin, (req, res) => {
  const nextName = String(req.body.name ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  const oldName = req.params.id;
  if (!nextName) return res.status(400).json({ error: "Le nom de la catégorie est obligatoire" });
  const categories = loadCategories();
  const index = categories.indexOf(oldName);
  if (index === -1) return res.status(404).json({ error: "Catégorie introuvable" });
  if (nextName !== oldName && categories.includes(nextName)) return res.status(409).json({ error: "Cette catégorie existe déjà" });
  categories[index] = nextName;
  saveCategories(categories);
  res.json({ id: nextName, name: nextName });
});

router.delete("/:id", requireAdmin, (req, res) => {
  const categories = loadCategories();
  const next = categories.filter((name) => name !== req.params.id);
  if (next.length === categories.length) return res.status(404).json({ error: "Catégorie introuvable" });
  saveCategories(next);
  res.status(204).send();
});

export default router;