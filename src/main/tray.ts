import { Menu, Tray, app, dialog, nativeImage, nativeTheme, screen, shell } from "electron";
import type { MenuItemConstructorOptions, NativeImage, Rectangle } from "electron";

import { ServiceStatus_Type } from "../shared/gen/daemon/started_service_pb";
import { desktopLanguageFromLocale, translateDesktop } from "../shared/translations";
import type { DesktopMessageKey } from "../shared/translations";
import { startedService } from "./daemon";
import { preferredLocale } from "./locale";
import { onPreferenceChanged } from "./preferences";
import { onProfilesChanged, profilesState, selectProfile, setCaptureMode, startSelectedProfile, stopSelectedService, updateRemoteProfile } from "./profiles";
import { preferenceSnapshot } from "./database";
import { resourcePath } from "./resources";
import { daemonState } from "./state";
import { destroyTrayMenuWindow, hideTrayMenu, prepareTrayMenuWindow, showTrayMenu } from "./trayMenu";
import type { X11Tray } from "./x11Tray";
import { bindWindowsTrayActivation } from "./windowsTrayActivation";
import { buildWindowsTrayMenu } from "./windowsTrayMenu";
import { trayMenuPlacement } from "./trayPlacement";

const DOUBLE_ACTIVATE_INTERVAL_MILLISECONDS = 500;
const APPLICATION_LABEL = __CUSTOM_BUILD__ ? "MXH Route" : "sing-box";

let tray: Tray | null = null;
let x11Tray: X11Tray | null = null;
let x11TrayPending = false;
let trayGeneration = 0;
let openWindow: (route?: string) => void = () => {};
let windowsMenu: Menu | null = null;
let windowsActionRunning = false;

function closeWindowsMenu() {
  windowsMenu?.closePopup();
  if (process.platform === "win32" && tray && !tray.isDestroyed()) tray.closeContextMenu();
  windowsMenu = null;
}

async function runWindowsAction(action: () => Promise<unknown>) {
  if (windowsActionRunning) return;
  windowsActionRunning = true;
  try { await action(); }
  catch (error) {
    console.error("tray action:", error);
    await dialog.showMessageBox({ type: "error", title: APPLICATION_LABEL, message: error instanceof Error ? error.message : String(error), buttons: ["OK"], noLink: true }).catch(console.error);
  } finally { windowsActionRunning = false; }
}

function requireStartedService() {
  if (!startedService || daemonState.connection.phase !== "connected" || daemonState.status !== ServiceStatus_Type.STARTED) throw new Error("Service is not running.");
  return startedService;
}

function showWindowsMenu(bounds: Rectangle) {
  if (!tray) return;
  closeWindowsMenu();
  const status = daemonState.status;
  const state = profilesState();
  const menu = Menu.buildFromTemplate(buildWindowsTrayMenu({
    ...state, connected: daemonState.connection.phase === "connected", busy: windowsActionRunning,
    status: status === ServiceStatus_Type.STARTED ? "started" : status === ServiceStatus_Type.STARTING ? "starting" : status === ServiceStatus_Type.STOPPING ? "stopping" : "stopped",
    groups: daemonState.groups, routing: daemonState.routing,
  }, {
    openMain: (route) => openWindow(route),
    start: () => { void runWindowsAction(startSelectedProfile); },
    stop: () => { void runWindowsAction(stopSelectedService); },
    capture: (mode) => { void runWindowsAction(() => setCaptureMode(mode)); },
    routing: (mode) => { void runWindowsAction(() => requireStartedService().setClashMode({ mode })); },
    selectProfile: (id) => { void runWindowsAction(() => selectProfile(id)); },
    updateProfile: (id) => { void runWindowsAction(() => updateRemoteProfile(id)); },
    selectOutbound: (group, node) => { void runWindowsAction(() => requireStartedService().selectOutbound({ groupTag: group, outboundTag: node })); },
    urlTest: (group) => { void runWindowsAction(() => requireStartedService().uRLTest({ outboundTag: group })); },
    urlTestAll: () => { void runWindowsAction(() => Promise.all(daemonState.groups.filter((group) => group.selectable).map((group) => requireStartedService().uRLTest({ outboundTag: group.tag })))); },
    closeConnections: () => { void runWindowsAction(() => requireStartedService().closeAllConnections({})); },
    openDataDirectory: () => { void runWindowsAction(async () => { const error = await shell.openPath(app.getPath("userData")); if (error) throw new Error(error); }); },
    quit: () => app.quit(),
  }, translate));
  windowsMenu = menu;
  menu.once("menu-will-close", () => { if (windowsMenu === menu) windowsMenu = null; });
  // A conservative native-menu footprint keeps the initial popup outside the
  // triggering icon. Native submenus handle their own screen-edge placement.
  const height = menu.items.reduce((sum, item) => sum + (item.type === "separator" ? 8 : 28), 12);
  const position = trayMenuPlacement(bounds, screen.getDisplayMatching(bounds).workArea, { width: 244, height });
  tray.popUpContextMenu(menu, { x: position.x, y: position.y });
}

