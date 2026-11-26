import assert from "node:assert/strict";
import test from "node:test";
import { WindowsProxyMonitor, type WindowsProxyHealth } from "./windowsProxyMonitor";
import type { WindowsProxyOwnership } from "./systemProxyRecovery";

function fixture() {
  let ownership: WindowsProxyOwnership = "owned", key = "service-1", active = true;
  let writes = 0, failWrite = false, overwritten = false, now = 0, dismissed = 0;
  let beforeRead: (() => Promise<void>) | null = null, duringWrite: (() => Promise<void>) | null = null;
  let notice: WindowsProxyHealth | null = null;
  const states: WindowsProxyHealth[] = [], warnings: WindowsProxyHealth[] = [];
  const queued: (() => Promise<void>)[] = [];
  const monitor = new WindowsProxyMonitor({
    context: async () => {
      if (!active) return null;
      const captured = key;
      return { key, current: () => active && key === captured,
        read: async () => { await beforeRead?.(); return ownership; },
        repair: async () => { writes++; await duringWrite?.(); if (failWrite) throw new Error("deadline"); if (!overwritten) ownership = "owned"; } };
    },
    enqueue: async op => { queued.push(op); }, now: () => now,
    changed: state => states.push(state), warning: state => { warnings.push(state); notice = state; }, log: () => {},
    dismissWarning: () => { if (notice !== null) dismissed++; notice = null; },
  });
  return { monitor, states, warnings, queued,
    pollAt: async (at: number) => { now = at; return monitor.poll(); },
    get notice() { return notice; }, get dismissed() { return dismissed; },
    set ownership(v: WindowsProxyOwnership) { ownership = v; },
    set active(v: boolean) { active = v; }, set key(v: string) { key = v; },
    set failWrite(v: boolean) { failWrite = v; }, set overwritten(v: boolean) { overwritten = v; },
    set beforeRead(v: (() => Promise<void>) | null) { beforeRead = v; },
    set duringWrite(v: (() => Promise<void>) | null) { duringWrite = v; },
    get writes() { return writes; },
    flush: async () => { while (queued.length) await queued.shift()!(); },
  };
}

test("healthy settings cause no writes or warnings, including a new application session", async () => {
  const f = fixture(); f.monitor.newSession();
  for (let at = 0; at <= 60000; at += 2000) { await f.pollAt(at); await f.flush(); }
  assert.equal(f.states.at(-1), "healthy"); assert.equal(f.writes, 0); assert.deepEqual(f.warnings, []);
});

for (const mismatch of ["detached", "foreign"] as const) {
  test(`confirms and repairs ${mismatch} settings without network probes or a foreign-owner pause`, async () => {
    const f = fixture(); f.ownership = mismatch;
    assert.equal(await f.pollAt(0), 1000); assert.equal(f.writes, 0);
    await f.pollAt(1000); assert.equal(f.states.at(-1), "repairing");
    await f.flush(); assert.equal(f.writes, 1); assert.equal(f.states.at(-1), "healthy");
  });
}

test("continued overwrites are retried without requiring a stable healthy period", async () => {
  const f = fixture(); f.ownership = "foreign"; f.overwritten = true;
  await f.pollAt(0); await f.pollAt(1000); await f.flush();
  for (let at = 3000; at <= 41000; at += 2000) { await f.pollAt(at); await f.flush(); }
  assert.equal(f.writes, 5); assert.deepEqual(f.warnings, ["retrying"]);
  f.overwritten = false;
  for (let at = 43000; at <= 51000; at += 2000) { await f.pollAt(at); await f.flush(); }
  assert.equal(f.writes, 6); assert.equal(f.states.at(-1), "healthy");
  assert.equal(f.notice, null); assert.equal(f.dismissed, 1);
});

test("brief healthy readings cannot bypass the write cooldown", async () => {
  const f = fixture(); f.ownership = "detached";
  await f.pollAt(0); await f.pollAt(1000); await f.flush();
  await f.pollAt(2000); f.ownership = "foreign";
  await f.pollAt(3000); await f.pollAt(4000); await f.flush(); assert.equal(f.writes, 1);
  for (let at = 5000; at <= 11000; at += 2000) { await f.pollAt(at); await f.flush(); }
  assert.equal(f.writes, 2);
});

test("turning Route off immediately cancels queued writes and clears notices", async () => {
  const f = fixture(); f.ownership = "foreign";
  await f.pollAt(0); await f.pollAt(1000);
  f.active = false; f.monitor.stop(); await f.flush();
  for (let at = 3000; at <= 30000; at += 2000) { await f.pollAt(at); await f.flush(); }
  assert.equal(f.writes, 0); assert.equal(f.states.at(-1), "inactive"); assert.deepEqual(f.warnings, []);
});

