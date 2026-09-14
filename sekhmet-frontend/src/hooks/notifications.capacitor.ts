import { LocalNotifications } from "@capacitor/local-notifications";
import type { NotifStatus } from "./useNotifications";

export async function requestCapacitorNotificationPermission(): Promise<NotifStatus> {
  try {
    const result = await LocalNotifications.requestPermissions();

    return result.display === "granted" ? "granted" : "denied";
  } catch (error) {
    console.error(
      "Erreur lors de la demande de permission des notifications locales :",
      error,
    );

    return "unsupported";
  }
}

export async function sendCapacitorLocalNotification(
  title: string,
  body: string,
  id: number,
): Promise<void> {
  try {
    let permission = await LocalNotifications.checkPermissions();

    if (permission.display !== "granted") {
      permission = await LocalNotifications.requestPermissions();
    }

    if (permission.display !== "granted") {
      console.warn("Notifications locales refusées par l'utilisateur.");
      return;
    }

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
      error,
    );
  }
}

export async function getCapacitorNotificationStatus(): Promise<NotifStatus> {
  try {
    const permission = await LocalNotifications.checkPermissions();

    return permission.display === "granted" ? "granted" : "denied";
  } catch (error) {
    console.error(
      "Impossible de vérifier les permissions des notifications locales :",
      error,
    );

    return "unsupported";
  }
}