function syncWindowsMenuTheme() {
  const theme = preferenceSnapshot(["theme"]).theme;
  nativeTheme.themeSource = theme === "dark" || theme === "light" ? theme : "system";
}

function cursorAnchor(): Rectangle {
  const cursor = screen.getCursorScreenPoint();
  return { x: cursor.x, y: cursor.y, width: 0, height: 0 };
}

// Plasma's system tray sends the icon position, not the cursor position, in
// ContextMenu/Activate/SecondaryActivate, and it does so in Wayland sessions
// too — where the cursor position read through XWayland is stale. On X11 the
// coordinates are device pixels while Chromium's screen space is DIPs; in
// Wayland sessions plasmashell sends logical coordinates, which match
// Chromium's DIP space in both XWayland scaling modes. Other SNI hosts send
// (0, 0) or coordinates outside any display.
function clickAnchor(clickX: number, clickY: number): Rectangle {
  let x = clickX;
  let y = clickY;
  if (process.env.XDG_SESSION_TYPE?.toLowerCase() !== "wayland") {
    const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
    x = Math.round(x / scaleFactor);
    y = Math.round(y / scaleFactor);
  }
  const insideDisplay = screen.getAllDisplays().some((display) => {
    const bounds = display.bounds;
    return (
      x >= bounds.x &&
      x < bounds.x + bounds.width &&
      y >= bounds.y &&
      y < bounds.y + bounds.height
    );
  });
  if ((clickX === 0 && clickY === 0) || !insideDisplay) {
    return cursorAnchor();
  }
  return { x, y, width: 0, height: 0 };
}

function translate(key: DesktopMessageKey): string {
  return translateDesktop(desktopLanguageFromLocale(preferredLocale()), key);
}

function ignoreErrors(promise: Promise<unknown> | undefined) {
  void promise?.catch((error) => {
    console.error("tray action:", error);
  });
}

function groupsSubmenu(): MenuItemConstructorOptions[] {
  const selectableGroups = daemonState.groups.filter((group) => group.selectable);
  const items: MenuItemConstructorOptions[] = [
    {
      label: translate("URLTest All"),
      click: () => {
        for (const group of selectableGroups) {
          ignoreErrors(startedService?.uRLTest({ outboundTag: group.tag }));
        }
      },
    },
    {
      label: translate("Close All Connections"),
      click: () => ignoreErrors(startedService?.closeAllConnections({})),
    },
    { type: "separator" },
  ];
  for (const group of selectableGroups) {
    items.push({
      label: group.tag,
      submenu: [
        {
          label: translate("URLTest"),
          click: () => ignoreErrors(startedService?.uRLTest({ outboundTag: group.tag })),
        },
        { type: "separator" },
        ...group.items.map((item) => ({
          label: item.urlTestDelay > 0 ? `${item.tag} (${item.urlTestDelay}ms)` : item.tag,
          type: "radio" as const,
          checked: item.tag === group.selected,
          click: () =>
            ignoreErrors(
              startedService?.selectOutbound({ groupTag: group.tag, outboundTag: item.tag }),
            ),
        })),
      ],
    });
  }
  return items;
}

function buildTrayTemplate(): MenuItemConstructorOptions[] {
  const started = daemonState.status === ServiceStatus_Type.STARTED;
  const { selectedId, profiles } = profilesState();
  const template: MenuItemConstructorOptions[] = [{ label: APPLICATION_LABEL, enabled: false }];
  if (started) {
    template.push({
      label: translate("Stop"),
      click: () => ignoreErrors(stopSelectedService()),
    });
  } else {
    template.push({
      label: translate("Start"),
      enabled: daemonState.connection.phase === "connected",
      click: () => ignoreErrors(startSelectedProfile()),
    });
  }
  template.push({ type: "separator" });
  if (started && daemonState.groups.some((group) => group.selectable)) {
    template.push({ label: translate("Group"), submenu: groupsSubmenu() });
  }
  template.push({
    label: translate("Profiles"),
    submenu:
      profiles.length === 0
        ? [{ label: translate("No profiles"), enabled: false }]
        : profiles.map((profile) => ({
            label: profile.name,
            type: "radio" as const,
            checked: profile.id === selectedId,
            click: () => ignoreErrors(selectProfile(profile.id)),
          })),
  });
  template.push({ type: "separator" });
  template.push({ label: translate("Open"), click: () => openWindow() });
  template.push({ label: translate("Quit"), click: () => app.quit() });
  return template;
}

