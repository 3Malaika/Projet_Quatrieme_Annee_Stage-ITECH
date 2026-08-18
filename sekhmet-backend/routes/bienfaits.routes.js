import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { loadBienfaits, saveBienfaits } from "../data/bienfaits.store.js";

const router = Router();

router.get("/", requireAdmin, (req, res) => {
  res.json({ content: loadBienfaits() });
});

router.put("/", requireAdmin, (req, res) => {
  const { content } = req.body;
  if (typeof content !== "string") {
    return res.status(400).json({ error: "content (texte) est obligatoire" });
  }
  saveBienfaits(content);
  res.json({ content });
});

export default router;
