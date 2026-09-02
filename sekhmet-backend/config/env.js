import "dotenv/config";

const requestedStorageRaw = process.env.STORAGE_MODE?.trim().toLowerCase();
const hasSupabaseCredentials = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);

// En production, si Supabase est configuré mais que STORAGE_MODE a été oublié,
// on choisit Supabase plutôt que de basculer silencieusement sur une SQLite
// locale. Cela évite notamment de perdre clients, paiements et consommation
// après un redéploiement Render. Pour le développement local, l'absence de
// credentials Supabase conserve SQLite comme défaut.
let storageMode;
if (!requestedStorageRaw) {
  storageMode = hasSupabaseCredentials ? "supabase" : "sqlite";
} else if (["sqlite", "local"].includes(requestedStorageRaw)) {
  storageMode = "sqlite";
} else if (requestedStorageRaw === "supabase") {
  storageMode = "supabase";
} else {
  storageMode = hasSupabaseCredentials ? "supabase" : "sqlite";
}

if (storageMode === "supabase" && !hasSupabaseCredentials) {
  throw new Error(
    "STORAGE_MODE=supabase mais SUPABASE_URL ou SUPABASE_SERVICE_KEY est manquant. " +
    "Le serveur est arrêté pour éviter d'utiliser SQLite par erreur."
  );
}

export const config = {
  port: Number.parseInt(process.env.PORT || "3000", 10),
  groqApiKey: process.env.GROQ_API_KEY,
  verifyToken: process.env.VERIFY_TOKEN,
  whatsappToken: process.env.WHATSAPP_TOKEN,
  phoneNumberId: process.env.PHONE_NUMBER_ID,
  humanAgentNumber: process.env.HUMAN_AGENT_NUMBER,
  escalationTemplateName: process.env.WHATSAPP_ESCALATION_TEMPLATE_NAME?.trim() || null,
  escalationTemplateLanguage: process.env.WHATSAPP_ESCALATION_TEMPLATE_LANGUAGE?.trim() || "fr",
  adminToken: process.env.ADMIN_TOKEN,
  escalationTimeoutMs: 3 * 60 * 60 * 1000,
  // SQLite reste le stockage local recommandé. En production, des credentials
  // Supabase présents activent Supabase par défaut si STORAGE_MODE est absent.
  storageMode,
  hasSupabaseCredentials,
  dataDir: process.env.DATA_DIR || "./data",
  sqliteDbPath: process.env.SQLITE_DB_PATH || "./data/sekhmet.sqlite",
  supabaseUrl: storageMode === "supabase" ? process.env.SUPABASE_URL : undefined,
  supabaseServiceKey: storageMode === "supabase" ? process.env.SUPABASE_SERVICE_KEY : undefined,
};
