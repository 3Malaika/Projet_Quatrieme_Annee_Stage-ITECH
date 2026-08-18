import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { loadOpeningMessage, saveOpeningMessage } from "../data/openingMessage.store.js";

const router = Router();

router.get("/", requireAdmin, (req, res) => {
  res.json({ content: loadOpeningMessage() });
});

router.put("/", requireAdmin, (req, res) => {
  const { content } = req.body;
  if (typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ error: "content (texte) est obligatoire" });
  }
  saveOpeningMessage(content);
  res.json({ content });
});

export default router;
