import assert from "node:assert/strict";
import { test } from "node:test";
import { PriorityRuntimeRestore } from "./priorityRuntimeRestore";

test("a panel opening during timer restoration waits for the verified runtime", async () => {
  const restore = new PriorityRuntimeRestore();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let checks = 0, ready = false;
  const check = async () => { checks++; await gate; ready = true; };
  const timer = restore.run(check);
  let displayed: string | undefined;
  const panel = (async () => {
    await restore.run(check);
    displayed = ready ? "waiting-for-activity" : "reload-required";
  })();
  await Promise.resolve();
  assert.equal(displayed, undefined);
  assert.equal(checks, 1);
  release();
  await Promise.all([timer, panel]);
  assert.equal(displayed, "waiting-for-activity");
});

test("read failures reach every waiter and a later attempt can recover", async () => {
  const restore = new PriorityRuntimeRestore();
  const error = new Error("temporarily unreadable runtime");
  const first = restore.run(async () => { throw error; });
  const second = restore.run(async () => { assert.fail("duplicate check"); });
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every(result => result.status === "rejected" && result.reason === error));
  let recovered = false;
  await restore.run(async () => { recovered = true; });
  assert.equal(recovered, true);
});
