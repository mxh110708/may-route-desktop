// Real core connection-stream test, using only ephemeral loopback proxies and an
// isolated test RPC shell around the current core. Never uses the installed daemon
// or proxy settings. Pass the explicitly built scripts/priorityRuntimeFixture binary.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHTTPServer } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { DesktopService } from "../src/shared/gen/experimental/boxdd/desktop_service_pb";
import { StartedService } from "../src/shared/gen/daemon/started_service_pb";
import { ManagedService } from "../src/shared/gen/daemon/managed_service_pb";
import { PriorityActivity } from "../src/main/priorityActivity";
import { addProbeRoutes, allocateProbePorts } from "../src/main/priorityFailover";
import { parsePrioritySettings } from "../src/main/prioritySettings";

const directory = await mkdtemp(join(tmpdir(), "route-priority-runtime-"));
if (!process.argv[2]) throw new Error("Usage: testPriorityActivityRuntime <test RPC fixture executable>");
const core = resolve(process.argv[2]);
const sockets = new Set<Socket>(), servers: Server[] = [];
async function listen(server: Server): Promise<number> {
  servers.push(server); server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); return (server.address() as { port: number }).port;
}
async function proxy(): Promise<number> {
  const server = createHTTPServer();
  server.on("connect", (request, socket, head) => {
    const target = new URL(`http://${request.url}`);
    const upstream = connect(Number(target.port), target.hostname, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); upstream.write(head); socket.pipe(upstream).pipe(socket);
    });
    sockets.add(upstream); upstream.on("error", () => socket.destroy()); upstream.once("close", () => sockets.delete(upstream));
    socket.once("close", () => upstream.destroy());
  }); return listen(server);
}
const activity = new PriorityActivity(); activity.configure([{ tag: "West", nodes: ["w"] }, { tag: "HK", nodes: ["h"] }, { tag: "Europe", nodes: ["e"] }]);
const [rpcPort, mixedPort, probeW, probeH, probeE] = await allocateProbePorts(5);
const daemon = spawn(core, ["run", "--working-directory", directory, "--listen", `127.0.0.1:${rpcPort}`], { windowsHide: true, stdio: "ignore" });
const transport = createGrpcTransport({ baseUrl: `http://127.0.0.1:${rpcPort}` });
const desktop = createClient(DesktopService, transport), started = createClient(StartedService, transport), managed = createClient(ManagedService, transport);
const abort = new AbortController(); let stream: Promise<void> | undefined, launched = false;
const chains: string[][] = [], streamErrors: unknown[] = [];
async function wait(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 150; i++) { if (check()) return; if (daemon.exitCode !== null) throw new Error("test daemon exited"); await delay(20); }
  throw new Error(`timed out: ${label}`);
}
async function tunnel(port: number, target: number, internal = false): Promise<Socket> {
  const socket = connect(port, "127.0.0.1"); sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
  await once(socket, "connect"); if (internal) activity.ignoreSource(socket.localPort!, Date.now());
  socket.write(`CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\n\r\n`);
  const [response] = await once(socket, "data"); assert.match(String(response), /200/); socket.write("fixture"); return socket;
}
try {
  let ready = false, lastError: unknown;
  for (let i = 0; i < 100; i++) { try { await desktop.getDaemonInfo({}, { timeoutMs: 100 }); ready = true; break; } catch (error) { lastError = error; await delay(30); } }
  assert.ok(ready, `isolated daemon ready: ${String(lastError)}`);
  const targetW = await listen(createServer(socket => socket.on("data", data => socket.write(data))));
  const targetH = await listen(createServer(socket => socket.on("data", data => socket.write(data))));
  const targetE = await listen(createServer(socket => socket.on("data", data => socket.write(data))));
  const proxyW = await proxy(), proxyH = await proxy();
  const broken = createHTTPServer(); broken.on("connect", (_request, socket) => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  const proxyE = await listen(broken);
  const content = JSON.stringify({ log: { level: "error" }, inbounds: [{ type: "mixed", tag: "business", listen: "127.0.0.1", listen_port: mixedPort, set_system_proxy: false }],
    outbounds: [{ type: "selector", tag: "West", outbounds: ["w"] }, { type: "selector", tag: "HK", outbounds: ["h"] }, { type: "selector", tag: "Europe", outbounds: ["e"] },
      { type: "http", tag: "w", server: "127.0.0.1", server_port: proxyW }, { type: "http", tag: "h", server: "127.0.0.1", server_port: proxyH },
      { type: "http", tag: "e", server: "127.0.0.1", server_port: proxyE }],
    route: { rules: [{ port: [targetH], action: "route", outbound: "HK" }, { port: [targetE], action: "route", outbound: "Europe" }], final: "West" } });
  await desktop.startService({ configContent: addProbeRoutes(content, [probeW, probeH, probeE], parsePrioritySettings({ group: "West" }), true).content,
    options: { oomKillerDisabled: true } }, { timeoutMs: 10000 }); launched = true;
  stream = (async () => { try { for await (const batch of started.subscribeConnections({ interval: 100_000_000n }, { signal: abort.signal })) {
    for (const event of batch.events) if (event.connection) chains.push([...event.connection.chainList]);
    activity.ingest(batch, Date.now());
  } } catch (error) { if (!abort.signal.aborted) streamErrors.push(error); } })();
  await wait(() => activity.available, "connection stream");
  await tunnel(probeW, targetW); await tunnel(probeH, targetH); await tunnel(mixedPort, targetW, true);
  await delay(300); assert.deepEqual(activity.active(Date.now()), [], "own probes must not create activity");
  await tunnel(mixedPort, targetW); await wait(() => activity.active(Date.now()).includes("West"), "West business");
  assert.deepEqual(activity.active(Date.now()), ["West"]);
  await tunnel(mixedPort, targetH); await wait(() => activity.active(Date.now()).includes("HK"), "HK business");
  assert.deepEqual(activity.active(Date.now()), ["West", "HK"]); assert.deepEqual(streamErrors, []);
  const failed = connect(mixedPort, "127.0.0.1"); sockets.add(failed); failed.on("error", () => {}); failed.on("data", () => {});
  await once(failed, "connect"); failed.write(`CONNECT 127.0.0.1:${targetE} HTTP/1.1\r\nHost: 127.0.0.1:${targetE}\r\n\r\n`);
  await wait(() => activity.active(Date.now()).includes("Europe"), "failed initial connection still marks its used region");
  const result = { passed: true, chains, groups: activity.active(Date.now()), internalProbesExcluded: true, failedInitialConnectionRecognized: true };
  await writeFile(process.env.MXH_PRIORITY_RUNTIME_RESULT || join(directory, "result.json"), JSON.stringify(result, null, 2));
} finally {
  abort.abort(); await stream;
  if (launched) await managed.stopService({}, { timeoutMs: 2000 }).catch(() => {});
  const exited = once(daemon, "exit"); daemon.kill(); await exited;
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(server => new Promise<void>(done => server.close(() => done()))));
}