test("stale reads cannot enqueue a repair after the master switch is turned off", async () => {
  const f = fixture(); f.ownership = "foreign"; await f.pollAt(0);
  let release!: () => void;
  f.beforeRead = () => new Promise<void>(resolve => { release = resolve; });
  const reading = f.pollAt(1000); await Promise.resolve(); await Promise.resolve();
  f.active = false; f.monitor.stop(); release(); await reading; await f.flush();
  assert.equal(f.writes, 0); assert.equal(f.states.at(-1), "inactive");
});

test("a stop and new session cannot revive a stale queued repair", async () => {
  const f = fixture(); f.ownership = "foreign";
  await f.pollAt(0); await f.pollAt(1000);
  f.active = false; f.monitor.stop(); f.active = true; f.key = "service-2"; f.monitor.newSession();
  await f.flush(); assert.equal(f.writes, 0);
  await f.pollAt(2000); await f.pollAt(3000); await f.flush(); assert.equal(f.writes, 1);
});

test("TUN or a profile change invalidates a queued write", async () => {
  for (const change of ["tun", "profile"] as const) {
    const f = fixture(); f.ownership = "foreign"; await f.pollAt(0); await f.pollAt(1000);
    if (change === "tun") f.active = false; else f.key = "profile-2";
    await f.flush(); assert.equal(f.writes, 0);
  }
});

test("a changed external endpoint while waiting is repaired; a restored or unreadable endpoint is not", async () => {
  for (const reading of ["foreign", "owned", "unknown"] as const) {
    const f = fixture(); f.ownership = "detached"; await f.pollAt(0); await f.pollAt(1000);
    f.ownership = reading; await f.flush(); assert.equal(f.writes, reading === "foreign" ? 1 : 0);
  }
});

test("unknown registry readings never authorize writes and do not permanently disable later recovery", async () => {
  const f = fixture(); f.ownership = "unknown";
  for (let at = 0; at <= 10000; at += 2000) await f.pollAt(at);
  assert.equal(f.writes, 0); assert.equal(f.states.at(-1), "unknown");
  f.ownership = "foreign"; await f.pollAt(12000); await f.pollAt(13000); await f.flush(); assert.equal(f.writes, 1);
});

test("a timed-out RPC is read back and retried only after cooldown; a late success causes no write", async () => {
  const f = fixture(); f.ownership = "detached"; f.failWrite = true;
  await f.pollAt(0); await f.pollAt(1000); await f.flush(); assert.equal(f.states.at(-1), "unknown");
  f.failWrite = false;
  for (let at = 3000; at <= 9000; at += 2000) { await f.pollAt(at); await f.flush(); }
  assert.equal(f.writes, 1);
  f.ownership = "owned"; await f.pollAt(11000); await f.flush(); assert.equal(f.writes, 1);
  f.ownership = "foreign"; await f.pollAt(13000); await f.pollAt(14000); await f.flush(); assert.equal(f.writes, 2);
});

test("a slow pending RPC is never duplicated and stop suppresses its stale result", async () => {
  const f = fixture(); f.ownership = "foreign";
  let release!: () => void;
  f.duringWrite = () => new Promise<void>(resolve => { release = resolve; });
  await f.pollAt(0); await f.pollAt(1000);
  const writing = f.flush(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  for (let at = 3000; at <= 31000; at += 2000) await f.pollAt(at);
  assert.equal(f.writes, 1); assert.equal(f.queued.length, 0);
  f.active = false; f.monitor.stop(); release(); await writing;
  assert.equal(f.states.at(-1), "inactive"); assert.equal(f.writes, 1);
});

test("confirmation cannot span a service change or an unobserved sleep gap", async () => {
  const f = fixture(); f.ownership = "foreign";
  await f.pollAt(0); f.key = "service-2"; await f.pollAt(1000); assert.equal(f.queued.length, 0);
  await f.pollAt(100000); assert.equal(f.queued.length, 0); assert.deepEqual(f.warnings, []);
  await f.pollAt(101000); await f.flush(); assert.equal(f.writes, 1);
});

test("a delayed queue starts its cooldown at actual dispatch", async () => {
  const f = fixture(); f.ownership = "foreign"; f.overwritten = true;
  await f.pollAt(0); await f.pollAt(1000);
  await f.pollAt(21000); await f.flush(); assert.equal(f.writes, 1);
  for (let at = 23000; at <= 29000; at += 2000) { await f.pollAt(at); await f.flush(); }
  assert.equal(f.writes, 1);
  await f.pollAt(31000); await f.flush(); assert.equal(f.writes, 2);
});
