import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { config } from "../config/env.js";

const { loadProcedures, saveProcedures } = config.supabaseUrl
  ? await import("../data/configTextes.store.supabase.js")
  : await import("../data/procedures.store.js");

const router = Router();

router.get("/", requireAdmin, async (req, res) => {
  try {
    res.json({ content: await loadProcedures() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/", requireAdmin, async (req, res) => {
  const { content } = req.body;
  if (typeof content !== "string") {
    return res.status(400).json({ error: "content (texte) est obligatoire" });
  }
  try {
    await saveProcedures(content);
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
