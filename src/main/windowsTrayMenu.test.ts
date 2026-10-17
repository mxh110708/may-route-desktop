import assert from "node:assert/strict";
import test from "node:test";
import type { MenuItemConstructorOptions } from "electron";

import { buildWindowsTrayMenu } from "./windowsTrayMenu";
import type { WindowsTrayActions, WindowsTraySnapshot } from "./windowsTrayMenu";

function fixture() {
  const calls: unknown[][] = [];
  const actions: WindowsTrayActions = {
    openMain: (route) => { calls.push(["open", route]); }, start: () => { calls.push(["start"]); }, stop: () => { calls.push(["stop"]); },
    capture: (mode) => { calls.push(["capture", mode]); }, routing: (mode) => { calls.push(["routing", mode]); },
    selectProfile: (id) => { calls.push(["profile", id]); }, updateProfile: (id) => { calls.push(["update", id]); },
    selectOutbound: (group, node) => { calls.push(["node", group, node]); }, urlTest: (group) => { calls.push(["test", group]); },
    urlTestAll: () => { calls.push(["test-all"]); }, closeConnections: () => { calls.push(["close-all"]); },
    openDataDirectory: () => { calls.push(["directory"]); }, quit: () => { calls.push(["quit"]); },
  };
  const state: WindowsTraySnapshot = {
    connected: true, status: "started", busy: false, captureMode: "system-proxy", selectedId: "one",
    profiles: [{ id: "one", name: "Local & A", type: "local" }, { id: "two", name: "Remote B", type: "remote" }],
    routing: { modeList: ["rule", "global", "direct"], currentMode: "rule" },
    groups: [{ tag: "Entry & Exit", selected: "A", selectable: true, items: [{ tag: "A", urlTestDelay: 50 }, { tag: "B & C", urlTestDelay: 70 }] }],
  };
  return { state, calls, build: () => buildWindowsTrayMenu(state, actions, (key) => key) };
}

function all(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? all(item.submenu) : [])]);
}
function find(items: MenuItemConstructorOptions[], id: string) {
  const item = all(items).find((value) => value.id === id);
  assert.ok(item, id);
  return item;
}
function click(item: MenuItemConstructorOptions) { item.click?.(undefined as never, undefined as never, undefined as never); }

test("every parent is a native cascading submenu, including the second node level", () => {
  const { build } = fixture();
  const menu = build();
  assert.equal(menu.filter((item) => item.type !== "separator").length, 10);
  for (const id of ["routing", "groups", "group:Entry & Exit", "profiles", "update-profiles", "more"]) {
    const parent = find(menu, id);
    assert.equal(parent.type, "submenu");
    assert.ok(Array.isArray(parent.submenu) && parent.submenu.length > 0);
    assert.equal(parent.click, undefined, "opening a submenu must not be a click action");
  }
});

test("native labels escape mnemonic markers but retain raw profile and node identifiers", () => {
  const { build, calls } = fixture();
  const menu = build();
  assert.equal(find(menu, "profile:one").label, "Local && A");
  assert.equal(find(menu, "group:Entry & Exit").label, "Entry && Exit");
  const node = find(menu, "node:Entry & Exit:B & C");
  assert.equal(node.label, "B && C (70ms)");
  click(node);
  assert.deepEqual(calls, [["node", "Entry & Exit", "B & C"]]);
});

test("routing, capture, remote updates and maintenance use their intended actions", () => {
  const { build, calls } = fixture();
  const menu = build();
  assert.equal(find(menu, "mode:rule").checked, true);
  assert.equal(find(menu, "system-proxy").checked, true);
  assert.equal(find(menu, "tun").checked, false);
  for (const id of ["mode:global", "tun", "profile:two", "update:two", "reload", "settings", "data-directory", "close-connections"]) click(find(menu, id));
  assert.deepEqual(calls, [["routing", "global"], ["capture", "tun"], ["profile", "two"], ["update", "two"], ["start"], ["open", "settings"], ["directory"], ["close-all"]]);
});

test("stopped, disconnected, busy and transitioning states disable unsafe actions", () => {
  const { state, build } = fixture();
  state.status = "stopped";
  let menu = build();
  assert.equal(find(menu, "service").label, "Start Service");
  assert.equal(find(menu, "service").enabled, true);
  for (const id of ["groups", "routing", "reload", "close-connections"]) assert.equal(find(menu, id).enabled, false);
  state.connected = false;
  menu = build();
  for (const id of ["service", "tun", "system-proxy", "profile:one"]) assert.equal(find(menu, id).enabled, false);
  assert.notEqual(find(menu, "open-main").enabled, false);
  assert.notEqual(find(menu, "settings").enabled, false);
  state.connected = true; state.status = "starting";
  assert.equal(find(build(), "service").enabled, false);
  state.status = "started"; state.busy = true;
  for (const id of ["service", "tun", "routing", "reload", "quit"]) assert.equal(find(build(), id).enabled, false);
});

test("reopening after a configuration change builds only current nodes and choices", () => {
  const { state, build } = fixture();
  assert.ok(find(build(), "node:Entry & Exit:A"));
  state.groups = [{ tag: "New Entry", selected: "D", selectable: true, items: [{ tag: "D", urlTestDelay: 30 }] }];
  state.profiles = [{ id: "new", name: "New Profile", type: "local" }]; state.selectedId = "new";
  const menu = build();
  assert.equal(all(menu).some((item) => item.id === "node:Entry & Exit:A" || item.id === "profile:one"), false);
  assert.equal(find(menu, "node:New Entry:D").checked, true);
  assert.equal(find(menu, "profile:new").checked, true);
});