export function rebuildTrayMenu() {
  // Keep the Windows menu manual: attaching it with setContextMenu would
  // suppress the independent primary-click activation.
  if (tray === null || process.platform === "win32") {
    return;
  }
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate()));
}

export function initializeTray(open: (route?: string) => void) {
  openWindow = open;
  if (process.platform === "win32") {
    syncWindowsMenuTheme();
    onProfilesChanged(closeWindowsMenu);
    daemonState.on("connection", closeWindowsMenu);
    let previousStatus = daemonState.status;
    daemonState.on("change", () => {
      if (previousStatus !== daemonState.status) {
        previousStatus = daemonState.status;
        closeWindowsMenu();
      }
    });
    onPreferenceChanged((name) => {
      if (name === "theme") syncWindowsMenuTheme();
      if (name === "theme" || name === "language") closeWindowsMenu();
    });
  } else {
    daemonState.on("change", rebuildTrayMenu);
    onProfilesChanged(rebuildTrayMenu);
    onPreferenceChanged((name) => {
      if (name === "language") {
        rebuildTrayMenu();
      }
    });
  }
  daemonState.start();
}

function createElectronTray() {
  let icon: NativeImage;
  if (process.platform === "darwin") {
    icon = nativeImage.createFromPath(resourcePath("trayTemplate.png"));
    icon.setTemplateImage(true);
  } else {
    icon = nativeImage.createFromPath(
      resourcePath(process.platform === "win32" ? "tray.ico" : "tray.png"),
    );
  }
  tray = new Tray(icon);
  tray.setToolTip(APPLICATION_LABEL);
  if (process.platform === "win32") {
    bindWindowsTrayActivation(tray, {
      hideMenu: () => { closeWindowsMenu(); hideTrayMenu(); },
      openMainWindow: () => openWindow(),
      showMenu: showWindowsMenu,
    });
    return;
  }
  rebuildTrayMenu();
}

export function updateTrayVisibility(enabled: boolean) {
  if (!enabled) {
    trayGeneration++;
    x11TrayPending = false;
    closeWindowsMenu();
    tray?.destroy();
    tray = null;
    x11Tray?.destroy();
    x11Tray = null;
    destroyTrayMenuWindow();
    return;
  }
  if (tray !== null || x11Tray !== null || x11TrayPending) {
    return;
  }
  // Electron resolves the ozone platform before the main script runs and
  // appends the result to its command line, so the switch value reports the
  // platform actually in use even when nothing was passed.
  if (process.platform !== "linux" || app.commandLine.getSwitchValue("ozone-platform") !== "x11") {
    createElectronTray();
    return;
  }
  x11TrayPending = true;
  void createX11Tray(++trayGeneration);
}

async function createX11Tray(generation: number): Promise<void> {
  let currentTray: X11Tray | null = null;
  try {
    // Loading dbus-next on Windows retains an unused Linux protocol stack.
    const { X11Tray } = await import("./x11Tray");
    if (generation !== trayGeneration) return;
    prepareTrayMenuWindow(cursorAnchor());
    const popMenu = (x: number, y: number) => {
      void showTrayMenu(clickAnchor(x, y));
    };
    let lastActivateAt = 0;
    currentTray = new X11Tray(popMenu, (x, y) => {
      const now = Date.now();
      if (now - lastActivateAt < DOUBLE_ACTIVATE_INTERVAL_MILLISECONDS) {
        lastActivateAt = 0;
        hideTrayMenu();
        openWindow();
        return;
      }
      lastActivateAt = now;
      popMenu(x, y);
    });
    x11Tray = currentTray;
    await currentTray.ready;
  } catch (error: unknown) {
    if (generation !== trayGeneration) return;
    console.error("failed to create X11 tray:", error);
    currentTray?.destroy();
    x11Tray = null;
    destroyTrayMenuWindow();
    createElectronTray();
  } finally {
    if (generation === trayGeneration) x11TrayPending = false;
  }
}
