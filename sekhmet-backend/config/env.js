import "dotenv/config";

const requestedStorage = (process.env.STORAGE_MODE || "sqlite").toLowerCase();
const storageMode = ["sqlite", "local", "supabase"].includes(requestedStorage) ? requestedStorage : "sqlite";

export const config = {
  port: process.env.PORT || 3000,
  groqApiKey: process.env.GROQ_API_KEY,
  verifyToken: process.env.VERIFY_TOKEN,
  whatsappToken: process.env.WHATSAPP_TOKEN,
  phoneNumberId: process.env.PHONE_NUMBER_ID,
  humanAgentNumber: process.env.HUMAN_AGENT_NUMBER,
  adminToken: process.env.ADMIN_TOKEN,
  escalationTimeoutMs: 3 * 60 * 60 * 1000,
  // SQLite est le stockage local recommandé. Supabase ne devient actif que
  // lorsqu'il est explicitement choisi, même si des variables Supabase sont présentes.
  storageMode,
  dataDir: process.env.DATA_DIR || "./data",
  sqliteDbPath: process.env.SQLITE_DB_PATH || "./data/sekhmet.sqlite",
  supabaseUrl: storageMode === "supabase" ? process.env.SUPABASE_URL : undefined,
  supabaseServiceKey: storageMode === "supabase" ? process.env.SUPABASE_SERVICE_KEY : undefined,
};
