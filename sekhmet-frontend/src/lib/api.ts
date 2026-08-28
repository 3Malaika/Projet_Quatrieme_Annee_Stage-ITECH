import { ADMIN_TOKEN, API_BASE_URL } from "@/config";
import { readCache, writeCache } from "@/hooks/useOfflineStore";

export type Produit = {
  id: string | number;
  nom: string;
  unite: string;
  prix: number | string;
  stock: "disponible" | "rupture" | string;
  categorie: string;
  description?: string;
  imageUrl?: string;
  quantite?: number;
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
  appelsAujourdHui: number;
  tokensAujourdHui: number;
  appelsCeMois: number;
  tokensCeMois: number;
  tokensTotal: number;
  coutEstimeAujourdHui: number;
  coutEstimeCeMois: number;
  coutEstimeTotal: number;
  coutParModeleCeMois: Record<string, number>;
  suiviDisponible: boolean;
};

export type AchatAgg = {
  key: string | number;
  label?: string;
  orders: number;
  revenue: number;
  units: number;
};

export type AchatStats = {
  filters: {
    from: string;
    to: string;
    product: string | null;
    category: string | null;
    status: string[];
    hourFrom: number | null;
    hourTo: number | null;
  };
  kpis: {
    revenue: number;
    orders: number;
    units: number;
    averageOrderValue: number;
    uniqueCustomers: number;
    detailedOrders: number;
    undetailedOrders: number;
  };
  daily: AchatAgg[];
  monthly: AchatAgg[];
  byProduct: AchatAgg[];
  byCategory: AchatAgg[];
  byHour: Array<{ hour: number; orders: number; revenue: number; units: number }>;
  byDayPart: Array<{ key: string; label: string; orders: number; revenue: number; units: number }>;
  byWeekday: Array<{ weekday: string; orders: number; revenue: number; units: number }>;
  options: {
    products: Array<{ id: string; nom: string; categorie: string }>;
    categories: string[];
    statuses: string[];
  };
};

export type LogImportant = {
  id: string;
  source: string;
  level: string;
  context?: string;
  message: string;
  detail?: string | null;
  createdAt: string;
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
  besoin: string | null;
  messageCount: number;
  lastMessage: string | null;
};

export type ConversationDetail = {
  phone: string;
  nom: string | null;
  besoin: string | null;
  besoinsHistorique?: Array<{ besoin: string; date: string | null }>;
  messages: Array<{ role: "user" | "assistant"; content: string; timestamp?: string }>;
};

export type Commande = {
  id: string;
  phone: string;
  nom_client: string | null;
  produits: string;
  // JSON structuré (stringifié) des choix de quantité faits par le client
  // via la liste interactive WhatsApp avant la confirmation du paiement :
  // [{ produitId, nom, quantite, prixUnitaire, total }]. Null si la
  // commande a été créée sans sélection préalable (description tapée à
  // la main par le collaborateur).
  produits_detail?: string | null;
  montant_total: number;
  compte_mobile_money: string | null;
  delai_livraison: string | null;
  statut: "paiement_confirme" | "facturee" | string;
  numero_facture: string | null;
  created_at: string;
};

// Téléchargement du PDF de facture : nécessite le header d'auth, donc pas
// un simple lien <a href> — on récupère le blob puis on l'ouvre.
export async function fetchFacturePdfBlob(id: string | number): Promise<Blob> {
  const res = await fetch(`${API_BASE_URL}/api/commandes/${id}/facture.pdf`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (!res.ok) {
    throw new ApiError(res.status, `Impossible de récupérer la facture (${res.status}).`);
  }
  return res.blob();
}

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
      detail = body.slice(0, 300);
    } catch {
      /* ignore */
    }

    // Le backend renvoie souvent { "error": "..." } avec le vrai motif de
    // l'échec (ex: message Supabase pour une 500) — on l'utilise plutôt que
    // d'écraser systématiquement par un message générique, sinon impossible
    // de diagnostiquer une erreur serveur depuis l'interface.
    let apiMessage = "";
    try {
      const parsed = JSON.parse(detail);
      apiMessage = typeof parsed?.error === "string" ? parsed.error : "";
    } catch {
      /* le corps n'est pas du JSON exploitable */
    }

    const messages: Record<number, string> = {
      401: "Accès refusé (401). Le token administrateur est invalide.",
      403: "Accès interdit (403).",
      404: "Ressource introuvable (404).",
    };
    throw new ApiError(
      res.status,
      messages[res.status] ?? apiMessage ?? `Erreur ${res.status}. ${detail}`,
    );
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

// Upload d'une photo produit : multipart/form-data, donc on ne passe pas
// par apiFetch (qui force Content-Type: application/json) — le navigateur
// doit fixer lui-même le Content-Type avec la boundary du FormData.
export async function uploadProduitImage(file: File): Promise<{ url: string }> {
  const formData = new FormData();
  formData.append("image", file);

  const res = await fetch(`${API_BASE_URL}/api/upload/produit-image`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: formData,
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error || "";
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail || `Échec de l'upload (${res.status}).`);
  }

  return res.json();
}

// Supprime la photo d'un produit (fichier Supabase Storage inclus côté
// backend) sans toucher au reste de ses informations.
export function deleteProduitImage(id: string | number) {
  return apiFetch<Produit>(`/api/produits/${id}/image`, { method: "DELETE" });
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