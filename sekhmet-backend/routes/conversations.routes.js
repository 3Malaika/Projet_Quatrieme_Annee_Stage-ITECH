import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { getAllConversations, getConversation } from "../services/chat.service.js";

const router = Router();

router.get("/", requireAdmin, (req, res) => {
  res.json(getAllConversations());
});

router.get("/:phone", requireAdmin, (req, res) => {
  res.json(getConversation(req.params.phone));
});

export default router;
