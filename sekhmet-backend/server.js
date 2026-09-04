import { config } from "./config/env.js";
import app from "./app.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("server");

function mask(value) {
  if (!value) return "❌ MANQUANT";
  return `✅ définie (${value.length} car.)`;
}

// Au démarrage, on affiche clairement ce qui est configuré ou non : la
// plupart des bugs "ça ne répond plus" viennent d'une variable d'env vide
// après un redéploiement, et c'était invisible jusqu'ici.
log.info("Démarrage — vérification de la configuration", {
  GROQ_API_KEY: mask(config.groqApiKey),
  VERIFY_TOKEN: mask(config.verifyToken),
  WHATSAPP_TOKEN: mask(config.whatsappToken),
  PHONE_NUMBER_ID: config.phoneNumberId || "❌ MANQUANT",
  ADMIN_TOKEN: mask(config.adminToken),
  mode_stockage: config.storageMode === "supabase" ? "Supabase" : "SQLite local",
});

const server = app.listen(config.port, "0.0.0.0", () => {
  log.info(`Serveur démarré sur le port ${config.port} (0.0.0.0)`);
});

server.on("error", (err) => {
  log.error("Impossible de démarrer le serveur HTTP", err);
  process.exitCode = 1;
});

// Render envoie SIGTERM lors d'un redéploiement. On ferme proprement le serveur
// pour éviter un démarrage/arrêt incomplet qui peut perturber le port scan.
process.on("SIGTERM", () => {
  log.info("SIGTERM reçu — arrêt propre du serveur");
  server.close(() => process.exit(0));
});
