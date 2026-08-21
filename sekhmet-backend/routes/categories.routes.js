import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { config } from "../config/env.js";

const { loadCategories, saveCategories } = config.supabaseUrl
  ? await import("../data/categories.store.supabase.js")
  : await import("../data/categories.store.js");

const router = Router();

router.get("/", requireAdmin, async (req, res) => {
  try {
    const categories = await loadCategories();
    res.json(categories.map((name) => ({ id: name, name })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", requireAdmin, async (req, res) => {
  const name = String(req.body.name ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!name) return res.status(400).json({ error: "Le nom de la catégorie est obligatoire" });
  try {
    const categories = await loadCategories();
    if (categories.includes(name)) return res.status(409).json({ error: "Cette catégorie existe déjà" });
    categories.push(name);
    await saveCategories(categories);
    res.status(201).json({ id: name, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/:id", requireAdmin, async (req, res) => {
  const nextName = String(req.body.name ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  const oldName = req.params.id;
  if (!nextName) return res.status(400).json({ error: "Le nom de la catégorie est obligatoire" });
  try {
    const categories = await loadCategories();
    const index = categories.indexOf(oldName);
    if (index === -1) return res.status(404).json({ error: "Catégorie introuvable" });
    if (nextName !== oldName && categories.includes(nextName)) return res.status(409).json({ error: "Cette catégorie existe déjà" });
    categories[index] = nextName;
    await saveCategories(categories);
    res.json({ id: nextName, name: nextName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const categories = await loadCategories();
    const next = categories.filter((name) => name !== req.params.id);
    if (next.length === categories.length) return res.status(404).json({ error: "Catégorie introuvable" });
    await saveCategories(next);
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
