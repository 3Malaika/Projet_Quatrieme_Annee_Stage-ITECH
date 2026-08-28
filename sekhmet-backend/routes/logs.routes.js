import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { getRecentImportantLogs } from "../services/systemLogs.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("logs");
const router = Router();

router.get("/", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 8, 50);
    const logs = await getRecentImportantLogs(limit);
    res.json(logs);
  } catch (err) {
    log.error("Échec de la récupération des logs importants", err);
    res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

export default router;
