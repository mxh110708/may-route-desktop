import assert from "node:assert/strict";
import test from "node:test";

import { PriorityProfileCache, prioritySummaryState } from "./priorityProfileCache";
import type { PriorityPanelState } from "../shared/ipc";
import { priorityGroups, priorityTags, priorityTagsFromGroups, reconcilePrioritySettings } from "./priorityFailover";
import { DEFAULT_PRIORITY_SETTINGS, parsePrioritySettings, priorityContextRevision } from "./prioritySettings";
import { buildRuntimeConfig } from "./runtimeConfig";

const content = (tag: string) => JSON.stringify({ inbounds: [
  { type: "tun", tag: "tun-in", address: ["172.19.0.1/30"] },
  { type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 2080 },
], outbounds: [
  { type: "selector", tag: "entry", outbounds: [tag, tag] },
  { type: "shadowsocks", tag, server: "fixture.invalid", server_port: 1234, method: "2022-blake3-aes-128-gcm", password: "synthetic" },
  { type: "direct", tag: "direct" },
] });
const snapshot = { settings: { ...DEFAULT_PRIORITY_SETTINGS, group: "entry", order: ["old", "new"] }, revision: "settings-1" };

test("unchanged UI polling reuses analysis; every identity change rebuilds it", () => {
  let builds = 0;
  const cache = new PriorityProfileCache((raw, mode) => { builds++; return buildRuntimeConfig(raw, mode); });
  const raw = content("old");
  const a = cache.read("one", raw, "system-proxy", snapshot);
  for (let i = 0; i < 20; i++) assert.equal(cache.read("one", raw, "system-proxy", snapshot), a);
  assert.equal(builds, 1);
  const b = cache.read("one", raw, "tun", snapshot);
  assert.notEqual(a, b);
  cache.read("two", raw, "tun", snapshot);
  cache.read("two", raw, "tun", { ...snapshot, revision: "settings-2" });
  assert.equal(builds, 4);
});

test("replacement profiles with the same length immediately remove old nodes", () => {
  const cache = new PriorityProfileCache();
  assert.equal(content("old").length, content("new").length);
  const a = cache.read("one", content("old"), "system-proxy", snapshot);
  const b = cache.read("one", content("new"), "system-proxy", snapshot);
  assert.deepEqual(a.settings.order, ["old"]);
  assert.deepEqual(b.settings.order, ["new"]);
  assert.deepEqual(b.groups, [{ tag: "entry", nodes: ["new"] }]);
  assert.notEqual(a.revision, b.revision);
});

test("cached output matches the original reconciliation and revision contract", () => {
  const cache = new PriorityProfileCache();
  for (const mode of ["system-proxy", "tun"] as const) {
    const raw = content("old"), runtime = buildRuntimeConfig(raw, mode);
    const result = cache.read("one", raw, mode, snapshot);
    assert.deepEqual(result.groups, priorityGroups(runtime));
    assert.deepEqual(result.settings, reconcilePrioritySettings(runtime, snapshot.settings));
    assert.deepEqual(priorityTagsFromGroups(result.groups, result.settings), priorityTags(runtime, result.settings));
    assert.equal(result.revision, priorityContextRevision(snapshot.revision, "one", raw));
  }
  const none = cache.read(null, null, "tun", snapshot);
  assert.equal(none.hash, null);
  assert.deepEqual(none.groups, []);
  assert.deepEqual(none.settings.order, []);
});

test("failed analysis cannot return a previous profile projection", () => {
  const cache = new PriorityProfileCache();
  cache.read("one", content("old"), "system-proxy", snapshot);
  assert.throws(() => cache.read("one", "bad json", "system-proxy", snapshot));
  const next = cache.read("one", content("new"), "system-proxy", snapshot);
  assert.deepEqual(next.settings.order, ["new"]);
});

