// Explicit loopback fixture: uses production preparation and failover decisions,
// but never connects to the installed daemon or writes OS proxy settings.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { performance } from "node:perf_hooks";
import { buildRuntimeConfig } from "../src/main/runtimeConfig";
import { addProbeRoutes, PriorityFailover } from "../src/main/priorityFailover";
import { DEFAULT_PRIORITY_SETTINGS } from "../src/main/prioritySettings";

const [action, file] = process.argv.slice(2);
const m = JSON.parse(readFileSync(file, "utf8"));
assert(m.SyntheticOnly && file.replaceAll("\\", "/").includes("/.codex-tmp/"));
const settings = { ...DEFAULT_PRIORITY_SETTINGS, group: "US-West-LA Entry", order: ["bad", "good"], failureRounds: 2, backupSuccessRounds: 1, groupLatencyCeilings: { "US-West-LA Entry": 0 } };
if (action === "prepare") {
  const raw = readFileSync(m.Source, "utf8");
  const input = JSON.parse(raw);
  input.inbounds.push({type: "tun", tag: "fixture-unopened-tun", auto_route: true});
  const config = JSON.parse(buildRuntimeConfig(JSON.stringify(input), "system-proxy"));
  // Service ownership/OS proxy code is deliberately outside this fixture.
  config.inbounds = config.inbounds.filter((i: {type: string}) => i.type !== "tun");
  for (const input of config.inbounds) input.set_system_proxy = false;
  const prepared = addProbeRoutes(JSON.stringify(config), m.ProbePorts, settings, true);
  for (const before of JSON.parse(raw).outbounds.filter((o: any) => o.transport?.type === "xhttp")) {
    assert.deepEqual(JSON.parse(prepared.content).outbounds.find((o: any) => o.tag === before.tag), before);
  }
  writeFileSync(m.Config, prepared.content);
  writeFileSync(m.Candidates, JSON.stringify(prepared.candidates));
} else if (action === "failover") {
  const candidates: {tag: string; port: number}[] = JSON.parse(readFileSync(m.Candidates, "utf8"));
  const probe = (port: number) => new Promise<boolean>(resolve => {
    const r = request({hostname: "127.0.0.1", port, path: m.HealthUrl, method: "GET", headers: {Connection: "close"}}, response => {
      let text = ""; response.on("data", b => text += b); response.on("end", () => resolve(response.statusCode === 200 && text === "198.51.100.22"));
    });
    r.on("error", () => resolve(false)); r.setTimeout(1200, () => r.destroy()); r.end();
  });
  const failover = new PriorityFailover(["bad", "good"], settings); failover.observeSelection("bad");
  let selected: string | null = null;
  for (let round = 0; round < 2; round++) {
    const results = new Map(await Promise.all(candidates.map(async c => [c.tag, await probe(c.port)] as const)));
    assert.equal(results.get("bad"), false); assert.equal(results.get("good"), true);
    selected = failover.record(results, performance.now());
    if (round === 0) assert.equal(selected, null);
  }
  assert.equal(selected, "good");
  const response = await fetch(m.Api + "/proxies/" + encodeURIComponent(settings.group), {method: "PUT", headers: {Authorization: "Bearer " + m.Secret, "Content-Type": "application/json"}, body: JSON.stringify({name: selected})});
  assert.equal(response.status, 204); failover.switched(selected!, performance.now());
  const state = await fetch(m.Api + "/proxies/" + encodeURIComponent(settings.group), {headers: {Authorization: "Bearer " + m.Secret}}).then(r => r.json());
  assert.equal((state as {now: string}).now, "good");
  console.log("PASS: production Route probe routes and confirmed failover selected authenticated XHTTP backup");
} else throw Error("Unknown fixture action");
