import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { BackgroundIdleController, BackgroundIdleGate } from "./backgroundIdle";

test("the gate aborts observers, waits without polling, and wakes every waiter", async () => {
  const gate = new BackgroundIdleGate();
  const signal = gate.signal;
  gate.suspend();
  assert.equal(signal.aborted, true);
  let woke = 0;
  const a = gate.wait().then(() => { woke += 1; });
  const b = gate.wait().then(() => { woke += 1; });
  await Promise.resolve();
  assert.equal(woke, 0);
  gate.resume();
  await Promise.all([a, b]);
  assert.equal(woke, 2);
  assert.equal(gate.signal.aborted, false);
});

test("quitting can cancel a paused observer without waking background work", async () => {
  const gate = new BackgroundIdleGate();
  gate.suspend();
  const controller = new AbortController();
  const waiting = gate.wait(controller.signal);
  controller.abort();
  assert.equal(await waiting, false);
  assert.equal(gate.paused, true);
});

test("background eligibility must remain true for the idle delay", async () => {
  const gate = new BackgroundIdleGate();
  let releases = 0;
  const policy = new BackgroundIdleController(gate, async () => { releases += 1; return true; }, 10, 5);
  try {
    policy.update(true);
    policy.update(false);
    await delay(20);
    assert.equal(releases, 0);
    policy.update(true);
    await delay(25);
    assert.equal(gate.paused, true);
    assert.equal(releases, 1);
    policy.update(false);
    assert.equal(gate.paused, false);
  } finally { policy.dispose(); }
});

test("busy work is retained and retried; external tray actions wake and rearm idleness", async () => {
  const gate = new BackgroundIdleGate();
  let busy = true, releases = 0;
  const policy = new BackgroundIdleController(gate, async (idle) => {
    assert.equal(idle(), true);
    releases += 1;
    return !busy;
  }, 2, 5);
  try {
    policy.update(true);
    await delay(15);
    assert.ok(releases >= 1);
    assert.equal(gate.paused, true);
    busy = false;
    await delay(15);
    const previous = releases;
    // A native tray action need not create or show a window.
    gate.resume();
    assert.equal(gate.paused, false);
    policy.update(true);
    await delay(15);
    assert.equal(releases, previous + 1);
    assert.equal(gate.paused, true);
  } finally { policy.dispose(); }
});

test("foreground or running-service transitions invalidate pending release decisions", async () => {
  const gate = new BackgroundIdleGate();
  let decision!: () => boolean;
  let finish!: () => void;
  const policy = new BackgroundIdleController(gate, async (idle) => {
    decision = idle;
    await new Promise<void>((resolve) => { finish = resolve; });
    return idle();
  }, 2);
  try {
    policy.update(true);
    await delay(15);
    policy.update(false);
    assert.equal(decision(), false);
    assert.equal(gate.paused, false);
    finish();
    await delay(5);
    assert.equal(gate.paused, false);
  } finally { policy.dispose(); }
});
