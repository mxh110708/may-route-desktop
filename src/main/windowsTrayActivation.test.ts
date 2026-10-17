import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Rectangle, Tray } from "electron";

import { bindWindowsTrayActivation } from "./windowsTrayActivation";

function fixture() {
  const events = new EventEmitter();
  const calls: string[] = [];
  const state = { mainVisible: false, menuVisible: false, anchor: null as Rectangle | null };
  // Electron Tray exposes overloaded versions of EventEmitter.on.
  bindWindowsTrayActivation(events as unknown as Pick<Tray, "on">, {
    hideMenu: () => { calls.push("hide-menu"); state.menuVisible = false; },
    openMainWindow: () => { calls.push("show-main"); state.mainVisible = true; },
    showMenu: (bounds) => { calls.push("show-menu"); state.menuVisible = true; state.anchor = bounds; },
  });
  return { events, calls, state };
}

test("single left click opens the main window without opening a menu", () => {
  const { events, calls, state } = fixture();
  events.emit("click", {}, { x: 20, y: 30, width: 24, height: 24 });
  assert.deepEqual(calls, ["hide-menu", "show-main"]);
  assert.equal(state.mainVisible, true);
  assert.equal(state.menuVisible, false);
});

test("right click opens only the menu at the clicked icon and left click dismisses it", () => {
  const { events, calls, state } = fixture();
  const bounds = { x: -180, y: 650, width: 24, height: 24 };
  events.emit("right-click", {}, bounds);
  assert.deepEqual(calls, ["show-menu"]);
  assert.equal(state.mainVisible, false);
  assert.equal(state.menuVisible, true);
  assert.equal(state.anchor, bounds);
  events.emit("click", {}, bounds);
  assert.equal(state.mainVisible, true);
  assert.equal(state.menuVisible, false);
});

test("the Windows double-click notification does not repeat activation or open a menu", () => {
  const { events, calls, state } = fixture();
  const bounds = { x: 20, y: 30, width: 24, height: 24 };
  events.emit("click", {}, bounds);
  events.emit("double-click", {}, bounds);
  assert.deepEqual(calls, ["hide-menu", "show-main"]);
  assert.equal(state.mainVisible, true);
  assert.equal(state.menuVisible, false);
});
