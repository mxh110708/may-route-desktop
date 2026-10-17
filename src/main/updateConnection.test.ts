import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeUpdateProxyAddress,
  UpdateConnection,
  type UpdateNetworkSession,
} from "./updateConnection";

test("update proxy normalization accepts direct, HTTP, HTTPS, SOCKS5 and IPv6", () => {
  for (const [input, expected] of [
    ["  ", ""],
    [" http://LOCALHOST:2080/ ", "http://localhost:2080"],
    ["http://proxy.example", "http://proxy.example:80"],
    ["https://proxy.example/", "https://proxy.example:443"],
    ["socks5://127.0.0.1", "socks5://127.0.0.1:1080"],
    ["socks5://[::1]:1081", "socks5://[::1]:1081"],
  ]) {
    assert.equal(normalizeUpdateProxyAddress(input), expected);
  }
});

test("invalid addresses and proxy-rule injection never enter the network configuration", () => {
  for (const input of [
    null, false, 2080, {}, "127.0.0.1:2080", "ftp://example.com", "socks4://localhost",
    "http://", "http://localhost:0", "http://localhost:65536", "http://user:pass@localhost",
    "socks5://user@localhost", "http://localhost/path", "http://localhost/path/..",
    "http://localhost?", "http://localhost#", "http://localhost\\path",
    "http://localhost;https=direct://", "http://localhost,direct://",
    "http://localhost\n:2080", "http://bad_host", "http://[::z]:80",
    `http://${"a".repeat(2048)}`,
  ]) {
    assert.throws(() => normalizeUpdateProxyAddress(input), /^Error: Invalid update proxy address$/);
  }
});

function fixture(fetch: UpdateNetworkSession["fetch"] = async () => new Response("ok")) {
  const calls: unknown[] = [];
  let created = 0;
  const session: UpdateNetworkSession = {
    async closeAllConnections() { calls.push("close"); },
    async setProxy(config) { calls.push(config); },
    fetch,
  };
  const connection = new UpdateConnection(() => { created += 1; return session; });
  return { connection, session, calls, created: () => created };
}

test("blank forces direct mode; an explicit proxy has no DIRECT fallback", async () => {
  const f = fixture();
  await f.connection.run("", async (fetchUpdate) => assert.equal(await (await fetchUpdate("https://example.com")).text(), "ok"));
  await f.connection.run("socks5://localhost:1080", async () => {});
  assert.equal(f.created(), 1);
  assert.deepEqual(f.calls, [
    "close", { mode: "direct" }, "close",
    "close", { mode: "fixed_servers", proxyRules: "socks5://localhost:1080", proxyBypassRules: "<-loopback>" }, "close",
  ]);
});

test("validation happens before creating a network session", () => {
  const f = fixture();
  assert.throws(() => f.connection.run("http://user:secret@localhost", async () => {}));
  assert.equal(f.created(), 0);
});

test("proxy errors propagate without retrying directly, and the next operation can recover", async () => {
  let requests = 0;
  const f = fixture(async () => { requests += 1; throw new Error("proxy unavailable"); });
  await assert.rejects(f.connection.run("http://localhost:2080", (fetchUpdate) => fetchUpdate("https://example.com")), /proxy unavailable/);
  assert.equal(requests, 1);
  assert.equal(f.calls.filter((value) => typeof value === "object" && value !== null && "mode" in value && value.mode === "direct").length, 0);
  await f.connection.run("", async () => {});
  assert.equal(f.created(), 1);
});

test("a connection remains alive until its entire response body is consumed", async () => {
  let releaseBody!: () => void;
  const bodyReady = new Promise<void>((resolve) => { releaseBody = resolve; });
  let bodyStarted!: () => void;
  const reading = new Promise<void>((resolve) => { bodyStarted = resolve; });
  const f = fixture(async () => new Response(new ReadableStream({
    async start(controller) {
      bodyStarted();
      await bodyReady;
      controller.enqueue(new TextEncoder().encode("installer"));
      controller.close();
    },
  })));
  const download = f.connection.run("http://localhost:2080", async (fetchUpdate) => (await fetchUpdate("https://example.com/installer")).text());
  await reading;
  assert.equal(f.calls.length, 2);
  releaseBody();
  assert.equal(await download, "installer");
  assert.equal(f.calls.at(-1), "close");
});

test("queued operations cannot change the proxy while an earlier download is active", async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const active = new Promise<void>((resolve) => { started = resolve; });
  const f = fixture();
  const first = f.connection.run("http://localhost:2080", async () => { started(); await gate; });
  const second = f.connection.run("https://proxy.example", async () => {});
  await active;
  assert.equal(f.calls.length, 2);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(f.calls, [
    "close", { mode: "fixed_servers", proxyRules: "http://localhost:2080", proxyBypassRules: "<-loopback>" }, "close",
    "close", { mode: "fixed_servers", proxyRules: "https://proxy.example:443", proxyBypassRules: "<-loopback>" }, "close",
  ]);
});

test("failure to apply a proxy or close old sockets prevents the request", async () => {
  const f = fixture();
  let requests = 0;
  f.session.setProxy = async () => { throw new Error("configuration failed"); };
  await assert.rejects(f.connection.run("http://localhost:2080", async () => { requests += 1; }), /configuration failed/);
  f.session.closeAllConnections = async () => { throw new Error("close failed"); };
  await assert.rejects(f.connection.run("", async () => { requests += 1; }), /close failed/);
  assert.equal(requests, 0);
});

test("a queued download can be cancelled before another operation releases the session", async () => {
  const f = fixture();
  let release!: () => void;
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const first = f.connection.run("", async () => { start(); await new Promise<void>((resolve) => { release = resolve; }); });
  await started;
  const controller = new AbortController();
  let requests = 0;
  const second = f.connection.run("http://localhost:2080", async () => { requests += 1; }, controller.signal);
  const rejected = assert.rejects(second, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(f.calls.length, 2);
  assert.equal(requests, 0);
  release();
  await first;
  await f.connection.run("", async () => {});
  assert.equal(requests, 0);
});
