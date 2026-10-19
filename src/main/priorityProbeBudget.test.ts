import assert from "node:assert/strict";
import test from "node:test";
import { PriorityProbeBudget } from "./priorityProbeBudget";
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("all regions share three probe slots and backups leave capacity for active checks", async () => {
  const budget = new PriorityProbeBudget();
  const started: string[] = [], complete: (() => void)[] = [];
  const work = (name: string) => async () => { started.push(name); await new Promise<void>(resolve => complete.push(resolve)); return true; };
  const tasks = [1, 2, 3, 4].map(i => budget.run("backup", () => true, work(`backup${i}`)));
  await drain(); assert.deepEqual(started, ["backup1", "backup2"]);
  tasks.push(budget.run("active", () => true, work("West")), budget.run("active", () => true, work("HK")));
  await drain(); assert.deepEqual(started, ["backup1", "backup2", "West"]);
  complete.shift()!(); await drain(); assert.equal(started[3], "HK");
  while (complete.length) { complete.shift()!(); await drain(); }
  await Promise.all(tasks); assert.equal(started.length, 6);
});

test("queued work from a stopped region is discarded and failures release capacity", async () => {
  const budget = new PriorityProbeBudget();
  let valid = true, staleCalls = 0;
  const release: (() => void)[] = [];
  const occupied = [1, 2, 3].map(() => budget.run("active", () => true, () => new Promise<void>(resolve => release.push(resolve))));
  const stale = budget.run("active", () => valid, async () => { staleCalls++; return true; });
  await drain(); valid = false; release.shift()!(); await drain();
  assert.equal(await stale, undefined); assert.equal(staleCalls, 0);
  for (const resolve of release) resolve(); await Promise.all(occupied); await drain();
  await assert.rejects(budget.run("active", () => true, () => { throw new Error("synthetic"); }), /synthetic/);
  assert.equal(await budget.run("backup", () => true, async () => "still works"), "still works");
});
