/**
 * Notifications push natives via @capacitor/push-notifications.
 * Sur Android → notifications système vraies.
 * Sur web → fallback sur l'API Notification du navigateur.
 */

import { useEffect, useState } from "react";

export type NotifStatus = "unknown" | "granted" | "denied" | "unsupported";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isCapacitor(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const { Capacitor } = await import("@capacitor/core");
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/**
 * Demande la permission et retourne le statut.
 * Envoie une notification de bienvenue si accordée.
 */
export async function requestNotificationPermission(): Promise<NotifStatus> {
  if (typeof window === "undefined") return "unsupported";

  if (await isCapacitor()) {
    try {
      const { PushNotifications } = await import("@capacitor/push-notifications");
      const result = await PushNotifications.requestPermissions();
      if (result.receive === "granted") {
        await PushNotifications.register();
        return "granted";
      }
      return "denied";
    } catch {
      return "unsupported";
    }
  }

  // Fallback web
  if (!("Notification" in window)) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm === "granted") {
    new Notification("Notifications activées", {
      body: "Vous serez alertée des nouvelles escalades.",
    });
  }
  return perm as NotifStatus;
}

/**
 * Envoie une notification locale (pas besoin de serveur push).
 * Fonctionne hors ligne.
 */
export async function sendLocalNotification(title: string, body: string, id = 1) {
  if (typeof window === "undefined") return;

  if (await isCapacitor()) {
    try {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      const perm = await LocalNotifications.requestPermissions();
      if (perm.display !== "granted") return;
      await LocalNotifications.schedule({
        notifications: [{ title, body, id, schedule: { at: new Date(Date.now() + 100) } }],
      });
    } catch {
      /* ignore */
    }
    return;
  }

  // Fallback web
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

// ---------------------------------------------------------------------------
// Hook React
// ---------------------------------------------------------------------------

export function useNotifications() {
  const [status, setStatus] = useState<NotifStatus>("unknown");

  useEffect(() => {
    if (typeof window === "undefined") return;

    void (async () => {
      if (await isCapacitor()) {
        try {
          const { PushNotifications } = await import("@capacitor/push-notifications");
          const perm = await PushNotifications.checkPermissions();
          setStatus(perm.receive === "granted" ? "granted" : "denied");
        } catch {
          setStatus("unsupported");
        }
      } else {
        if (!("Notification" in window)) { setStatus("unsupported"); return; }
        setStatus(Notification.permission as NotifStatus);
      }
    })();
  }, []);

  const request = async () => {
    const s = await requestNotificationPermission();
    setStatus(s);
    return s;
  };

  return { status, request };
}
