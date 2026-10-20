import assert from "node:assert/strict";
import test from "node:test";
import { WindowsProxyMonitor, type WindowsProxyHealth, type ProxyRecoveryCheckpoint } from "./windowsProxyMonitor";
import type { WindowsProxyOwnership } from "./systemProxyRecovery";

function fixture(checkpoint = { state: "available" as ProxyRecoveryCheckpoint }) {
  let ownership: WindowsProxyOwnership = "owned", key = "service-1", active = true;
  let writes = 0, failWrite = false, now = 0, dismissed = 0;
  let notice: WindowsProxyHealth | null = null;
  const states: WindowsProxyHealth[] = [], warnings: WindowsProxyHealth[] = [];
  const queued: (() => Promise<void>)[] = [];
  const monitor = new WindowsProxyMonitor({
    context: async () => {
      if (!active) return null;
      const captured = key;
      return { key, current: () => active && key === captured,
        read: async () => ownership,
        repair: async () => { writes++; if (failWrite) throw new Error("deadline"); ownership = "owned"; } };
    },
    enqueue: async op => { queued.push(op); },
    now: () => now,
    changed: state => states.push(state), warning: state => { warnings.push(state); notice = state; }, log: () => {},
    dismissWarning: () => { if (notice !== null) dismissed++; notice = null; },
    loadCheckpoint: () => checkpoint.state,
    saveCheckpoint: state => { checkpoint.state = state; },
  });
  return { monitor, states, warnings, queued,
    pollAt: async (at: number) => { now = at; return monitor.poll(); },
    get notice() { return notice; }, get dismissed() { return dismissed; },
    set ownership(v: WindowsProxyOwnership) { ownership = v; },
    set active(v: boolean) { active = v; },
    set key(v: string) { key = v; },
    set failWrite(v: boolean) { failWrite = v; },
    get writes() { return writes; },
    flush: async () => { while (queued.length) await queued.shift()!(); },
  };
}

test("local schedule confirms a disabled matching endpoint within two polls without network probes", async () => {
  const f = fixture();
  assert.equal(await f.monitor.poll(), 2000);
  f.ownership = "detached";
  assert.equal(await f.monitor.poll(), 1000);
  assert.equal(f.writes, 0);
  await f.monitor.poll();
  assert.equal(f.states.at(-1), "repairing");
  await f.flush();
  assert.equal(f.writes, 1);
  assert.equal(f.states.at(-1), "healthy");
});

test("queued writes do not block reads or duplicate repair; stop/TUN invalidate the queued action", async () => {
  const f = fixture(); f.ownership = "detached";
  await f.monitor.poll(); await f.monitor.poll();
  await f.monitor.poll(); await f.monitor.poll();
  assert.equal(f.queued.length, 1);
  f.active = false;
  await f.monitor.poll(); await f.flush();
  assert.equal(f.writes, 0);
  assert.equal(f.states.at(-1), "inactive");
});

test("repair quota survives node changes, service transitions and stale samples", async () => {
  const f = fixture(); f.ownership = "detached";
  await f.monitor.poll(); await f.monitor.poll(); await f.flush();
  // Changing node selection deliberately is not part of the local identity.
  f.active = false; await f.monitor.poll();
  f.active = true; f.key = "automatic-reload";
  f.ownership = "detached";
  await f.monitor.poll(); await f.monitor.poll(); await f.flush();
  assert.equal(f.writes, 1);
  assert.equal(f.states.at(-1), "suspended");
  for (const time of [2000, 4000, 6000, 8000, 10000]) await f.pollAt(time);
  assert.deepEqual(f.warnings, ["suspended"]);
  f.monitor.newSession();
  await f.monitor.poll(); await f.monitor.poll(); await f.flush();
  assert.equal(f.writes, 2);
});

test("foreign address/PAC is visible and warned once, never automatically reclaimed", async () => {
  const f = fixture(); f.ownership = "foreign";
  await f.monitor.poll(); await f.monitor.poll();
  assert.deepEqual(f.warnings, []);
  for (const time of [2000, 4000, 6000, 8000, 10000, 12000]) await f.pollAt(time);
  assert.deepEqual(f.warnings, ["foreign"]);
  f.ownership = "detached";
  await f.monitor.poll(); await f.monitor.poll(); await f.flush();
  assert.equal(f.writes, 0);
  assert.equal(f.states.at(-1), "suspended");
});

