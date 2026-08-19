/**
 * File d'attente des mutations hors ligne.
 * Stockée dans SQLite (Android) ou localStorage (web).
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { db } from "@/lib/db";

const QUEUE_KEY = "offline_queue";

export type QueueEntry = {
  id: string;
  method: "post" | "put" | "patch" | "del";
  path: string;
  body?: unknown;
  createdAt: string;
};

export async function readQueue(): Promise<QueueEntry[]> {
  return (await db.get<QueueEntry[]>(QUEUE_KEY)) ?? [];
}

async function writeQueue(entries: QueueEntry[]): Promise<void> {
  await db.set(QUEUE_KEY, entries);
}

export async function enqueue(
  entry: Omit<QueueEntry, "id" | "createdAt">
): Promise<void> {
  const queue = await readQueue();
  queue.push({
    ...entry,
    id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
  });
  await writeQueue(queue);
}

async function dequeue(id: string): Promise<void> {
  const queue = await readQueue();
  await writeQueue(queue.filter((e) => e.id !== id));
}

export function useOfflineQueue() {
  const queryClient = useQueryClient();
  const flushing = useRef(false);

  async function flushQueue() {
    if (flushing.current) return;
    const queue = await readQueue();
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
        await dequeue(entry.id);
        successCount++;
      } catch (e) {
        if (e instanceof ApiError && e.status === 0) break;
        await dequeue(entry.id);
        failCount++;
      }
    }

    flushing.current = false;

    if (successCount > 0) {
      toast.success(`${successCount} modification(s) synchronisée(s).`);
      queryClient.invalidateQueries();
    }
    if (failCount > 0) {
      toast.error(`${failCount} modification(s) n'ont pas pu être synchronisées.`);
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.addEventListener("online", flushQueue);
    if (navigator.onLine) flushQueue();
    return () => window.removeEventListener("online", flushQueue);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
