import { useEffect, useState } from "react";

export type NotifStatus =
  | "unknown"
  | "granted"
  | "denied"
  | "unsupported";

// ---------------------------------------------------------------------------
// Détection Capacitor
// ---------------------------------------------------------------------------

async function isCapacitor(): Promise<boolean> {
  if (typeof window === "undefined") return false;

  try {
    const capacitorCoreModule = "@capacitor/core";

    const { Capacitor } = await import(
      /* @vite-ignore */ capacitorCoreModule
    );

    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Permission des notifications LOCALES
// ---------------------------------------------------------------------------

export async function requestNotificationPermission(): Promise<NotifStatus> {
  if (typeof window === "undefined") {
    return "unsupported";
  }

  // -------------------------------------------------------------------------
  // Android / Capacitor
  // -------------------------------------------------------------------------

  if (await isCapacitor()) {
    try {
      const localModule = "@capacitor/local-notifications";

      const { LocalNotifications } = await import(
        /* @vite-ignore */ localModule
      );

      const result = await LocalNotifications.requestPermissions();

      if (result.display === "granted") {
        return "granted";
      }

      return "denied";
    } catch (error) {
      console.error(
        "Erreur lors de la demande de permission des notifications locales :",
        error
      );

      return "unsupported";
    }
  }

  // -------------------------------------------------------------------------
  // Web
  // -------------------------------------------------------------------------

  if (!("Notification" in window)) {
    return "unsupported";
  }

  const perm = await Notification.requestPermission();

  if (perm === "granted") {
    new Notification("Notifications activées", {
      body: "Vous serez alertée des nouvelles escalades.",
    });
  }

  return perm as NotifStatus;
}

// ---------------------------------------------------------------------------
// Notification locale
// ---------------------------------------------------------------------------

export async function sendLocalNotification(
  title: string,
  body: string,
  id = 1
) {
  if (typeof window === "undefined") return;

  // -------------------------------------------------------------------------
  // Android / Capacitor
  // -------------------------------------------------------------------------

  if (await isCapacitor()) {
    try {
      const localModule = "@capacitor/local-notifications";

      const { LocalNotifications } = await import(
        /* @vite-ignore */ localModule
      );

      // Vérifier la permission actuelle
      let perm = await LocalNotifications.checkPermissions();

      // Si elle n'est pas accordée, la demander
      if (perm.display !== "granted") {
        perm = await LocalNotifications.requestPermissions();
      }

      if (perm.display !== "granted") {
        console.warn(
          "Notifications locales refusées par l'utilisateur."
        );
        return;
      }

      // Programmer la notification
      await LocalNotifications.schedule({
        notifications: [
          {
            id,
            title,
            body,
            schedule: {
              at: new Date(Date.now() + 500),
            },
            sound: "beep.wav",
            smallIcon: "ic_stat_icon_config_sample",
            extra: {
              source: "sekhmet-shop-admin",
            },
          },
        ],
      });

      console.log("Notification locale programmée :", {
        id,
        title,
        body,
      });
    } catch (error) {
      console.error(
        "Erreur lors de l'envoi de la notification locale :",
        error
      );
    }

    return;
  }

  // -------------------------------------------------------------------------
  // Web
  // -------------------------------------------------------------------------

  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    new Notification(title, {
      body,
    });
  }
}

// ---------------------------------------------------------------------------
// Hook React
// ---------------------------------------------------------------------------

export function useNotifications() {
  const [status, setStatus] =
    useState<NotifStatus>("unknown");

  useEffect(() => {
    if (typeof window === "undefined") return;

    void (async () => {
      // ---------------------------------------------------------------------
      // Android / Capacitor
      // ---------------------------------------------------------------------

      if (await isCapacitor()) {
        try {
          const localModule = "@capacitor/local-notifications";

          const { LocalNotifications } = await import(
            /* @vite-ignore */ localModule
          );

          const perm =
            await LocalNotifications.checkPermissions();

          setStatus(
            perm.display === "granted"
              ? "granted"
              : "denied"
          );
        } catch (error) {
          console.error(
            "Impossible de vérifier les permissions des notifications locales :",
            error
          );

          setStatus("unsupported");
        }

        return;
      }

      // ---------------------------------------------------------------------
      // Web
      // ---------------------------------------------------------------------

      if (!("Notification" in window)) {
        setStatus("unsupported");
        return;
      }

      setStatus(
        Notification.permission as NotifStatus
      );
    })();
  }, []);

  const request = async () => {
    const s = await requestNotificationPermission();

    setStatus(s);

    return s;
  };

  return {
    status,
    request,
  };
}