import assert from "node:assert/strict";
import test from "node:test";
import { PriorityFailover, reconcilePriorityGroups } from "./priorityFailover";
import { PriorityLatency, priorityProbeResult } from "./priorityLatency";
import { parsePrioritySettings, priorityGroupSettings } from "./prioritySettings";

const policySettings = () => parsePrioritySettings({ group: "West", groupLatencyCeilings: { West: 1000 },
  healthyIntervalMs: 5000, failureIntervalMs: 5000, recoveryStableMs: 10000, failbackCooldownMs: 10000 });
function fixture(settings = policySettings()) {
  const policy = new PriorityFailover(["primary", "backup", "last"], settings);
  policy.observeSelection("primary");
  const sample = (at: number, values: Record<string, number | null | false>, startedAt = at) => {
    const entries = Object.entries(values);
    return policy.record(new Map(entries.map(([tag, value]) => [tag, value !== false])), at, startedAt,
      new Map(entries.map(([tag, value]) => [tag, value === false ? null : value])));
  };
  return { policy, sample };
}
const successful = (httpMs: number, totalMs = httpMs + 1000): PromiseFulfilledResult<{ httpMs: number; totalMs: number }> => ({ status: "fulfilled", value: { httpMs, totalMs } });
const failed: PromiseRejectedResult = { status: "rejected", reason: new Error("fixture") };

test("latency requires a two-target quorum; one slow site cannot condemn a reachable node", () => {
  assert.deepEqual(priorityProbeResult([successful(1400), successful(200), successful(100)]), { reachable: true, latencyMs: 200 });
  assert.deepEqual(priorityProbeResult([successful(100), successful(1400), failed]), { reachable: true, latencyMs: 1400 });
  assert.deepEqual(priorityProbeResult([successful(100), failed, failed]), { reachable: false, latencyMs: null });
  assert.deepEqual(priorityProbeResult([successful(NaN), successful(200), successful(100)]), { reachable: true, latencyMs: null });
  assert.deepEqual(priorityProbeResult([successful(-1), successful(200)]), { reachable: true, latencyMs: null });
});

test("response latency excludes long connection and TLS setup without estimating ICMP RTT", () => {
  assert.deepEqual(priorityProbeResult([successful(180, 2800), successful(200, 3900), successful(700, 900)]), { reachable: true, latencyMs: 200 });
  assert.deepEqual(priorityProbeResult([successful(650, 700), successful(680, 750), successful(100, 8000)]), { reachable: true, latencyMs: 650 });
});

test("the analyzed US West ceiling accepts normal variation and confirms a sustained over-limit response", () => {
  const { policy, sample } = fixture(parsePrioritySettings({ group: "US-West-SF Entry" }));
  assert.equal(sample(0, { primary: 330, backup: 210 }), null);
  assert.equal(sample(5000, { primary: 449, backup: 210 }), null);
  assert.equal(sample(10000, { primary: 450, backup: 210 }), null);
  assert.equal(sample(15000, { primary: 470, backup: 210 }), null);
  assert.equal(sample(20000, { primary: 460, backup: 210 }), "backup");
  assert.equal(policy.decision(20000)?.reason, "latency");
});

test("absolute limits work without baseline learning and require three probes spanning ten seconds", () => {
  const { policy, sample } = fixture();
  assert.equal(sample(0, { primary: 1500, backup: 200 }), null);
  assert.equal(policy.nextProbeDelay("primary", new Map([["primary", true]])), 5000);
  assert.equal(sample(1000, { primary: 1600, backup: 200 }), null);
  assert.equal(sample(2000, { primary: 1400 }), null);
  assert.equal(policy.decide(10000), null, "waiting without a new slow sample is not proof of sustained delay");
  assert.equal(sample(10000, { primary: 1500 }), "backup");
  assert.deepEqual(policy.decision(10000), { tag: "backup", reason: "latency" });
});

