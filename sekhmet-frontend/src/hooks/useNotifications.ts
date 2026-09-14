import { useEffect, useState } from "react";

export type NotifStatus =
  | "unknown"
  | "granted"
  | "denied"
  | "unsupported";

const isCapacitorBuild =
  import.meta.env["VITE_PLATFORM"] === "capacitor";
  
export async function requestNotificationPermission(): Promise<NotifStatus> {
  if (typeof window === "undefined") {
    return "unsupported";
  }

  if (isCapacitorBuild) {
    const {
      requestCapacitorNotificationPermission,
    } = await import("./notifications.capacitor");

    return requestCapacitorNotificationPermission();
  }

  const {
    requestWebNotificationPermission,
  } = await import("./notifications.web");

  return requestWebNotificationPermission();
}

export async function sendLocalNotification(
  title: string,
  body: string,
  id = 1,
): Promise<void> {
  if (typeof window === "undefined") return;

  if (isCapacitorBuild) {
    const {
      sendCapacitorLocalNotification,
    } = await import("./notifications.capacitor");

    await sendCapacitorLocalNotification(title, body, id);
    return;
  }

  const {
    sendWebLocalNotification,
  } = await import("./notifications.web");

  await sendWebLocalNotification(title, body);
}

export function useNotifications() {
  const [status, setStatus] =
    useState<NotifStatus>("unknown");

  useEffect(() => {
    if (typeof window === "undefined") return;

    void (async () => {
      try {
        if (isCapacitorBuild) {
          const {
            getCapacitorNotificationStatus,
          } = await import("./notifications.capacitor");

          const permission =
            await getCapacitorNotificationStatus();

          setStatus(permission);
          return;
        }

        const {
          getWebNotificationStatus,
        } = await import("./notifications.web");

        const permission =
          await getWebNotificationStatus();

        setStatus(permission);
      } catch (error) {
        console.error(
          "Impossible de vérifier les notifications :",
          error,
        );

        setStatus("unsupported");
      }
    })();
  }, []);

  const request = async () => {
    const newStatus =
      await requestNotificationPermission();

    setStatus(newStatus);

    return newStatus;
  };

  return {
    status,
    request,
  };
}