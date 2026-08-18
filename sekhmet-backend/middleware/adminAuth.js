import { config } from "../config/env.js";

// Protection simple : le header "Authorization: Bearer <ADMIN_TOKEN>" doit
// correspondre à la variable d'environnement ADMIN_TOKEN.
export function requireAdmin(req, res, next) {
  const auth = req.headers.authorization; // ex: "Bearer abc123"
  if (auth !== `Bearer ${config.adminToken}`) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  next();
}
