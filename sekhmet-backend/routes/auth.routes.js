import { Router } from "express";
import { config } from "../config/env.js";

const router = Router();

// L'interface envoie le token saisi par l'utilisateur ; on confirme s'il
// est valide. Le frontend garde ensuite ce token pour l'entête Authorization
// de tous ses futurs appels aux routes /api/*.
router.post("/login", (req, res) => {
  const { token } = req.body;
  if (!token || token !== config.adminToken) {
    return res.status(401).json({ success: false, error: "Token invalide" });
  }
  res.json({ success: true });
});

export default router;
