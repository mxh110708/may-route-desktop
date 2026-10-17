import { BrowserWindow, app, screen } from "electron";
import type { Rectangle, WebContents } from "electron";
import { join } from "node:path";

import { developmentRendererURL } from "./development";
import { DEFAULT_TRAY_MENU_SIZE, trayMenuPlacement } from "./trayPlacement";
import type { TrayMenuSize } from "./trayPlacement";

const REOPEN_SUPPRESSION_MILLISECONDS = 250;
let menuWindow: BrowserWindow | null = null;
let menuWindowReady: Promise<void> | null = null;
let menuState: "closed" | "opening" | "open" = "closed";
let hiddenAt = 0;
let menuAnchor: Rectangle | null = null;
let contentSize = DEFAULT_TRAY_MENU_SIZE;

function ensureTrayMenuWindow(initialBounds: Rectangle): BrowserWindow {
  if (menuWindow !== null && !menuWindow.isDestroyed()) return menuWindow;
  const window = new BrowserWindow({
    ...initialBounds, show: false, frame: false, transparent: true, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, focusable: true,
    type: process.platform === "linux" ? "toolbar" : undefined,
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
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
  return trayMenuPlacement(anchor, screen.getDisplayMatching(anchor).workArea, contentSize);
}
export function prepareTrayMenuWindow(anchor: Rectangle): BrowserWindow {
  menuAnchor = anchor;
  return ensureTrayMenuWindow(placement(anchor));
}
export function resizeTrayMenu(sender: WebContents, request: unknown) {
  if (!menuWindow || menuWindow.isDestroyed() || menuWindow.webContents.id !== sender.id) throw new Error("Tray layout sender unavailable.");
  const size = request as Partial<TrayMenuSize> | null;
  if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height) ||
    size.width! < 200 || size.width! > 340 || size.height! < 80 || size.height! > 760) throw new Error("Invalid tray menu size.");
  contentSize = { width: size.width!, height: size.height! };
  if (menuAnchor) menuWindow.setBounds(placement(menuAnchor));
}
export async function showTrayMenu(anchor: Rectangle) {
  if (menuState !== "closed" || Date.now() - hiddenAt < REOPEN_SUPPRESSION_MILLISECONDS) { hideTrayMenu(); return; }
  const window = ensureTrayMenuWindow(placement(anchor));
  menuAnchor = anchor;
  menuState = "opening";
  try {
    await menuWindowReady;
    if (menuState !== "opening" || window.isDestroyed()) return;
    await window.webContents.executeJavaScript('window.dispatchEvent(new Event("tray-menu-open")); document.fonts.ready');
    // React restores the root menu and reports its measured size before showing.
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
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
  menuAnchor = null; contentSize = DEFAULT_TRAY_MENU_SIZE;
}
app.on("before-quit", destroyTrayMenuWindow);
