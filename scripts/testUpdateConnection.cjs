// Runs the production connection helper in Electron, without opening an app window.
// All HTTP(S) targets and proxies are temporary loopback servers.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { app, session } = require("electron");
const ts = require("typescript");

const directory = mkdtempSync(join(tmpdir(), "mxh-route-update-network-"));
app.setPath("userData", join(directory, "user-data"));
app.disableHardwareAcceleration();
const servers = [];
const sockets = new Set();
const body = Buffer.alloc(128 * 1024, 42);
const hits = { target: 0, httpProxy: 0, httpsProxy: 0, socksProxy: 0 };

function cleanup() {
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
  // All files are generated in this test's mkdtemp directory.
  rmSync(join(directory, "test.key"), { force: true });
  rmSync(join(directory, "test.crt"), { force: true });
  try { rmSync(directory, { recursive: true, force: true }); }
  catch { console.warn("The test runtime still holds its temporary user-data directory open."); }
}

async function listen(server) {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function proxyHandler(kind) {
  return (request, response) => {
    hits[kind] += 1;
    const upstream = http.request(request.url, { method: request.method, headers: request.headers }, (incoming) => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on("error", () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  };
}

function tunnel(server, kind) {
  server.on("connect", (request, client, head) => {
    hits[kind] += 1;
    const target = new URL(`http://${request.url}`);
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
}

app.whenReady().then(async () => {
  const compiled = ts.transpileModule(readFileSync(join(__dirname, "../src/main/updateConnection.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modulePath = join(directory, "updateConnection.cjs");
  writeFileSync(modulePath, compiled);
  const { UpdateConnection } = require(modulePath);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(directory, "test.key"), "-out", join(directory, "test.crt")], { stdio: "ignore" });
  const tls = { key: readFileSync(join(directory, "test.key")), cert: readFileSync(join(directory, "test.crt")) };
  const handleTarget = (request, response) => {
    hits.target += 1;
    if (request.url === "/releases") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify([{ tag_name: "test" }]));
    } else if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/installer" });
      response.end();
    } else {
      response.setHeader("Content-Length", body.length);
      response.write(body.subarray(0, 65536));
      setTimeout(() => response.end(body.subarray(65536)), 20);
    }
  };
  const targetPort = await listen(http.createServer(handleTarget));
  const tlsTargetPort = await listen(https.createServer(tls, handleTarget));
  const httpProxy = http.createServer(proxyHandler("httpProxy"));
  tunnel(httpProxy, "httpProxy");
  const httpPort = await listen(httpProxy);
  const httpsProxy = https.createServer(tls, proxyHandler("httpsProxy"));
  tunnel(httpsProxy, "httpsProxy");
  const httpsPort = await listen(httpsProxy);
  const socksPort = await listen(net.createServer((client) => {
    let data = Buffer.alloc(0);
    let greeted = false;
    const receive = (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (!greeted) {
        if (data.length < 2 || data.length < 2 + data[1]) return;
        assert.equal(data[0], 5);
        data = data.subarray(2 + data[1]);
        greeted = true;
        client.write(Buffer.from([5, 0]));
      }
      if (data.length < 5) return;
      const kind = data[3];
      const length = kind === 1 ? 4 : kind === 3 ? 1 + data[4] : 16;
      if (data.length < 4 + length + 2) return;
      assert.equal(data[1], 1);
      assert.ok(kind === 1 || kind === 3);
      const host = kind === 1 ? [...data.subarray(4, 8)].join(".") : data.subarray(5, 4 + length).toString();
      const port = data.readUInt16BE(4 + length);
      const remainder = data.subarray(6 + length);
      client.removeListener("data", receive);
      hits.socksProxy += 1;
      const upstream = net.connect(port, host, () => {
        client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        upstream.write(remainder);
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
    };
    client.on("data", receive);
  }));

  const isolated = session.fromPartition("mxh-route-update-network-test", { cache: false });
  // Trust only this test's exact ephemeral certificate, only in the test session.
  isolated.setCertificateVerifyProc((request, callback) => {
    callback(request.hostname === "127.0.0.1" && request.certificate.data.trim() === tls.cert.toString().trim() ? 0 : -3);
  });
  const network = new UpdateConnection(() => isolated);
  const target = `http://127.0.0.1:${targetPort}`;
  const tlsTarget = `https://127.0.0.1:${tlsTargetPort}`;
  const defaultProxyBefore = await session.defaultSession.resolveProxy(target);
  for (const proxy of ["", `http://127.0.0.1:${httpPort}`, `https://127.0.0.1:${httpsPort}`, `socks5://127.0.0.1:${socksPort}`]) {
    await network.run(proxy, async (fetchUpdate) => {
      const request = (url) => fetchUpdate(url, { signal: AbortSignal.timeout(10000) });
      assert.deepEqual(await (await request(`${target}/releases`)).json(), [{ tag_name: "test" }]);
      assert.deepEqual(Buffer.from(await (await request(`${target}/redirect`)).arrayBuffer()), body);
      assert.deepEqual(Buffer.from(await (await request(`${tlsTarget}/redirect`)).arrayBuffer()), body);
    });
    console.log(`PASS: ${proxy === "" ? "direct" : new URL(proxy).protocol} release query, redirects and streamed HTTP(S) download`);
  }
  for (const kind of ["httpProxy", "httpsProxy", "socksProxy"]) assert.ok(hits[kind] >= 3, kind);
  await new Promise((resolve) => httpProxy.close(resolve));
  const beforeFailure = hits.target;
  await assert.rejects(network.run(`http://127.0.0.1:${httpPort}`, (fetchUpdate) => fetchUpdate(`${target}/releases`, { signal: AbortSignal.timeout(10000) })));
  assert.equal(hits.target, beforeFailure);
  await network.run("", async (fetchUpdate) => assert.equal((await fetchUpdate(`${target}/releases`)).status, 200));
  assert.equal(await session.defaultSession.resolveProxy(target), defaultProxyBefore);
  console.log(`PASS: unavailable proxy fails without direct fallback; clearing restores direct; default session unchanged\n${JSON.stringify(hits)}`);
}).then(() => { cleanup(); app.exit(0); }, (error) => { console.error(error); cleanup(); app.exit(1); });