test("an isolated spike or any below-limit probe resets the slow streak", () => {
  const { sample } = fixture();
  assert.equal(sample(0, { primary: 1600, backup: 200 }), null);
  assert.equal(sample(5000, { primary: 1500, backup: 200 }), null);
  assert.equal(sample(10000, { primary: 999, backup: 200 }), null);
  assert.equal(sample(15000, { primary: 1600, backup: 200 }), null);
  assert.equal(sample(20000, { primary: 1500, backup: 200 }), null);
  assert.equal(sample(25000, { primary: 1600 }), "backup");
});

test("ordinary fluctuations below the limit never trigger quality failover", () => {
  const { policy, sample } = fixture();
  for (let i = 0; i < 30; i++) assert.equal(sample(i * 5000, { primary: [120, 700, 999, 450][i % 4], backup: 100 }), null);
  assert.equal(policy.nextProbeDelay("primary", new Map([["primary", true]])), 5000);
});

test("all-slow or marginal backups leave the selection unchanged and back off burst probing", () => {
  const { policy, sample } = fixture();
  for (const at of [0, 5000, 10000]) assert.equal(sample(at, { primary: 1700, backup: 1600, last: 850 }), null);
  assert.equal(policy.nextProbeDelay("primary", new Map([["primary", true]])), 5000);
  assert.equal(sample(15000, { primary: 1500, backup: 800, last: 500 }), null);
  assert.equal(sample(20000, { primary: 1600, backup: 800, last: 400 }), "backup", "configured order wins over the fastest eligible node");
});

test("quality switching needs recent independently measured backup evidence", () => {
  const { policy, sample } = fixture();
  sample(0, { primary: 1500, backup: 200 }); sample(5000, { primary: 1500, backup: 200 });
  assert.equal(sample(51000, { primary: 1500 }), null, "old healthy backup evidence has expired");
  assert.equal(sample(52000, { primary: 1500, backup: null }), null, "reachability alone does not prove acceptable latency");
  assert.equal(sample(53000, { primary: 1500, backup: 200 }), null);
  assert.equal(sample(54000, { primary: 1500, backup: 200 }), "backup");
  assert.equal(policy.decide(100000), null, "stale current evidence cannot authorize a switch");
});

test("a normal latest sample withdraws a pending quality decision", () => {
  const { policy, sample } = fixture();
  for (const at of [0, 5000, 10000]) sample(at, { primary: 1500, backup: 200 });
  assert.equal(policy.decide(10000), "backup");
  sample(10001, { primary: 400 });
  assert.equal(policy.decide(10001), null);
});

test("quality cooldown prevents flapping but a real failure can still escape to a reachable slow node", () => {
  const { policy, sample } = fixture();
  for (const at of [0, 5000, 10000]) sample(at, { primary: 1500, backup: 200, last: 200 });
  policy.switched("backup", 10000);
  assert.equal(sample(11000, { primary: 200, backup: 1500, last: 200 }), null);
  assert.equal(sample(14000, { primary: 200, backup: 1500, last: 200 }), null);
  assert.equal(sample(19000, { primary: 200, backup: 1500, last: 200 }), null);
  for (const at of [19001, 19002]) assert.equal(sample(at, { primary: 1500, backup: false, last: 1500 }), null);
  assert.equal(sample(19003, { primary: 1500, backup: false, last: 1500 }), "primary");
  assert.equal(policy.decision(19003)?.reason, "unreachable");
});

test("failback waits for genuinely stable latency as well as successful connections", () => {
  const { policy, sample } = fixture();
  for (const at of [0, 5000, 10000]) sample(at, { primary: 1500, backup: 200 });
  policy.switched("backup", 10000);
  for (const at of [20000, 25000, 30000]) assert.equal(sample(at, { primary: 1500, backup: 200 }), null);
  assert.equal(sample(35000, { primary: 200, backup: 200 }), null);
  assert.equal(sample(40000, { primary: 900, backup: 200 }), null, "near-limit latency resets the stable recovery margin");
  assert.equal(sample(45000, { primary: 200, backup: 200 }), null);
  assert.equal(sample(50000, { primary: 200, backup: 200 }), null);
  assert.equal(sample(55000, { primary: 200, backup: 200 }), "primary");
  assert.equal(policy.decision(55000)?.reason, "recovered");
});

