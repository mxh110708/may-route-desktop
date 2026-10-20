import assert from "node:assert/strict";
import test from "node:test";
import { PriorityActivity, type PriorityActivityConnection, type PriorityActivityEvent } from "./priorityActivity";

const groups = [{ tag: "West", nodes: ["w1", "w2", "shared"] }, { tag: "HK", nodes: ["h1", "shared"] }];
const connection = (id: string, chainList = ["West"], patch: Partial<PriorityActivityConnection> = {}): PriorityActivityConnection =>
  ({ id, inbound: "mixed-in", source: "127.0.0.1:43210", outbound: "w1", chainList, ...patch });
const event = (id: string, chainList?: string[], patch?: Partial<PriorityActivityConnection>): PriorityActivityEvent =>
  ({ type: 0, id, connection: connection(id, chainList, patch) });
const setup = () => { const activity = new PriorityActivity(); activity.configure(groups); return activity; };

test("only regions used by traffic become active, including simultaneous business routes", () => {
  const a = setup(); a.ingest({ reset: true, events: [event("AI")] }, 0);
  assert.deepEqual(a.active(0), ["West"]);
  a.ingest({ reset: false, events: [event("web", ["Web", "HK"], { outbound: "h1" })] }, 1000);
  assert.deepEqual(a.active(1000), ["West", "HK"]);
  a.ingest({ reset: false, events: [{ type: 1, id: "AI", uplinkDelta: 1n }] }, 60000);
  assert.deepEqual(a.active(62000), ["West"]);
});

test("idle sockets and zero-byte updates do not keep unused regions alive", () => {
  const a = setup(); a.ingest({ reset: true, events: [event("one")] }, 0);
  a.ingest({ reset: false, events: [{ type: 1, id: "one", connection: connection("one"), uplinkDelta: 0n }] }, 60000);
  assert.deepEqual(a.active(60001), []);
  a.ingest({ reset: false, events: [{ type: 1, id: "one", downlinkDelta: 5n }] }, 70000);
  assert.deepEqual(a.active(70000), ["West"]);
  a.ingest({ reset: false, events: [{ type: 2, id: "one", closedAt: 71000n }] }, 71000);
  assert.equal(a.retainedConnections, 0);
  assert.deepEqual(a.active(131001), []);
});

test("own candidate and system-proxy health checks never activate a region", () => {
  const a = setup(); a.ignoreSource(43210, 1000);
  a.ingest({ reset: true, events: [event("candidate", ["West"], { inbound: "may-priority-probe-0" }), event("health")] }, 1000);
  assert.deepEqual(a.active(1000), []); assert.equal(a.retainedConnections, 0);
  a.ingest({ reset: false, events: [event("business", ["HK"], { source: "127.0.0.1:43211", outbound: "h1" })] }, 1000);
  assert.deepEqual(a.active(1000), ["HK"]);
});

test("connection history cannot activate old regions or move fresh activity backwards", () => {
  const a = setup();
  a.ingest({ reset: true, events: [event("old", ["HK"], { closedAt: 1000n }), event("live")] }, 100000);
  a.ingest({ reset: false, events: [{ type: 2, id: "history", connection: connection("history", ["West"], { closedAt: 50000n }) }] }, 100000);
  assert.deepEqual(a.active(130000), ["West"]); assert.equal(a.retainedConnections, 1);
});

test("explicit chain resolves shared nodes; bare concrete nodes cannot invent selector usage", () => {
  const a = setup(); a.ingest({ reset: true, events: [event("ambiguous", [], { outbound: "shared" })] }, 1);
  assert.deepEqual(a.active(1), []);
  a.ingest({ reset: false, events: [event("explicit", ["AI", "West", "HK"], { outbound: "shared" })] }, 2);
  assert.deepEqual(a.active(2), ["West", "HK"]);
  a.reset(); a.ingest({ reset: true, events: [event("unique", [], { outbound: "h1" })] }, 3);
  assert.deepEqual(a.active(3), []);
  a.ingest({ reset: false, events: [event("selector", [], { outbound: "HK" })] }, 4);
  assert.deepEqual(a.active(4), ["HK"]);
});

test("stream reset and profile replacement release old IDs and region state", () => {
  const a = setup(); a.ingest({ reset: true, events: [event("old")] }, 0);
  a.disconnected(); assert.equal(a.retainedConnections, 0); assert.equal(a.available, false);
  assert.deepEqual(a.active(1), ["West"]); // retain only the bounded activity grace
  a.ingest({ reset: true, events: [] }, 1);
  assert.equal(a.retainedConnections, 0); assert.deepEqual(a.active(1), []);
  a.configure([{ tag: "Europe", nodes: ["e1"] }]);
  assert.equal(a.available, false);
  a.ingest({ reset: false, events: [event("old"), event("new", ["Europe"], { outbound: "e1" })] }, 2);
  assert.deepEqual(a.active(2), ["Europe"]); assert.equal(a.retainedConnections, 1);
});

test("a business exit using an explicit entry detour activates that entry without guessing from its node", () => {
  const a = setup();
  a.configure(groups, JSON.stringify({ outbounds: [{ tag: "att-exit", type: "shadowsocks", detour: "West" }] }));
  a.ingest({ reset: true, events: [event("AI", ["att-exit", "AI Services"], { outbound: "att-exit" })] }, 0);
  assert.deepEqual(a.active(0), ["West"]);
  a.ingest({ reset: false, events: [{ type: 1, id: "AI", downlinkDelta: 5n }] }, 60000);
  assert.deepEqual(a.active(61000), ["West"]);
  assert.deepEqual(a.active(120001), []);
  a.ingest({ reset: false, events: [event("direct-node", [], { outbound: "h1" })] }, 120001);
  assert.deepEqual(a.active(120001), []);
});

test("nested fixed detours resolve independently, cycles and unused selector members do not create activity", () => {
  const a = setup();
  a.configure(groups, JSON.stringify({ outbounds: [
    { tag: "exit", detour: "bridge" }, { tag: "bridge", detour: "West" }, { tag: "hk-exit", detour: "HK" },
    { tag: "cycle-a", detour: "cycle-b" }, { tag: "cycle-b", detour: "cycle-a" },
    { tag: "Business", type: "selector", outbounds: ["West", "HK"] },
  ] }));
  a.ingest({ reset: true, events: [event("unknown", ["Business", "cycle-a"], { outbound: "missing" })] }, 0);
  assert.deepEqual(a.active(0), []);
  a.ingest({ reset: false, events: [event("AI", ["Business", "exit"], { outbound: "exit" }), event("web", ["hk-exit"], { outbound: "hk-exit" })] }, 1);
  assert.deepEqual(a.active(1), ["West", "HK"]);
});

test("probe exclusions apply before fixed-detour activity and configuration replacement drops old detours", () => {
  const a = setup(), content = JSON.stringify({ outbounds: [{ tag: "exit", detour: "West" }] });
  a.configure(groups, content); a.ignoreSource(43210, 0);
  a.ingest({ reset: true, events: [event("probe", ["exit"], { inbound: "may-priority-probe-0", source: "127.0.0.1:43211" }), event("health", ["exit"])] }, 0);
  assert.deepEqual(a.active(0), []);
  a.configure(groups, '{"outbounds":[]}');
  a.ingest({ reset: true, events: [event("stale", ["exit"], { outbound: "exit" })] }, 1);
  assert.deepEqual(a.active(1), []);
});
