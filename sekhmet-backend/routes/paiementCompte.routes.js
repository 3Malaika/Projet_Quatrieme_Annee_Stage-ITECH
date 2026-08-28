import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { config } from "../config/env.js";

// Bascule automatique JSON / Supabase, même pattern que le reste du code.
const { loadPaiementComptes, savePaiementComptes } = config.supabaseUrl
  ? await import("../data/configTextes.store.supabase.js")
  : await import("../data/paiementCompte.store.js");

const router = Router();

router.get("/", requireAdmin, async (req, res) => {
  try {
    res.json(await loadPaiementComptes());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/", requireAdmin, async (req, res) => {
  const { comptes } = req.body;
  if (!Array.isArray(comptes) || comptes.length === 0) {
    return res.status(400).json({ error: "Au moins un compte (avec un numéro) est obligatoire" });
  }
  if (comptes.some((c) => !c?.numero || !c.numero.trim())) {
    return res.status(400).json({ error: "Chaque compte doit avoir un numéro" });
  }
  try {
    const saved = await savePaiementComptes(
      comptes.map((c) => ({ numero: c.numero.trim(), nom: (c.nom || "").trim() }))
    );
    res.json(saved);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
