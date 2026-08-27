import { Router } from "express";
import { config } from "../config/env.js";
import { requireAdmin } from "../middleware/adminAuth.js";
import { generateInvoicePdfBuffer } from "../services/invoice.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("commandes.routes");

const { loadCommandes, getCommande } = config.supabaseUrl
  ? await import("../data/commandes.store.supabase.js")
  : await import("../data/commandes.store.js");

const router = Router();

router.get("/", requireAdmin, async (req, res) => {
  try {
    res.json(await loadCommandes());
  } catch (err) {
    log.error("Échec chargement commandes", err);
    res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

router.get("/:id/facture.pdf", requireAdmin, async (req, res) => {
  try {
    const commande = await getCommande(req.params.id);
    if (!commande || !commande.numero_facture) {
      return res.status(404).json({ error: "Facture introuvable" });
    }
    const pdfBuffer = await generateInvoicePdfBuffer(commande);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${commande.numero_facture}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    log.error("Échec génération PDF facture (admin)", err);
    res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

export default router;
