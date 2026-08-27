import express from "express";
import cors from "cors";
import { createLogger } from "./utils/logger.js";

import produitsRoutes from "./routes/produits.routes.js";
import proceduresRoutes from "./routes/procedures.routes.js";
import bienfaitsRoutes from "./routes/bienfaits.routes.js";
import escaladesRoutes from "./routes/escalades.routes.js";
import conversationsRoutes from "./routes/conversations.routes.js";
import clientsRoutes from "./routes/clients.routes.js";
import messageOuvertureRoutes from "./routes/messageOuverture.routes.js";
import statsRoutes from "./routes/stats.routes.js";
import authRoutes from "./routes/auth.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";
import categoriesRoutes from "./routes/categories.routes.js";
import commandesRoutes from "./routes/commandes.routes.js";

const log = createLogger("app");

// Ces deux événements étaient auparavant totalement silencieux : une erreur
// non attrapée quelque part (ex: dans un .then() sans .catch()) pouvait
// planter le process ou laisser une requête en suspens sans AUCUNE trace.
process.on("unhandledRejection", (reason) => {
  log.error("Promise rejetée sans catch (unhandledRejection)", reason);
});
process.on("uncaughtException", (err) => {
  log.error("Exception non attrapée (uncaughtException) — le process va peut-être s'arrêter", err);
});

const app = express();

app.use(cors()); // nécessaire pour que l'interface Lovable (autre domaine) appelle l'API
app.use(express.json());

// Log de chaque requête entrante avec son temps de traitement et son code
// de retour — utile pour repérer une route qui répond lentement ou en erreur.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    log[level](`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

app.use("/api/produits", produitsRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/procedures", proceduresRoutes);
app.use("/api/bienfaits", bienfaitsRoutes);
app.use("/api/escalades", escaladesRoutes);
app.use("/api/conversations", conversationsRoutes);
app.use("/api/clients", clientsRoutes);
app.use("/api/message-ouverture", messageOuvertureRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/commandes", commandesRoutes);
app.use("/api", authRoutes); // -> POST /api/login
app.use("/webhook", webhookRoutes);

app.get("/", (req, res) => res.json({ status: "ok", service: "sekhmet-shop-backend" }));

// Filet de sécurité final : si une route express a laissé passer une erreur
// (next(err) ou exception async avec Express 5), on la logge avant de
// répondre, plutôt que de laisser Express gérer ça en silence.
app.use((err, req, res, next) => {
  log.error(`Erreur non gérée sur ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Erreur interne du serveur" });
});

export default app;
