import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import {
  getEscalationsLog,
  findEscalation,
  closeEscalationById,
  clearPending,
  closeEscalationLog,
} from "../services/escalation.service.js";
import { sendWhatsappMessage } from "../services/whatsapp.service.js";

const router = Router();

router.get("/", requireAdmin, (req, res) => {
  res.json(getEscalationsLog());
});

router.patch("/:id/cloturer", requireAdmin, (req, res) => {
  const entry = closeEscalationById(req.params.id);
  if (!entry) {
    return res.status(404).json({ error: "Escalade introuvable" });
  }
  res.json(entry);
});

// NOUVELLE ROUTE : répondre directement au client depuis l'interface,
// sans passer par la commande WhatsApp /repondre.
router.post("/:id/repondre", requireAdmin, async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "message est obligatoire" });
  }

  const entry = findEscalation(req.params.id);
  if (!entry) {
    return res.status(404).json({ error: "Escalade introuvable" });
  }

  await sendWhatsappMessage(entry.from, message);
  clearPending(entry.from);
  closeEscalationLog(entry.from);

  res.json({ ...entry, status: "cloturee" });
});

export default router;
