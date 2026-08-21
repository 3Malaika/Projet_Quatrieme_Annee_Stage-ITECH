/**
 * Retourne true si le navigateur est en ligne, false sinon.
 * Se met à jour automatiquement sur les événements online/offline.
 */

import { useEffect, useState } from "react";

export function useOnlineStatus(): boolean {
  // Keep the first render identical between SSR and the browser. Reading
  // navigator.onLine in the initializer can make OfflineBanner appear only
  // on the client and abort hydration when the device is offline.
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsOnline(window.navigator.onLine);
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return isOnline;
}
