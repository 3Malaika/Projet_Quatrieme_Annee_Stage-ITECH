import { ADMIN_TOKEN, API_BASE_URL } from "@/config";
import { readCache, writeCache } from "@/hooks/useOfflineStore";

export type Produit = {
  id: string | number;
  nom: string;
  unite: string;
  prix: number | string;
  stock: "disponible" | "rupture" | string;
  categorie: string;
};

export type Category = {
  id: string;
  name: string;
};

export type Stats = {
  totalProduits: number;
  produitsEnRupture: number;
  escaladesEnAttente: number;
  escaladesCloturees: number;
  conversationsActives: number;
  clientsIdentifies: number;
};

export type Escalade = {
  id: string | number;
  from: string;
  userMessage: string;
  status: string;
  createdAt?: string | null;
  closedAt?: string | null;
};

export type ConversationSummary = {
  phone: string;
  nom: string | null;
  client_id: string | null;
  besoins: string[];
  contacts_at: string[];
  messageCount: number;
  lastMessage: string | null;
};

export type ConversationDetail = {
  phone: string;
  nom: string | null;
  client_id: string | null;
  besoins: string[];
  contacts_at: string[];
  messages: Array<{ role: "user" | "assistant"; content: string }>;
};

export const CATEGORIES = [
  "poudres",
  "farines",
  "sels",
  "graines",
  "grignotages",
  "assaisonnements",
  "produits_sales",
  "laitiers_boissons",
  "patisseries",
  "boissons_naturelles",
  "packs_amincissant",
  "pains",
  "suivi",
  "livraisons",
  "autres",
] as const;

export function labelCategorie(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isGet = !init.method || init.method === "GET";
  let res: Response;

  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    // Erreur réseau sur un GET → retourner le cache si disponible
    if (isGet) {
      const cached = await readCache<T>(path);
      if (cached !== null) return cached;
    }
    throw new ApiError(0, "Serveur injoignable. Vérifiez la connexion réseau.");
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.text();
      detail = body.slice(0, 200);
    } catch {
      /* ignore */
    }
    const messages: Record<number, string> = {
      401: "Accès refusé (401). Le token administrateur est invalide.",
      403: "Accès interdit (403).",
      404: "Ressource introuvable (404).",
      500: "Erreur serveur (500).",
    };
    throw new ApiError(res.status, messages[res.status] ?? `Erreur ${res.status}. ${detail}`);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;

  try {
    const data = JSON.parse(text) as T;
    // Mettre en cache chaque réponse GET réussie (fire-and-forget)
    if (isGet) writeCache<T>(path, data).catch(() => {});
    return data;
  } catch {
    return text as unknown as T;
  }
}

export const api = {
  get: <T,>(path: string) => apiFetch<T>(path),
  post: <T,>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T,>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T,>(path: string, body?: unknown) =>
    apiFetch<T>(path, body ? { method: "PATCH", body: JSON.stringify(body) } : { method: "PATCH" }),
  del: <T,>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
};

export function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : "Une erreur inattendue est survenue.";
}