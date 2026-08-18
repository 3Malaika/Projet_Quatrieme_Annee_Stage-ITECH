import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { loadClients, upsertClient } from "../data/clients.store.js";

const router = Router();

// Liste de tous les clients identifiés (numéro -> nom, besoin).
router.get("/", requireAdmin, (req, res) => {
  res.json(Object.values(loadClients()));
});

router.get("/:phone", requireAdmin, (req, res) => {
  const clients = loadClients();
  const client = clients[req.params.phone];
  if (!client) {
    return res.status(404).json({ error: "Client introuvable" });
  }
  res.json(client);
});

// Permet à un collaborateur de corriger/compléter manuellement le nom
// d'un client depuis l'interface (utile si l'extraction automatique a raté).
router.put("/:phone", requireAdmin, (req, res) => {
  const { nom, besoin } = req.body;
  if (!nom && !besoin) {
    return res.status(400).json({ error: "nom ou besoin est obligatoire" });
  }
  const updated = upsertClient(req.params.phone, {
    ...(nom ? { nom } : {}),
    ...(besoin ? { besoin } : {}),
    updatedAt: new Date().toISOString(),
  });
  res.json(updated);
});

export default router;
