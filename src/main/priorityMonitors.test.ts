import assert from "node:assert/strict";
import test from "node:test";
import { PriorityMonitors, regionalRecoveryEvidence, type PriorityPreference } from "./priorityMonitors";
import { parsePrioritySettings } from "./prioritySettings";
const drain = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const groups = [{ tag: "West", nodes: ["w1", "w2"] }, { tag: "HK", nodes: ["h1", "h2"] }, { tag: "Europe", nodes: ["e1", "e2"] }];
const candidates = groups.flatMap(g => g.nodes).map((tag, i) => ({ tag, port: 10000 + i }));
const settings = () => parsePrioritySettings({ group: "West", failureRounds: 2, backupSuccessRounds: 1, recoverySuccessRounds: 2,
  recoveryStableMs: 10000, failbackCooldownMs: 10000, healthyIntervalMs: 5000, failureIntervalMs: 5000 });
function setup(remembered: Record<string, PriorityPreference> = {}) {
  let now = 0, enabled = true, delayedSelection = false;
  const selected: Record<string, string> = { West: "w1", HK: "h1", Europe: "e1" };
  const healthy: Record<string, boolean> = Object.fromEntries(candidates.map(c => [c.tag, true]));
  const calls: string[] = [], switches: string[][] = [], changes: string[] = [], errors: unknown[] = [];
  const monitors = new PriorityMonitors({ now: () => now, selected: group => selected[group] ?? null, current: () => enabled,
    probe: async candidate => { calls.push(candidate.tag); return healthy[candidate.tag]; },
    switch: async (group, from, to, current) => { if (!current()) return false; switches.push([group, from, to]); if (!delayedSelection) selected[group] = to; return true; },
    changed: event => changes.push(event), error: error => errors.push(error) });
  monitors.configure(groups, candidates, settings(), remembered);
  return { monitors, selected, healthy, calls, switches, changes, errors,
    delaySelection: () => { delayedSelection = true; }, stop: () => { enabled = false; },
    tick: async (time: number, used: string[]) => { now = time; monitors.tick(used); await drain(); } };
}

test("idle groups send no probes; simultaneous used groups have independent failover", async () => {
  const f = setup(); await f.tick(0, []); assert.equal(f.calls.length, 0);
  f.healthy.w1 = false; await f.tick(0, ["West", "HK"]); await f.tick(1000, ["West", "HK"]);
  assert.deepEqual(f.switches, [["West", "w1", "w2"]]); assert.equal(f.selected.HK, "h1");
  assert.equal(f.calls.some(tag => tag.startsWith("e")), false);
  assert.deepEqual(f.monitors.active.map(m => m.group), ["West", "HK"]);
  const count = f.calls.filter(tag => tag.startsWith("w")).length;
  await f.tick(2000, ["HK"]); await f.tick(10000, ["HK"]);
  assert.equal(f.calls.filter(tag => tag.startsWith("w")).length, count);
  assert.equal(f.errors.length, 0);
});

test("region changes retain each order and preference; inactive settings edits do not reset healthy regions", async () => {
  const f = setup(); f.monitors.update(parsePrioritySettings({ ...settings(), groupOrders: { West: ["w2", "w1"], Europe: ["e2"] } }));
  await f.tick(0, ["West"]); const west = f.monitors.active[0];
  assert.deepEqual(west.policy.tags, ["w2", "w1"]); assert.equal(west.policy.preferred, "w1");
  f.monitors.update(parsePrioritySettings({ ...settings(), group: "Europe", groupOrders: { West: ["w2", "w1"], Europe: ["e1", "e2"] } }));
  assert.equal(f.monitors.active[0], west);
  await f.tick(1000, ["Europe"]); await f.tick(2000, ["West"]);
  assert.equal(f.monitors.active[0], west); assert.deepEqual(west.policy.tags, ["w2", "w1"]);
  assert.equal(f.monitors.needsRoutes, false);
});

test("two failing regions switch independently without invalidating each other's probes", async () => {
  const f = setup(); f.healthy.w1 = false; f.healthy.h1 = false;
  await f.tick(0, ["West", "HK"]); await f.tick(1000, ["West", "HK"]);
  assert.deepEqual(f.switches, [["West", "w1", "w2"], ["HK", "h1", "h2"]]);
  assert.deepEqual(f.monitors.preferences, { West: { preferred: "w1", selected: "w2" }, HK: { preferred: "h1", selected: "h2" } });
});

