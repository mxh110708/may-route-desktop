import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePrioritySettings, priorityGroupSettings, prioritySettingsSnapshot, savePrioritySettings } from "./prioritySettings";
import { addProbeRoutes, priorityProbeTags, reconcilePriorityGroups } from "./priorityFailover";

test("legacy settings migrate without losing custom priority; explicit per-group choices win", () => {
  const old = parsePrioritySettings({ group: "West", order: ["w2", "w1"] });
  assert.deepEqual(old.groupOrders, { West: ["w2", "w1"] });
  assert.deepEqual(priorityGroupSettings(old, "Europe").order, []);
  const multi = parsePrioritySettings({ ...old, groupOrders: { West: [], Europe: ["e2", "e1"] } });
  assert.deepEqual(multi.order, []); assert.deepEqual(priorityGroupSettings(multi, "Europe").order, ["e2", "e1"]);
  assert.deepEqual(old.order, ["w2", "w1"]);
});

test("all group orders reconcile on profile replacement without adding excluded or newly introduced nodes", () => {
  const settings = parsePrioritySettings({ group: "West", groupOrders: { West: ["w2", "gone"], Europe: ["e2", "e1"], Removed: ["old"] } });
  const result = reconcilePriorityGroups([{ tag: "West", nodes: ["w1", "w2", "new"] }, { tag: "Europe", nodes: ["e1", "e3"] }], settings);
  assert.deepEqual(result.groupOrders, { West: ["w2"], Europe: ["e1"] });
  assert.deepEqual(result.order, ["w2"]);
});

test("per-group arrays reject malformed values and support arbitrary literal selector names safely", () => {
  for (const groupOrders of [null, [], { West: ["a", "a"] }, { West: "a" }, { " ": [] }, { West: [4] }]) {
    assert.throws(() => parsePrioritySettings({ groupOrders }));
  }
  const settings = parsePrioritySettings(JSON.parse('{"group":"__proto__","order":["node"],"groupOrders":{"constructor":["other"]}}'));
  assert.deepEqual(priorityGroupSettings(settings, "__proto__").order, ["node"]);
  assert.deepEqual(priorityGroupSettings(settings, "constructor").order, ["other"]);
  assert.equal(Object.getPrototypeOf(settings.groupOrders!), Object.prototype);
});

test("one atomic save retains every group's order across disk reload and stale saves still fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "route-priority-groups-")), path = join(dir, "policy.json");
  try {
    const initial = await prioritySettingsSnapshot(path);
    await savePrioritySettings(path, { ...initial.settings, group: "Europe", groupOrders: { West: ["w2", "w1"], Europe: ["e2", "e1"] } }, initial.revision);
    const saved = await prioritySettingsSnapshot(path);
    assert.deepEqual(priorityGroupSettings(saved.settings, "West").order, ["w2", "w1"]);
    assert.deepEqual(priorityGroupSettings(saved.settings, "Europe").order, ["e2", "e1"]);
    const content = await readFile(path, "utf8");
    await assert.rejects(savePrioritySettings(path, initial.settings, initial.revision), /修改/);
    assert.equal(await readFile(path, "utf8"), content);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("shared loopback probe pool prepares all regions once without changing existing routes", () => {
  const config = { inbounds: [{ type: "mixed", tag: "business" }], outbounds: [
    { type: "selector", tag: "West", outbounds: ["w", "shared"] }, { type: "selector", tag: "HK", outbounds: ["h", "shared"] },
    ...["w", "h", "shared"].map(tag => ({ type: "shadowsocks", tag })),
  ], route: { rules: [{ domain_suffix: ["fixture.invalid"], outbound: "West" }] } };
  const content = JSON.stringify(config), settings = parsePrioritySettings({ group: "West", order: ["w"] });
  assert.deepEqual(priorityProbeTags(content, settings), ["w", "shared", "h"]);
  const result = addProbeRoutes(content, [10001, 10002, 10003], settings, true), output = JSON.parse(result.content);
  assert.equal(output.inbounds.length, 4); assert.deepEqual(output.outbounds, config.outbounds);
  assert.deepEqual(output.route.rules.slice(3), config.route.rules);
  assert.ok(output.inbounds.slice(1).every((i: { listen: string }) => i.listen === "127.0.0.1"));
});
