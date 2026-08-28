import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import {
  getAllConversations,
  getConversation,
  deleteConversationHistory,
} from "../services/chat.service.js";

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