test("a recovered node cancels a queued switch before the actual mutation", async () => {
  let now = 0, mutate: (() => boolean) | undefined;
  const f = new PriorityMonitors({ now: () => now, current: () => true, selected: () => "w1",
    probe: async candidate => candidate.tag !== "w1", changed: () => {}, error: error => { throw error; },
    switch: async (_group, _from, _to, current) => { mutate = current; return false; } });
  f.configure(groups, candidates, settings()); f.tick(["West"]); await drain(); now = 1000; f.tick(["West"]); await drain();
  assert.ok(mutate); const monitor = f.active[0];
  monitor.policy.record(new Map([["w1", true]]), 1001);
  assert.equal(mutate(), false);
});

test("automatic backup selection and eventual failback survive delayed daemon state and persistence", async () => {
  const f = setup(); f.delaySelection(); f.healthy.w1 = false;
  await f.tick(0, ["West"]); await f.tick(1000, ["West"]);
  assert.deepEqual(f.monitors.preferences.West, { preferred: "w1", selected: "w2" });
  f.selected.West = "w2"; await f.tick(2000, ["West"]);
  assert.equal(f.monitors.active[0].policy.preferred, "w1");
  f.healthy.w1 = true; await f.tick(12000, ["West"]); await f.tick(22000, ["West"]);
  assert.deepEqual(f.switches, [["West", "w1", "w2"], ["West", "w2", "w1"]]);
  const restored = setup({ West: { preferred: "w1", selected: "w2" } }); restored.selected.West = "w2";
  await restored.tick(0, ["West"]); assert.equal(restored.monitors.active[0].policy.preferred, "w1");
});

test("manual changes while idle become the preference even if settings are saved before resuming", async () => {
  const f = setup(); await f.tick(0, ["West"]); await f.tick(1000, []); f.selected.West = "w2";
  f.monitors.update(parsePrioritySettings({ ...settings(), failureRounds: 4 })); await f.tick(2000, ["West"]);
  assert.equal(f.monitors.active[0].policy.preferred, "w2");
});

test("an RPC timeout followed by confirmed selection keeps the original preference and persists confirmation", async () => {
  let now = 0, selected = "w1", persisted = 0;
  const f = new PriorityMonitors({ now: () => now, selected: () => selected, current: () => true,
    probe: async candidate => candidate.tag !== "w1", error: () => {},
    switch: async () => { selected = "w2"; throw new Error("RPC reply timed out"); },
    changed: event => { if (event === "priority-switch-completed") persisted++; } });
  f.configure(groups, candidates, settings()); f.tick(["West"]); await drain(); now = 1000; f.tick(["West"]); await drain();
  now = 2000; f.tick(["West"]); await drain();
  assert.equal(f.active[0].policy.preferred, "w1"); assert.equal(persisted, 1);
  assert.deepEqual(f.preferences.West, { preferred: "w1", selected: "w2" });
});

test("stopped sessions and manual node changes cannot be switched by late probe results", async () => {
  let current = true, selected = "w1", resolve: ((ok: boolean) => void)[] = [], switched = 0;
  const f = new PriorityMonitors({ now: () => 0, selected: () => selected, current: () => current,
    probe: () => new Promise<boolean>(r => resolve.push(r)), switch: async () => { switched++; return true; }, changed: () => {}, error: error => { throw error; } });
  f.configure(groups, candidates, settings()); f.tick(["West"]); await drain();
  selected = "w2"; current = false; f.tick([]); resolve.forEach(r => r(true)); await drain();
  assert.equal(switched, 0); assert.deepEqual(f.active, []);
});

test("legacy probe pools request one reload without inventing probes for unavailable regions", async () => {
  const f = setup(); f.monitors.configure(groups, candidates.filter(c => c.tag.startsWith("w")), settings());
  assert.equal(f.monitors.needsRoutes, true); await f.tick(0, ["HK"]); assert.deepEqual(f.calls, []);
  f.monitors.update(parsePrioritySettings({ ...settings(), enabled: false })); assert.equal(f.monitors.needsRoutes, false);
});

test("a healthy active region prevents a global restart caused by another region's outage", () => {
  assert.equal(regionalRecoveryEvidence(["selected-healthy", "all-down"]), "unavailable");
  assert.equal(regionalRecoveryEvidence(["all-down", "all-down"]), "all-down");
  assert.equal(regionalRecoveryEvidence(["selected-healthy", "selected-healthy"]), "reachable");
  assert.equal(regionalRecoveryEvidence(["selected-healthy", "unavailable"]), "unavailable");
  assert.equal(regionalRecoveryEvidence([]), "reachable");
});
