import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { loadProcedures, saveProcedures } from "../data/procedures.store.js";

const router = Router();

router.get("/", requireAdmin, (req, res) => {
  res.json({ content: loadProcedures() });
});

router.put("/", requireAdmin, (req, res) => {
  const { content } = req.body;
  if (typeof content !== "string") {
    return res.status(400).json({ error: "content (texte) est obligatoire" });
  }
  saveProcedures(content);
  res.json({ content });
});

export default router;
