import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { config } from "../config/env.js";
import { deleteAllClientPaymentData } from "../services/payment.service.js";
import { deleteConversationHistory } from "../services/chat.service.js";

const { loadClients, upsertClient, deleteClient } = config.supabaseUrl
  ? await import("../data/clients.store.supabase.js")
  : await import("../data/clients.store.js");

const router = Router();

router.get("/", requireAdmin, async (req, res) => {
  try {
    const clients = await loadClients();
    res.json(Object.values(clients));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:phone", requireAdmin, async (req, res) => {
  try {
    const clients = await loadClients();
    const client = clients[req.params.phone];
    if (!client) return res.status(404).json({ error: "Client introuvable" });
    res.json(client);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/:phone", requireAdmin, async (req, res) => {
  const { nom, besoin } = req.body;
  if (!nom && !besoin) {
    return res.status(400).json({ error: "nom ou besoin est obligatoire" });
  }
  try {
    const updated = await upsertClient(req.params.phone, {
      ...(nom ? { nom } : {}),
      ...(besoin ? { besoin } : {}),
      updatedAt: new Date().toISOString(),
    });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Suppression EN CASCADE : le panier, l'état de paiement en cours et
// l'historique de conversation d'un client n'ont plus aucun sens une fois
// sa fiche supprimée — les laisser traîner risquerait de les faire
// réapparaître (ou pire, de les rattacher par erreur) si ce même numéro
// est réutilisé plus tard. Les commandes/factures déjà émises et les
// escalades passées ne sont PAS supprimées ici : ce sont des pièces
// comptables/historiques qui doivent normalement survivre à la fiche
// client elle-même (comme une facture papier survit à la fermeture d'un
// compte client).
router.delete("/:phone", requireAdmin, async (req, res) => {
  const { phone } = req.params;
  try {
    await deleteAllClientPaymentData(phone);
    await deleteConversationHistory(phone);
    await deleteClient(phone);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;