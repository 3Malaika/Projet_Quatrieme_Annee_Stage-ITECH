/**
 * File d'attente des mutations hors ligne.
 *
 * Quand une mutation échoue pour cause de réseau (ApiError status 0),
 * elle est empilée dans localStorage. Dès que la connexion revient,
 * le hook rejoue automatiquement toutes les mutations en attente.
 *
 * Format d'une entrée :
 *   { id, method, path, body, createdAt }
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";

const QUEUE_KEY = "sekhmet_offline_queue";

export type QueueEntry = {
  id: string;
  method: "post" | "put" | "patch" | "del";
  path: string;
  body?: unknown;
  createdAt: string;
};

export function readQueue(): QueueEntry[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function writeQueue(entries: QueueEntry[]): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(entries));
}

export function enqueue(entry: Omit<QueueEntry, "id" | "createdAt">): void {
  const queue = readQueue();
  queue.push({
    ...entry,
    id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
  });
  writeQueue(queue);
}

function dequeue(id: string): void {
  writeQueue(readQueue().filter((e) => e.id !== id));
}

/**
 * Hook à monter une seule fois (dans le layout racine).
 * Il surveille la reconnexion et rejoue la queue.
 */
export function useOfflineQueue() {
  const queryClient = useQueryClient();
  const flushing = useRef(false);

  async function flushQueue() {
    if (flushing.current) return;
    const queue = readQueue();
    if (queue.length === 0) return;

    flushing.current = true;
    let successCount = 0;
    let failCount = 0;

    for (const entry of queue) {
      try {
        if (entry.method === "del") {
          await api.del(entry.path);
        } else {
          await api[entry.method](entry.path, entry.body);
        }
        dequeue(entry.id);
        successCount++;
      } catch (e) {
        // Si c'est encore une erreur réseau, on arrête — on réessaiera plus tard
        if (e instanceof ApiError && e.status === 0) break;
        // Erreur applicative (404, 400…) : on retire quand même de la queue
        // pour éviter une boucle infinie
        dequeue(entry.id);
        failCount++;
      }
    }

    flushing.current = false;

    if (successCount > 0) {
      toast.success(`${successCount} modification(s) synchronisée(s).`);
      // Invalide tous les caches React Query pour rafraîchir les données
      queryClient.invalidateQueries();
    }
    if (failCount > 0) {
      toast.error(`${failCount} modification(s) n'ont pas pu être synchronisées.`);
    }
  }

  useEffect(() => {
    // Rejoue la queue dès que la connexion revient
    window.addEventListener("online", flushQueue);
    // Rejoue aussi au montage si on était déjà en ligne (rechargement de page)
    if (navigator.onLine) flushQueue();

    return () => window.removeEventListener("online", flushQueue);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
