import { Notification } from "electron";

import type {
  NotificationCancel,
  Notification as NotificationMessage,
} from "../shared/gen/daemon/started_service_pb";
import { startedService } from "./daemon";
import { daemonState } from "./state";

const RECONNECT_DELAY = 3000;

const shown = new Map<string, Notification>();
let systemProxyWarning: Notification | null = null;

export function dismissSystemProxyRecoveryWarning(): void {
  const notification = systemProxyWarning;
  systemProxyWarning = null;
  notification?.close();
}

export function showSystemProxyRecoveryWarning(): void {
  if (!Notification.isSupported()) return;
  dismissSystemProxyRecoveryWarning();
  const notification = new Notification({
    title: "May Route 正在保持系统代理",
    body: "Windows 系统代理设置持续被改动，Route 将继续按间隔恢复。需要使用其他代理程序时，请先关闭 Route 的代理总开关。",
  });
  systemProxyWarning = notification;
  notification.on("close", () => {
    if (systemProxyWarning === notification) systemProxyWarning = null;
  });
  notification.show();
}

function notificationKey(typeID: number, identifier: string): string {
  return `${typeID}/${identifier}`;
}

function showNotification(message: NotificationMessage, open: (openURL: string) => void) {
  const key = notificationKey(message.typeID, message.identifier);
  shown.get(key)?.close();
  const notification = new Notification({
    title: message.title,
    subtitle: message.subtitle,
    body: message.body,
  });
  notification.on("click", () => {
    if (message.openURL !== "") {
      open(message.openURL);
    }
  });
  notification.on("close", () => {
    if (shown.get(key) === notification) {
      shown.delete(key);
    }
  });
  shown.set(key, notification);
  notification.show();
}

function cancelNotification(message: NotificationCancel) {
  const key = notificationKey(message.typeID, message.identifier);
  const notification = shown.get(key);
  if (notification === undefined) {
    return;
  }
  shown.delete(key);
  notification.close();
}

async function loopNotifications(signal: AbortSignal, open: (openURL: string) => void) {
  while (!signal.aborted) {
    try {
      for await (const event of startedService!.subscribeNotifications({}, { signal })) {
        switch (event.event.case) {
          case "send":
            showNotification(event.event.value, open);
            break;
          case "cancel":
            cancelNotification(event.event.value);
            break;
        }
      }
    } catch {}
    if (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY));
    }
  }
}

export function registerNotifications(open: (openURL: string) => void) {
  if (!Notification.isSupported() || startedService === null) {
    return;
  }
  daemonState.on("session", (signal: AbortSignal) => {
    void loopNotifications(signal, open);
  });
}
