import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { getAllActiveCarts } from "../services/payment.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("paniers.routes");
const router = Router();

router.get("/", requireAdmin, async (_req, res) => {
  try {
    res.json(getAllActiveCarts());
  } catch (err) {
    log.error("Échec chargement des paniers actifs", err);
    res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

export default router;
