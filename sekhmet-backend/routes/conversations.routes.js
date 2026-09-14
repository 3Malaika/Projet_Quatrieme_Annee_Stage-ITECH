import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import {
  getAllConversations,
  getConversation,
  deleteConversationHistory,
  appendHistoryEntry,
} from "../services/chat.service.js";
import { sendWhatsappMessage } from "../services/whatsapp.service.js";
import { closeEscalationLog } from "../services/escalation.service.js";

const router = Router();

router.get("/", requireAdmin, async (req, res) => {
  try {
    res.json(await getAllConversations());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:phone", requireAdmin, async (req, res) => {
  try {
    res.json(await getConversation(req.params.phone));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reprendre la main sur la conversation depuis l'admin, à N'IMPORTE QUEL
// MOMENT — pas seulement depuis une escalade active comme le fait déjà
// POST /api/escalades/:id/repondre. Le message est envoyé tel quel sur
// WhatsApp ET ajouté à l'historique (côté "assistant") pour que le fil de
// discussion affiché dans l'admin reste cohérent avec ce que le client a
// réellement reçu. S'il existait une escalade en attente pour ce numéro,
// on la clôture au passage (closeEscalationLog ne fait rien si aucune
// escalade n'est active) : un collaborateur qui répond manuellement prend
// de fait la main sur la demande en cours.
router.post("/:phone/repondre", requireAdmin, async (req, res) => {
  const { message } = req.body;
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: "message est obligatoire" });
  }
  const phone = req.params.phone;
  try {
    await sendWhatsappMessage(phone, message);
    await appendHistoryEntry(phone, { role: "assistant", content: message });
    await closeEscalationLog(phone).catch(() => {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Efface l'historique d'un client précis. Le client repart comme un tout
// nouveau contact au prochain message (message d'accueil renvoyé, etc.).
router.delete("/:phone", requireAdmin, async (req, res) => {
  try {
    await deleteConversationHistory(req.params.phone);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
