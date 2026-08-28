import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { config } from "../config/env.js";

// Bascule automatique JSON / Supabase, même pattern que le reste du code.
const { loadPaiementCompte, savePaiementCompte } = config.supabaseUrl
  ? await import("../data/configTextes.store.supabase.js")
  : await import("../data/paiementCompte.store.js");

const router = Router();

router.get("/", requireAdmin, async (req, res) => {
  try {
    res.json(await loadPaiementCompte());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/", requireAdmin, async (req, res) => {
  const { numero, nom } = req.body;
  if (!numero || !numero.trim()) {
    return res.status(400).json({ error: "numero est obligatoire" });
  }
  try {
    const compte = await savePaiementCompte({ numero: numero.trim(), nom: (nom || "").trim() });
    res.json(compte);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
