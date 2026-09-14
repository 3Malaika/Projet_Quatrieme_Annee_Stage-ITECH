import type { NotifStatus } from "./useNotifications";

export async function requestWebNotificationPermission(): Promise<NotifStatus> {
  if (typeof window === "undefined") {
    return "unsupported";
  }

  if (!("Notification" in window)) {
    return "unsupported";
  }

  const permission = await Notification.requestPermission();

  if (permission === "granted") {
    new Notification("Notifications activées", {
      body: "Vous serez alertée des nouvelles escalades.",
    });
  }

  return permission as NotifStatus;
}

export async function sendWebLocalNotification(
  title: string,
  body: string,
): Promise<void> {
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    new Notification(title, { body });
  }
}

export async function getWebNotificationStatus(): Promise<NotifStatus> {
  if (typeof window === "undefined") {
    return "unsupported";
  }

  if (!("Notification" in window)) {
    return "unsupported";
  }

  return Notification.permission as NotifStatus;
}