import assert from "node:assert/strict";
import test from "node:test";

import { UpdateInstallation } from "./updateInstallation";

test("cancelling waits for download cleanup, prevents installation, and permits retry", async () => {
  const job = new UpdateInstallation();
  let cleanup!: () => void;
  let aborted = false;
  let installs = 0;
  const active = job.run(async (signal) => {
    await new Promise<void>((resolve) => {
      cleanup = resolve;
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    });
    // Even a download implementation that finishes during cancellation cannot install.
    return "installer";
  }, async () => { installs += 1; return "started"; });
  let settled = false;
  const cancelled = job.cancel().then((value) => { settled = true; return value; });
  assert.equal(aborted, true);
  await Promise.resolve();
  assert.equal(settled, false);
  await assert.rejects(job.run(async () => "second", async () => "started"), /already in progress/);
  cleanup();
  assert.equal(await active, "cancelled");
  assert.equal(await cancelled, true);
  assert.equal(installs, 0);
  assert.equal(await job.run(async () => "installer", async () => { installs += 1; return "started"; }), "started");
  assert.equal(installs, 1);
});

test("once installer handoff begins cancellation cannot misreport it as cancelled", async () => {
  const job = new UpdateInstallation();
  let handoff!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { handoff = resolve; });
  const active = job.run(async () => "installer", async () => {
    handoff();
    await new Promise<void>((resolve) => { finish = resolve; });
    return "started";
  });
  await started;
  assert.equal(await job.cancel(), false);
  finish();
  assert.equal(await active, "started");
  assert.equal(await job.cancel(), false);
});

test("ordinary network and installer errors stay visible and release the job", async () => {
  const job = new UpdateInstallation();
  await assert.rejects(job.run(async () => { throw new Error("network failure"); }, async () => "started"), /network failure/);
  await assert.rejects(job.run(async () => "installer", async () => { throw new Error("signature mismatch"); }), /signature mismatch/);
  assert.equal(await job.run(async () => "installer", async () => "started"), "started");
});
