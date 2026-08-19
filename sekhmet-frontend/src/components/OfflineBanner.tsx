/**
 * Bannière affichée en haut de l'écran quand l'appareil est hors ligne.
 * Indique aussi combien de modifications sont en attente de synchronisation.
 */

import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { readQueue } from "@/hooks/useOfflineQueue";

export function OfflineBanner() {
  const isOnline = useOnlineStatus();
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    // Recompte la queue à chaque changement de statut réseau
    setPendingCount(readQueue().length);
  }, [isOnline]);

  if (isOnline) return null;

  return (
    <div className="flex items-center gap-2 bg-amber-500 px-4 py-2 text-sm font-medium text-white">
      <WifiOff className="size-4 shrink-0" />
      <span>
        Mode hors ligne — données en cache.
        {pendingCount > 0 && (
          <span className="ml-1">
            {pendingCount} modification{pendingCount > 1 ? "s" : ""} en attente de synchronisation.
          </span>
        )}
      </span>
    </div>
  );
}
