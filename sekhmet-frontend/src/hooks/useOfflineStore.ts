/**
 * Cache local basé sur localStorage.
 * Permet de lire les données même sans connexion réseau.
 *
 * Utilisation :
 *   const { read, write } = useOfflineStore();
 *   write("produits", data);
 *   const cached = read<Produit[]>("produits");
 */

const PREFIX = "sekhmet_cache_";

export function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, data: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(data));
  } catch {
    // localStorage plein ou indisponible — on ignore silencieusement
  }
}

export function clearCache(key: string): void {
  localStorage.removeItem(PREFIX + key);
}
