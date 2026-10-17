import { BrowserWindow, app, screen } from "electron";
import type { Rectangle } from "electron";
import { join } from "node:path";

import { developmentRendererURL } from "./development";
import { trayMenuPlacement } from "./trayPlacement";

const REOPEN_SUPPRESSION_MILLISECONDS = 250;
let menuWindow: BrowserWindow | null = null;
let menuWindowReady: Promise<void> | null = null;
let menuState: "closed" | "opening" | "open" = "closed";
let hiddenAt = 0;

function ensureTrayMenuWindow(initialBounds: Rectangle): BrowserWindow {
  if (menuWindow !== null && !menuWindow.isDestroyed()) return menuWindow;
  const window = new BrowserWindow({
    ...initialBounds, show: false, frame: false, transparent: true, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, focusable: true,
    type: process.platform === "linux" ? "toolbar" : undefined,
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.on("blur", hideTrayMenu);
  window.on("close", (event) => { event.preventDefault(); hideTrayMenu(); });
  menuWindow = window;
  menuWindowReady = new Promise<void>((resolve, reject) => {
    window.webContents.once("did-finish-load", () => resolve());
    window.webContents.once("did-fail-load", (_event, _code, message) => reject(new Error(message)));
  });
  // The window is preloaded before the first click. Keep a load failure from
  // becoming an unhandled rejection while no show operation is awaiting it.
  void menuWindowReady.catch(() => {});
  const rendererURL = developmentRendererURL();
  const loading = rendererURL !== "" ? window.loadURL(`${rendererURL}/tray.html`) : window.loadFile(join(import.meta.dirname, "../renderer/tray.html"));
  void loading.catch((error: unknown) => {
    console.error("failed to load tray renderer", error);
    if (menuWindow === window) destroyTrayMenuWindow();
  });
  return window;
}

export function hideTrayMenu() {
  if (menuWindow === null || menuState === "closed") return;
  menuState = "closed";
  hiddenAt = Date.now();
  menuWindow.hide();
  menuWindow.setAlwaysOnTop(false);
}

function placement(anchor: Rectangle) {
  return trayMenuPlacement(anchor, screen.getDisplayMatching(anchor).workArea);
}
export function prepareTrayMenuWindow(anchor: Rectangle): BrowserWindow {
  return ensureTrayMenuWindow(placement(anchor));
}
export async function showTrayMenu(anchor: Rectangle) {
  if (menuState !== "closed" || Date.now() - hiddenAt < REOPEN_SUPPRESSION_MILLISECONDS) { hideTrayMenu(); return; }
  const window = ensureTrayMenuWindow(placement(anchor));
  menuState = "opening";
  try {
    await menuWindowReady;
    if (menuState !== "opening" || window.isDestroyed()) return;
    await window.webContents.executeJavaScript('window.dispatchEvent(new Event("tray-menu-open")); document.fonts.ready');
    if (menuState !== "opening" || window.isDestroyed()) return;
    window.setBounds(placement(anchor));
    window.setAlwaysOnTop(true, "pop-up-menu");
    window.setSkipTaskbar(true);
    menuState = "open";
    window.show();
    window.focus();
  } catch (error) { hideTrayMenu(); console.error("failed to open tray menu", error); }
}
export function destroyTrayMenuWindow() {
  menuWindow?.destroy();
  menuWindow = null; menuWindowReady = null; menuState = "closed";
}
app.on("before-quit", destroyTrayMenuWindow);
