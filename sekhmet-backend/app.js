import express from "express";
import cors from "cors";

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

const app = express();

app.use(cors()); // nécessaire pour que l'interface Lovable (autre domaine) appelle l'API
app.use(express.json());

app.use("/api/produits", produitsRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/procedures", proceduresRoutes);
app.use("/api/bienfaits", bienfaitsRoutes);
app.use("/api/escalades", escaladesRoutes);
app.use("/api/conversations", conversationsRoutes);
app.use("/api/clients", clientsRoutes);
app.use("/api/message-ouverture", messageOuvertureRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api", authRoutes); // -> POST /api/login
app.use("/webhook", webhookRoutes);

app.get("/", (req, res) => res.json({ status: "ok", service: "sekhmet-shop-backend" }));

export default app;