test("ownership change while repair waits cancels the write and preserves yielding", async () => {
  const f = fixture(); f.ownership = "detached";
  await f.monitor.poll(); await f.monitor.poll();
  f.ownership = "foreign"; await f.flush();
  f.ownership = "detached"; await f.monitor.poll(); await f.monitor.poll();
  await f.flush(); assert.equal(f.writes, 0);
});

test("RPC timeout stays unknown and never repeats even if a late write succeeds", async () => {
  const f = fixture(); f.ownership = "detached"; f.failWrite = true;
  await f.monitor.poll(); await f.monitor.poll(); await f.flush();
  assert.equal(f.states.at(-1), "unknown");
  f.ownership = "owned"; await f.monitor.poll();
  f.ownership = "detached"; await f.monitor.poll(); await f.monitor.poll(); await f.flush();
  assert.equal(f.writes, 1);
  assert.equal(f.states.at(-1), "unknown");
});

test("confirmation cannot span a profile or service identity change", async () => {
  const f = fixture(); f.ownership = "detached";
  await f.monitor.poll(); f.key = "service-2"; await f.monitor.poll();
  assert.equal(f.queued.length, 0);
  await f.monitor.poll(); await f.flush(); assert.equal(f.writes, 1);
});

test("restarting only the application cannot replenish the persisted repair allowance", async () => {
  const checkpoint = { state: "available" as ProxyRecoveryCheckpoint };
  const first = fixture(checkpoint); first.ownership = "detached";
  await first.monitor.poll(); await first.monitor.poll(); await first.flush();
  assert.equal(checkpoint.state, "used");
  const second = fixture(checkpoint); second.ownership = "detached";
  await second.monitor.poll(); await second.monitor.poll(); await second.flush();
  assert.equal(second.writes, 0); assert.equal(second.states.at(-1), "suspended");
});

test("timed-out repair remains uncertain across application restart", async () => {
  const checkpoint = { state: "unknown" as ProxyRecoveryCheckpoint };
  const f = fixture(checkpoint); f.ownership = "detached";
  await f.monitor.poll(); await f.monitor.poll(); await f.flush();
  assert.equal(f.writes, 0); assert.equal(f.states.at(-1), "unknown");
});

test("Clash startup-style brief off/on changes do not produce a persistent warning", async () => {
  const checkpoint = { state: "used" as ProxyRecoveryCheckpoint };
  const f = fixture(checkpoint);
  f.ownership = "detached"; await f.pollAt(0); await f.pollAt(1000);
  assert.equal(f.states.at(-1), "suspended");
  f.ownership = "owned"; await f.pollAt(2000);
  f.ownership = "detached"; await f.pollAt(4000); await f.pollAt(5000);
  f.ownership = "owned"; await f.pollAt(8000);
  assert.equal(f.states.at(-1), "healthy");
  assert.deepEqual(f.warnings, []); assert.equal(f.notice, null); assert.equal(f.writes, 0);
});

test("a matching endpoint rearms after fifteen continuously observed healthy seconds", async () => {
  const checkpoint = { state: "available" as ProxyRecoveryCheckpoint };
  const f = fixture(checkpoint); f.ownership = "detached";
  await f.pollAt(0); await f.pollAt(1000); await f.flush();
  assert.equal(f.writes, 1); assert.equal(checkpoint.state, "used");
  for (let time = 3000; time <= 17000; time += 2000) await f.pollAt(time);
  assert.equal(checkpoint.state, "used");
  await f.pollAt(19000); assert.equal(checkpoint.state, "available");
  f.ownership = "detached"; await f.pollAt(21000); await f.pollAt(22000); await f.flush();
  assert.equal(f.writes, 2); assert.deepEqual(f.warnings, []);
});

test("separate close/reopen incidents recover while startup chatter remains silent", async () => {
  const f = fixture(); f.ownership = "detached";
  await f.pollAt(0); await f.pollAt(1000); await f.flush();
  assert.equal(f.writes, 1);
  for (let time = 3000; time <= 21000; time += 2000) await f.pollAt(time);
  f.ownership = "detached"; await f.pollAt(23000); await f.pollAt(24000); await f.flush();
  assert.equal(f.writes, 2);
  await f.pollAt(26000);
  f.ownership = "detached"; await f.pollAt(28000); await f.pollAt(29000);
  f.ownership = "owned"; await f.pollAt(32000);
  assert.deepEqual(f.warnings, []); assert.equal(f.notice, null);
  assert.equal(f.states.at(-1), "healthy"); assert.equal(f.writes, 2);
});

