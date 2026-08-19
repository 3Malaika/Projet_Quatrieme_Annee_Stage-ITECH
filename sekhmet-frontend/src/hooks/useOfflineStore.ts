/**
 * Cache local — délègue à db.ts (SQLite sur Android, localStorage ailleurs).
 */

import { db } from "@/lib/db";

const CACHE_PREFIX = "cache_";

export async function readCache<T>(key: string): Promise<T | null> {
  return db.get<T>(CACHE_PREFIX + key);
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  return db.set(CACHE_PREFIX + key, data);
}

export async function clearCache(key: string): Promise<void> {
  return db.remove(CACHE_PREFIX + key);
}
