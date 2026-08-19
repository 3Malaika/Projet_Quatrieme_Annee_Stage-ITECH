import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { config } from "../config/env.js";

const { loadClients, upsertClient } = config.supabaseUrl
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

export default router;
