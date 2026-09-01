import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(rootDir, "data"));
const dbPath = path.resolve(process.env.SQLITE_DB_PATH || path.join(dataDir, "sekhmet.sqlite"));

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const dbPathname = dbPath;
export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clients (
    phone TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversations (
    phone TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payment_states (
    phone TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_products_updated_at ON products(updated_at);
  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_logs_created_at ON system_logs(created_at);
`);

function parse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function importJsonIfPresent(filename, callback) {
  const file = path.join(rootDir, filename);
  if (!fs.existsSync(file)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    callback(parsed);
    console.log(`[SQLite] Données migrées depuis ${filename}`);
  } catch (error) {
    console.warn(`[SQLite] Migration ignorée pour ${filename}: ${error.message}`);
  }
}

function importTextIfPresent(filename, key, fallback = "") {
  const file = path.join(rootDir, filename);
  if (!fs.existsSync(file)) return;
  try {
    const value = fs.readFileSync(file, "utf8");
    setSetting(key, value || fallback);
    console.log(`[SQLite] Données migrées depuis ${filename}`);
  } catch (error) {
    console.warn(`[SQLite] Migration ignorée pour ${filename}: ${error.message}`);
  }
}

function settingExists(key) {
  return !!db.prepare("SELECT 1 FROM settings WHERE key = ? LIMIT 1").get(key);
}

export function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return fallback;
  return row.value;
}

export function setSetting(key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, typeof value === "string" ? value : JSON.stringify(value));
}

// Migration automatique, non destructive : les JSON/TXT restent en place comme sauvegarde.
if (!settingExists("migration_v1")) {
  const productCount = db.prepare("SELECT COUNT(*) AS count FROM products").get().count;
  if (Number(productCount) === 0) {
    importJsonIfPresent("catalogue.json", (items) => {
      const insert = db.prepare("INSERT OR IGNORE INTO products(id,data,updated_at) VALUES(?,?,?)");
      const now = new Date().toISOString();
      for (const item of Array.isArray(items) ? items : []) {
        if (item?.id != null) insert.run(String(item.id), JSON.stringify(item), item.updated_at || now);
      }
    });
  }

  const orderCount = db.prepare("SELECT COUNT(*) AS count FROM orders").get().count;
  if (Number(orderCount) === 0) {
    importJsonIfPresent("commandes.json", (items) => {
      const insert = db.prepare("INSERT OR IGNORE INTO orders(id,data,created_at) VALUES(?,?,?)");
      for (const item of Array.isArray(items) ? items : []) {
        if (item?.id != null) insert.run(String(item.id), JSON.stringify(item), item.created_at || new Date().toISOString());
      }
    });
  }

  const clientCount = db.prepare("SELECT COUNT(*) AS count FROM clients").get().count;
  if (Number(clientCount) === 0) {
    importJsonIfPresent("clients.json", (items) => {
      const insert = db.prepare("INSERT OR IGNORE INTO clients(phone,data,updated_at) VALUES(?,?,?)");
      const now = new Date().toISOString();
      for (const [phone, item] of Object.entries(items && typeof items === "object" ? items : {})) {
        insert.run(phone, JSON.stringify(item), item?.updatedAt || now);
      }
    });
  }

  const conversationCount = db.prepare("SELECT COUNT(*) AS count FROM conversations").get().count;
  if (Number(conversationCount) === 0) {
    importJsonIfPresent("conversations.json", (items) => {
      const insert = db.prepare("INSERT OR IGNORE INTO conversations(phone,data,updated_at) VALUES(?,?,?)");
      const now = new Date().toISOString();
      for (const [phone, history] of Object.entries(items && typeof items === "object" ? items : {})) {
        insert.run(phone, JSON.stringify(history), now);
      }
    });
  }

  const usageCount = db.prepare("SELECT COUNT(*) AS count FROM usage").get().count;
  if (Number(usageCount) === 0) {
    importJsonIfPresent("usage.json", (items) => {
      const insert = db.prepare("INSERT INTO usage(data,created_at) VALUES(?,?)");
      for (const item of Array.isArray(items) ? items : []) insert.run(JSON.stringify(item), item?.created_at || new Date().toISOString());
    });
  }

  const logCount = db.prepare("SELECT COUNT(*) AS count FROM system_logs").get().count;
  if (Number(logCount) === 0) {
    importJsonIfPresent("system_logs.json", (items) => {
      const insert = db.prepare("INSERT INTO system_logs(data,created_at) VALUES(?,?)");
      for (const item of Array.isArray(items) ? items : []) insert.run(JSON.stringify(item), item?.created_at || new Date().toISOString());
    });
  }

  if (!settingExists("categories")) {
    importJsonIfPresent("categories.json", (items) => setSetting("categories", items));
  }
  if (!settingExists("paiement_comptes")) {
    importJsonIfPresent("paiement_compte.json", (items) => setSetting("paiement_comptes", items));
  }
  if (!settingExists("payment_states")) {
    importJsonIfPresent("payment-state.json", (items) => {
      const insert = db.prepare("INSERT OR IGNORE INTO payment_states(phone,data,updated_at) VALUES(?,?,?)");
      for (const [phone, state] of Object.entries(items && typeof items === "object" ? items : {})) insert.run(phone, JSON.stringify(state), new Date().toISOString());
    });
  }
  if (!settingExists("bienfaits")) importTextIfPresent("bienfaits.txt", "bienfaits");
  if (!settingExists("procedures")) importTextIfPresent("procedures.txt", "procedures");
  if (!settingExists("message_ouverture")) importTextIfPresent("message_ouverture.txt", "message_ouverture");

  setSetting("migration_v1", new Date().toISOString());
}

export function parseJson(value, fallback) { return parse(value, fallback); }
