import type { MenuItemConstructorOptions } from "electron";

import type { DesktopMessageKey } from "../shared/translations";
import type { CaptureMode } from "../shared/ipc";

export interface WindowsTraySnapshot {
  connected: boolean;
  status: "started" | "stopped" | "starting" | "stopping";
  busy: boolean;
  captureMode: CaptureMode;
  selectedId: string | null;
  profiles: ReadonlyArray<{ id: string; name: string; type: "local" | "remote" }>;
  routing: { modeList: readonly string[]; currentMode: string };
  groups: ReadonlyArray<{ tag: string; selected: string; selectable: boolean; items: ReadonlyArray<{ tag: string; urlTestDelay: number }> }>;
}

export interface WindowsTrayActions {
  openMain(route?: string): void;
  start(): void;
  stop(): void;
  capture(mode: CaptureMode): void;
  routing(mode: string): void;
  selectProfile(id: string): void;
  updateProfile(id: string): void;
  selectOutbound(group: string, node: string): void;
  urlTest(group: string): void;
  urlTestAll(): void;
  closeConnections(): void;
  openDataDirectory(): void;
  quit(): void;
}

const literal = (value: string) => value.replaceAll("&", "&&");

// Every parent is a native submenu. Hover, crossing between menus, edge flipping
// and keyboard traversal belong to Electron's platform menu, not renderer pages.
export function buildWindowsTrayMenu(state: WindowsTraySnapshot, actions: WindowsTrayActions, t: (key: DesktopMessageKey) => string): MenuItemConstructorOptions[] {
  const locked = state.busy || state.status === "starting" || state.status === "stopping";
  const running = state.connected && state.status === "started";
  const operate = running && !locked;
  const choose = state.connected && !locked;
  const separator = (): MenuItemConstructorOptions => ({ type: "separator" });
  const unavailable = (): MenuItemConstructorOptions[] => [{ label: t("Unavailable"), enabled: false }];
  const modeName = (mode: string) => mode.toLowerCase() === "rule" ? t("Rule") : mode.toLowerCase() === "global" ? t("Global") : mode.toLowerCase() === "direct" ? t("Direct") : literal(mode);
  const groups = state.groups.filter((group) => group.selectable);
  const groupItems: MenuItemConstructorOptions[] = [
    { id: "test-all", label: t("URLTest All"), enabled: operate, click: () => actions.urlTestAll() }, separator(),
    ...groups.map((group): MenuItemConstructorOptions => ({
      id: `group:${group.tag}`, label: literal(group.tag), type: "submenu", enabled: operate,
      submenu: [
        { label: t("URLTest"), enabled: operate, click: () => actions.urlTest(group.tag) }, separator(),
        ...group.items.map((node): MenuItemConstructorOptions => ({
          id: `node:${group.tag}:${node.tag}`, label: literal(node.urlTestDelay > 0 ? `${node.tag} (${node.urlTestDelay}ms)` : node.tag),
          type: "radio", checked: node.tag === group.selected, enabled: operate,
          click: () => { if (node.tag !== group.selected) actions.selectOutbound(group.tag, node.tag); },
        })),
      ],
    })),
  ];
  const profileItems: MenuItemConstructorOptions[] = state.profiles.map((profile) => ({
    id: `profile:${profile.id}`, label: literal(profile.name), type: "radio", checked: profile.id === state.selectedId, enabled: choose,
    click: () => { if (profile.id !== state.selectedId) actions.selectProfile(profile.id); },
  }));
  const remote = state.profiles.filter((profile) => profile.type === "remote");
  if (remote.length) profileItems.push(separator(), {
    id: "update-profiles", label: t("Update"), type: "submenu", enabled: choose,
    submenu: remote.map((profile) => ({ id: `update:${profile.id}`, label: literal(profile.name), enabled: choose, click: () => actions.updateProfile(profile.id) })),
  });
  const currentMode = running && state.routing.currentMode ? ` (${modeName(state.routing.currentMode)})` : "";
  return [
    { id: "open-main", label: t("Open"), click: () => actions.openMain() },
    { id: "service", label: state.status === "starting" ? t("Service starting...") : state.status === "stopping" ? t("Service stopping...") : state.status === "started" ? t("Stop Service") : t("Start Service"), enabled: choose && (state.status === "started" || state.selectedId !== null), click: () => state.status === "started" ? actions.stop() : actions.start() },
    separator(),
    { id: "routing", label: t("Routing Mode") + currentMode, type: "submenu", enabled: operate && state.routing.modeList.length > 0,
      submenu: state.routing.modeList.length ? state.routing.modeList.map((mode) => ({ id: `mode:${mode}`, label: modeName(mode), type: "radio", checked: mode === state.routing.currentMode, enabled: operate, click: () => { if (mode !== state.routing.currentMode) actions.routing(mode); } })) : unavailable() },
    { id: "groups", label: t("Group"), type: "submenu", enabled: operate && groups.length > 0, submenu: groups.length ? groupItems : unavailable() },
    { id: "profiles", label: t("Profiles"), type: "submenu", enabled: !locked, submenu: profileItems.length ? profileItems : [{ label: t("No profiles"), enabled: false }] },
    separator(),
    { id: "system-proxy", label: t("System Proxy"), type: "radio", checked: state.captureMode === "system-proxy", enabled: choose, click: () => { if (state.captureMode !== "system-proxy") actions.capture("system-proxy"); } },
    { id: "tun", label: t("TUN Mode"), type: "radio", checked: state.captureMode === "tun", enabled: choose, click: () => { if (state.captureMode !== "tun") actions.capture("tun"); } },
    separator(),
    { id: "reload", label: t("Reload profile"), enabled: operate && state.selectedId !== null, click: () => actions.start() },
    { id: "more", label: t("More"), type: "submenu", submenu: [
      { id: "connections", label: t("Connections"), click: () => actions.openMain("connections") },
      { id: "logs", label: t("Logs"), click: () => actions.openMain("logs") },
      { id: "settings", label: t("Settings"), click: () => actions.openMain("settings") },
      { id: "data-directory", label: t("Open data directory"), enabled: !locked, click: () => actions.openDataDirectory() },
      separator(),
      { id: "close-connections", label: t("Close All Connections"), enabled: operate, click: () => actions.closeConnections() },
    ] },
    separator(),
    { id: "quit", label: t("Quit"), enabled: !locked, click: () => actions.quit() },
  ];
}
