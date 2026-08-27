import { Router } from "express";
import { config } from "../config/env.js";
import { requireAdmin } from "../middleware/adminAuth.js";
import { getEscalationsLog } from "../services/escalation.service.js";
import { getAllConversations } from "../services/chat.service.js";
import { getUsageSummary } from "../services/usage.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("stats");

// Bascule automatique JSON / Supabase — même pattern que le reste du code.
// Bug corrigé : ces deux imports pointaient toujours vers les fichiers
// locaux, même en mode Supabase (stats admin donc jamais à jour en prod).
const { loadCatalogue } = config.supabaseUrl
  ? await import("../data/catalogue.store.supabase.js")
  : await import("../data/catalogue.store.js");

const { loadClients } = config.supabaseUrl
  ? await import("../data/clients.store.supabase.js")
  : await import("../data/clients.store.js");

const router = Router();

router.get("/", requireAdmin, async (req, res) => {
  try {
    // Bug corrigé : getAllConversations() est asynchrone mais était appelée
    // sans await, donc "conversationsActives" valait toujours undefined.
    const [catalogue, escalades, conversations, clients, usage] = await Promise.all([
      loadCatalogue(),
      getEscalationsLog(),
      getAllConversations(),
      loadClients(),
      getUsageSummary(),
    ]);

    res.json({
      totalProduits: catalogue.length,
      produitsEnRupture: catalogue.filter((p) => p.stock === "rupture").length,
      escaladesEnAttente: escalades.filter((e) => e.status === "en_attente").length,
      escaladesCloturees: escalades.filter((e) => e.status === "cloturee").length,
      conversationsActives: conversations.length,
      clientsIdentifies: Object.keys(clients).length,
      appelsAujourdHui: usage.appelsAujourdHui,
      tokensAujourdHui: usage.tokensAujourdHui,
      appelsCeMois: usage.appelsCeMois,
      tokensCeMois: usage.tokensCeMois,
      tokensTotal: usage.tokensTotal,
      coutEstimeAujourdHui: usage.coutEstimeAujourdHui,
      coutEstimeCeMois: usage.coutEstimeCeMois,
      coutEstimeTotal: usage.coutEstimeTotal,
      coutParModeleCeMois: usage.coutParModeleCeMois,
    });
  } catch (err) {
    log.error("Échec du calcul des stats admin", err);
    res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

export default router;
