/**
 * Couche d'abstraction stockage local.
 *
 * - Sur Android (Capacitor) : utilise @capacitor-community/sqlite
 * - Sur Web / SSR            : fallback localStorage
 *
 * API publique :
 *   await db.init()
 *   await db.get<T>(key)
 *   await db.set(key, value)
 *   await db.remove(key)
 */

const IS_CAPACITOR =
  typeof window !== "undefined" &&
  !!(window as unknown as Record<string, unknown>)["Capacitor"];

// ---------------------------------------------------------------------------
// Implémentation localStorage (web / SSR)
// ---------------------------------------------------------------------------

const LS_PREFIX = "sekhmet_db_";

const lsImpl = {
  async init() {},
  async get<T>(key: string): Promise<T | null> {
    if (typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    } catch {
      // quota dépassé — on ignore
    }
  },
  async remove(key: string): Promise<void> {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(LS_PREFIX + key);
  },
};

// ---------------------------------------------------------------------------
// Implémentation SQLite via @capacitor-community/sqlite
// ---------------------------------------------------------------------------

let sqliteImpl: typeof lsImpl | null = null;

async function buildSqliteImpl() {
  // Import dynamique pour éviter de casser le build web
  const { CapacitorSQLite, SQLiteConnection } = await import(
    "@capacitor-community/sqlite"
  );

  const conn = new SQLiteConnection(CapacitorSQLite);
  let db: Awaited<ReturnType<typeof conn.createConnection>>;

  return {
    async init() {
      db = await conn.createConnection(
        "sekhmet_store", // nom de la base
        false,
        "no-encryption",
        1,
        false
      );
      await db.open();
      // Table clé-valeur générique
      await db.execute(`
        CREATE TABLE IF NOT EXISTS kv_store (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },

    async get<T>(key: string): Promise<T | null> {
      const res = await db.query(
        "SELECT value FROM kv_store WHERE key = ?",
        [key]
      );
      const row = res.values?.[0];
      if (!row) return null;
      try {
        return JSON.parse(row.value) as T;
      } catch {
        return null;
      }
    },

    async set(key: string, value: unknown): Promise<void> {
      await db.run(
        "INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, JSON.stringify(value)]
      );
    },

    async remove(key: string): Promise<void> {
      await db.run("DELETE FROM kv_store WHERE key = ?", [key]);
    },
  };
}

// ---------------------------------------------------------------------------
// Instance partagée
// ---------------------------------------------------------------------------

let _db: typeof lsImpl | null = null;
let _initPromise: Promise<void> | null = null;

export const db = {
  async init(): Promise<void> {
    if (_db) return;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
      if (IS_CAPACITOR) {
        try {
          sqliteImpl = await buildSqliteImpl();
          await sqliteImpl.init();
          _db = sqliteImpl;
        } catch (e) {
          console.warn("SQLite indisponible, fallback localStorage :", e);
          _db = lsImpl;
        }
      } else {
        _db = lsImpl;
      }
    })();

    return _initPromise;
  },

  async get<T>(key: string): Promise<T | null> {
    await db.init();
    return _db!.get<T>(key);
  },

  async set(key: string, value: unknown): Promise<void> {
    await db.init();
    return _db!.set(key, value);
  },

  async remove(key: string): Promise<void> {
    await db.init();
    return _db!.remove(key);
  },
};
