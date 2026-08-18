import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { loadCatalogue } from "../data/catalogue.store.js";
import { getEscalationsLog } from "../services/escalation.service.js";
import { getAllConversations } from "../services/chat.service.js";
import { loadClients } from "../data/clients.store.js";

const router = Router();

router.get("/", requireAdmin, (req, res) => {
  const catalogue = loadCatalogue();
  const escalades = getEscalationsLog();

  res.json({
    totalProduits: catalogue.length,
    produitsEnRupture: catalogue.filter((p) => p.stock === "rupture").length,
    escaladesEnAttente: escalades.filter((e) => e.status === "en_attente").length,
    escaladesCloturees: escalades.filter((e) => e.status === "cloturee").length,
    conversationsActives: getAllConversations().length,
    clientsIdentifies: Object.keys(loadClients()).length,
  });
});

export default router;