test("manual selection and sleep discard earlier slow streaks", () => {
  const { policy, sample } = fixture();
  sample(0, { primary: 1500, backup: 1500, last: 200 }); sample(5000, { primary: 1500, backup: 1500, last: 200 });
  policy.observeSelection("backup");
  assert.equal(sample(10000, { backup: 1500, last: 200 }), null);
  assert.equal(sample(15000, { backup: 1500, last: 200 }), null);
  assert.equal(sample(20000, { backup: 1500, last: 200 }), "last");
  policy.clearSamples();
  sample(25000, { backup: 1500, last: 200 }); sample(30000, { backup: 1500, last: 200 });
  assert.equal(sample(1_000_000, { backup: 1500, last: 200 }), null);
  assert.equal(sample(1_005_000, { backup: 1500, last: 200 }), null);
  assert.equal(sample(1_010_000, { backup: 1500, last: 200 }), "last");
});

test("unknown timing, a failed probe, and late measurements cannot extend a slow streak", () => {
  const settings = policySettings(), latency = new PriorityLatency(settings);
  latency.record("primary", true, 1500, 0, 0);
  latency.record("primary", true, 1500, 5000, 5000);
  latency.record("primary", true, 100, 6000, 1000); // older request finishes late
  assert.equal(latency.high("primary"), true);
  latency.record("primary", true, null, 10000, 10000);
  latency.record("primary", true, 1500, 15000, 15000);
  latency.record("primary", false, null, 20000, 20000);
  latency.record("primary", true, 1500, 25000, 25000);
  assert.equal(latency.confirmed("primary", 25000), false);
  latency.record("primary", true, 1500, 30000, 31000); // future timestamp
  assert.equal(latency.confirmed("primary", 40000), false);
});

test("regional presets differ; explicit disable and custom limits override them", () => {
  const hk = fixture(parsePrioritySettings({ group: "HK Entry" }));
  const west = fixture(parsePrioritySettings({ group: "US-West-SF Entry" }));
  const disabled = fixture(parsePrioritySettings({ group: "HK Entry", groupLatencyCeilings: { "HK Entry": 0 } }));
  for (const at of [0, 5000, 10000]) {
    hk.sample(at, { primary: 350, backup: 100 }); west.sample(at, { primary: 350, backup: 100 });
    disabled.sample(at, { primary: 6000, backup: 100 });
  }
  assert.equal(hk.policy.decide(10000), "backup");
  assert.equal(west.policy.decide(10000), null);
  assert.equal(disabled.policy.decide(10000), null);
  for (const at of [11000, 12000, 13000]) disabled.sample(at, { primary: false, backup: 300 });
  assert.equal(disabled.policy.decide(13000), "backup", "disabling high-latency switching must preserve disconnection failover");
});

test("limits are validated, isolated per group and reconciled with a replaced profile", () => {
  for (const groupLatencyCeilings of [null, [], { West: NaN }, { West: -1 }, { West: 99 }, { West: 60001 }, { West: 500.5 }, { " ": 500 }]) {
    assert.throws(() => parsePrioritySettings({ groupLatencyCeilings }));
  }
  const value = parsePrioritySettings({ group: "West", groupLatencyCeilings: { West: 2000, HK: 1000, Gone: 3000 } });
  assert.deepEqual(priorityGroupSettings(value, "West").groupLatencyCeilings, { West: 2000 });
  const edited = parsePrioritySettings({ ...value, groupLatencyCeilings: { ...value.groupLatencyCeilings, HK: 1500 } });
  assert.deepEqual(priorityGroupSettings(edited, "West"), priorityGroupSettings(value, "West"));
  assert.deepEqual(reconcilePriorityGroups([{ tag: "West", nodes: ["a"] }], value).groupLatencyCeilings, { West: 2000 });
  const literal = parsePrioritySettings(JSON.parse('{"group":"__proto__","groupLatencyCeilings":{"__proto__":1500}}'));
  assert.deepEqual(priorityGroupSettings(literal, "__proto__").groupLatencyCeilings, JSON.parse('{"__proto__":1500}'));
  assert.deepEqual(parsePrioritySettings({ group: "West" }).groupLatencyCeilings, {});
});
