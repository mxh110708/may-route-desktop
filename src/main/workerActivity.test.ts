import assert from "node:assert/strict";
import test from "node:test";
import type { Transport } from "@connectrpc/connect";

import { WorkerActivity } from "./workerActivity";
import { BackgroundIdleGate } from "./backgroundIdle";

function fixture(unary: () => Promise<unknown>, stream: () => Promise<unknown> = unary) {
  const activity = new WorkerActivity();
  const transport = activity.track({ unary, stream } as unknown as Transport);
  return { activity,
    unary: (signal?: AbortSignal) => transport.unary({} as never, signal, undefined, new Headers(), {} as never, {} as never),
    stream: (signal?: AbortSignal) => transport.stream({} as never, signal, undefined, new Headers(), (async function* () {})(), {} as never),
  };
}

test("a pending unary operation blocks worker retirement until settlement", async () => {
  let finish!: () => void;
  const f = fixture(() => new Promise<void>((resolve) => { finish = resolve; }));
  const pending = f.unary();
  assert.equal(f.activity.busy, true);
  finish(); await pending;
  assert.equal(f.activity.busy, false);
});

test("stream headers do not end activity; consumption and early return release it", async () => {
  const f = fixture(async () => {}, async () => ({ message: (async function* () { yield 1; yield 2; })() }));
  const response = await f.stream();
  assert.equal(f.activity.busy, true);
  for await (const _message of response.message) break;
  assert.equal(f.activity.busy, false);
  const second = await f.stream();
  for await (const _message of second.message) { /* consume all */ }
  assert.equal(f.activity.busy, false);
});

test("failures and already-cancelled requests cannot leak activity or spawn a worker", async () => {
  let calls = 0;
  const f = fixture(async () => { calls += 1; throw new Error("failed"); });
  await assert.rejects(f.unary(), /failed/);
  await assert.rejects(f.stream(), /failed/);
  assert.equal(f.activity.busy, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.unary(controller.signal), { name: "AbortError" });
  await assert.rejects(f.stream(controller.signal), { name: "AbortError" });
  assert.equal(calls, 2);
  assert.equal(f.activity.busy, false);
});

test("a command completing during idle resumes service observation; cancelling an observer does not", async () => {
  const gate = new BackgroundIdleGate();
  const activity = new WorkerActivity(() => gate.resume());
  let finish!: () => void;
  const transport = activity.track({
    unary: () => new Promise<void>((resolve) => { finish = resolve; }),
    stream: async () => ({ message: (async function* () { yield 1; })() }),
  } as unknown as Transport);
  const args = [{} as never, undefined, undefined, new Headers(), {} as never, {} as never] as const;
  const pending = transport.unary(...args);
  gate.suspend();
  finish(); await pending;
  assert.equal(gate.paused, false);

  const abort = new AbortController();
  const response = await transport.stream(args[0], abort.signal, undefined, new Headers(), (async function* () {})(), args[5]);
  gate.suspend(); abort.abort();
  for await (const _message of response.message) { /* finish aborted observer */ }
  assert.equal(gate.paused, true);
  assert.equal(activity.busy, false);
});