test("continuous toggling does not earn repeated writes by briefly appearing healthy", async () => {
  const checkpoint = { state: "available" as ProxyRecoveryCheckpoint };
  const f = fixture(checkpoint); f.ownership = "detached";
  await f.pollAt(0); await f.pollAt(1000); await f.flush();
  for (let time = 3000; time < 60000; time += 2000) {
    f.ownership = time % 4000 === 3000 ? "owned" : "detached";
    await f.pollAt(time); await f.flush();
  }
  assert.equal(f.writes, 1); assert.equal(checkpoint.state, "used");
  assert.deepEqual(f.warnings, []);
});

test("a persistent outage warns after ten observed seconds and recovery dismisses the active notice", async () => {
  const f = fixture({ state: "used" }); f.ownership = "detached";
  await f.pollAt(0); await f.pollAt(1000);
  for (const time of [3000, 5000, 7000, 9000]) await f.pollAt(time);
  assert.deepEqual(f.warnings, []);
  await f.pollAt(11000); await f.pollAt(13000);
  assert.deepEqual(f.warnings, ["suspended"]); assert.equal(f.notice, "suspended");
  f.ownership = "owned"; await f.pollAt(15000);
  assert.equal(f.notice, null); assert.equal(f.dismissed, 1); assert.equal(f.writes, 0);
});

test("sleep and unread observation gaps do not count as stable recovery or persistent warning", async () => {
  const checkpoint = { state: "used" as ProxyRecoveryCheckpoint };
  const f = fixture(checkpoint);
  await f.pollAt(0); await f.pollAt(2000); await f.pollAt(100000);
  assert.equal(checkpoint.state, "used");
  f.ownership = "detached"; await f.pollAt(102000); await f.pollAt(103000);
  await f.pollAt(200000); assert.deepEqual(f.warnings, []);
  assert.equal(f.writes, 0); assert.equal(checkpoint.state, "used");
});

test("a foreign takeover cannot rearm from later healthy samples without an explicit Route action", async () => {
  const checkpoint = { state: "available" as ProxyRecoveryCheckpoint };
  const f = fixture(checkpoint); f.ownership = "foreign";
  await f.pollAt(0); assert.equal(checkpoint.state, "foreign");
  f.ownership = "owned";
  for (let time = 2000; time <= 24000; time += 2000) await f.pollAt(time);
  assert.equal(checkpoint.state, "foreign");
  f.ownership = "detached"; await f.pollAt(26000); await f.pollAt(27000); await f.flush();
  assert.equal(f.writes, 0);
  f.monitor.newSession(); await f.pollAt(28000); await f.pollAt(29000); await f.flush();
  assert.equal(f.writes, 1);
});

test("uncertain repair stays latched even after a minute of healthy readings", async () => {
  const checkpoint = { state: "available" as ProxyRecoveryCheckpoint };
  const f = fixture(checkpoint); f.ownership = "detached"; f.failWrite = true;
  await f.pollAt(0); await f.pollAt(1000); await f.flush();
  f.ownership = "owned";
  for (let time = 3000; time <= 65000; time += 2000) await f.pollAt(time);
  assert.equal(checkpoint.state, "unknown"); assert.equal(f.states.at(-1), "unknown");
  f.ownership = "detached"; await f.pollAt(67000); await f.pollAt(68000); await f.flush();
  assert.equal(f.writes, 1);
});

test("a process restart during an in-flight repair cannot turn the old command into a fresh allowance", async () => {
  const checkpoint = { state: "repairing" as ProxyRecoveryCheckpoint };
  const f = fixture(checkpoint);
  for (let time = 0; time <= 20000; time += 2000) await f.pollAt(time);
  f.ownership = "detached"; await f.pollAt(22000); await f.pollAt(23000); await f.flush();
  assert.equal(f.states.at(-1), "unknown"); assert.equal(f.writes, 0);
  assert.equal(checkpoint.state, "repairing");
});
