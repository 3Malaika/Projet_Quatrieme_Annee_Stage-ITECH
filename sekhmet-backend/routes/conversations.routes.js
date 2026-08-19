import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { getAllConversations, getConversation } from "../services/chat.service.js";

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

export default router;