test("cached group and order arrays cannot be changed by a reader", () => {
  const cache = new PriorityProfileCache();
  const result = cache.read("one", content("old"), "system-proxy", snapshot);
  assert.throws(() => result.groups[0].nodes.push("stale"));
  assert.throws(() => result.settings.order.push("stale"));
  assert.throws(() => result.settings.groupOrders!.entry.push("stale"));
  assert.throws(() => { result.settings.groupOrders!.other = ["stale"]; });
  assert.throws(() => { result.settings.groupLatencyCeilings.entry = 700; });
  assert.deepEqual(cache.read("one", content("old"), "system-proxy", snapshot).settings.order, ["old"]);
});

test("removed region ceilings request one reconciliation save even when node orders do not change", () => {
  const cache = new PriorityProfileCache();
  const settings = parsePrioritySettings({ group: "entry", order: ["old"], groupLatencyCeilings: { entry: 450, removed: 700 } });
  const value = cache.read("one", content("old"), "system-proxy", { settings, revision: "one" });
  assert.deepEqual(value.settings.order, ["old"]);
  assert.deepEqual(value.settings.groupLatencyCeilings, { entry: 450 });
  assert.equal(value.reconciled, true);
  assert.equal(cache.read("one", content("old"), "system-proxy", { settings: value.settings, revision: "two" }).reconciled, false);
});

test("different map key order or following a group's default never asks for a duplicate save", () => {
  const raw = JSON.stringify({ outbounds: [{ type: "selector", tag: "West", outbounds: ["w"] },
    { type: "selector", tag: "Europe", outbounds: ["e"] }, { type: "shadowsocks", tag: "w" }, { type: "shadowsocks", tag: "e" }] });
  const cache = new PriorityProfileCache(value => value);
  const settings = parsePrioritySettings({ group: "Europe", groupOrders: { Europe: ["e"], West: ["w"] } });
  assert.equal(cache.read("one", raw, "system-proxy", { settings, revision: "one" }).reconciled, false);
  const following = parsePrioritySettings({ group: "Europe", groupOrders: { Europe: [], West: ["w"] } });
  assert.equal(cache.read("one", raw, "system-proxy", { settings: following, revision: "two" }).reconciled, false);
});

test("the overview keeps every running-state flag without retaining editor node lists", () => {
  const state: PriorityPanelState = { settings: snapshot.settings, groups: [{ tag: "entry", nodes: ["old", "new"] }],
    revision: "revision", profileId: "one", path: "private-settings-path", reconciled: true,
    running: true, directMode: false, active: true, preferred: "old", monitoredSelected: true,
    needsReload: true, selected: "new", lastSwitch: { from: "old", to: "new", at: "now", reason: "fixture" } };
  assert.deepEqual(prioritySummaryState(state), { settings: { group: "entry" }, running: true, directMode: false,
    active: true, preferred: "old", monitoredSelected: true, needsReload: true, selected: "new" });
});

test("the overview projects actual monitored groups instead of the editor's selected region", () => {
  const state: PriorityPanelState = { settings: { ...snapshot.settings, group: "Europe" }, groups: [], revision: "one", profileId: "one", path: "fixture",
    usageAware: true, activityAvailable: true, running: true, directMode: false, active: true, preferred: "w", monitoredSelected: true,
    needsReload: false, selected: "West: w；HK: h", lastSwitch: null,
    activeGroups: [{ group: "West", selected: "w", preferred: "w", monitoredSelected: true }, { group: "HK", selected: "h", preferred: "h", monitoredSelected: true }] };
  const summary = prioritySummaryState(state);
  assert.equal(summary.settings.group, "West / HK"); assert.deepEqual(summary.activeGroups, state.activeGroups);
  assert.equal(prioritySummaryState({ ...state, active: false, activeGroups: [], selected: null }).settings.group, "");
  assert.equal(prioritySummaryState({ ...state, active: false, activeGroups: [], initializing: true }).initializing, true);
});
