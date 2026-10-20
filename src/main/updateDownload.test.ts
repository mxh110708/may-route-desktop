import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { downloadUpdateFile } from "./updateDownload";

const payload = Buffer.alloc(128 * 1024, 42);

async function fixture(handler: RequestListener) {
  const directory = await mkdtemp(join(tmpdir(), "may-route-update-download-"));
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const controller = new AbortController();
  const options = {
    directory, url: `http://127.0.0.1:${address.port}/installer.exe`, fileSize: payload.length,
    fetchUpdate: fetch, signal: controller.signal, userAgent: "update-test", onProgress: (_value: number) => {}, retryDelayMilliseconds: 1,
  };
  return { directory, controller, options, async close() {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}

test("complete installers are committed atomically and may be reused without a request", async () => {
  let requests = 0;
  const f = await fixture((_req, res) => { requests += 1; res.end(payload); });
  try {
    await writeFile(join(f.directory, "stale.download"), "partial");
    const path = await downloadUpdateFile(f.options);
    assert.deepEqual(await readFile(path), payload);
    assert.deepEqual(await readdir(f.directory), ["installer.exe"]);
    assert.equal(await downloadUpdateFile(f.options), path);
    assert.equal(requests, 1);
  } finally { await f.close(); }
});

test("cancellation while connecting aborts promptly and leaves no update files", async () => {
  let received!: () => void;
  const requested = new Promise<void>((resolve) => { received = resolve; });
  const f = await fixture(() => received());
  try {
    const active = downloadUpdateFile(f.options);
    const rejected = assert.rejects(active, { name: "AbortError" });
    await requested;
    f.controller.abort();
    await rejected;
    assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.close(); }
});

test("cancellation mid-stream closes and removes the partial file", async () => {
  const f = await fixture((_req, res) => {
    res.setHeader("Content-Length", payload.length);
    res.write(payload.subarray(0, 32768));
  });
  try {
    let progress!: () => void;
    const reading = new Promise<void>((resolve) => { progress = resolve; });
    f.options.onProgress = (value) => { if (value > 0) progress(); };
    const active = downloadUpdateFile(f.options);
    const rejected = assert.rejects(active, { name: "AbortError" });
    await reading;
    f.controller.abort();
    await rejected;
    assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.close(); }
});

test("a dropped stream resumes on the same fetch using Range and the original ETag", async () => {
  const ranges: (string | undefined)[] = [];
  const f = await fixture((req, res) => {
    ranges.push(req.headers.range);
    if (ranges.length === 1) {
      res.writeHead(200, { "Content-Length": payload.length, ETag: '"fixture"' });
      res.write(payload.subarray(0, 32768));
      setTimeout(() => res.destroy(), 30);
    } else {
      assert.equal(req.headers["if-range"], '"fixture"');
      const offset = Number(req.headers.range?.match(/^bytes=(\d+)-$/u)?.[1]);
      assert.ok(offset > 0);
      res.writeHead(206, { "Content-Range": `bytes ${offset}-${payload.length - 1}/${payload.length}`, "Content-Length": payload.length - offset });
      res.end(payload.subarray(offset));
    }
  });
  try {
    const path = await downloadUpdateFile(f.options);
    assert.deepEqual(await readFile(path), payload);
    assert.equal(ranges.length, 2);
    assert.equal(ranges[0], undefined);
    assert.ok(ranges[1]?.startsWith("bytes="));
  } finally { await f.close(); }
});

test("an ignored Range safely restarts rather than appending a complete response", async () => {
  let requests = 0;
  const f = await fixture((_req, res) => {
    requests += 1;
    res.writeHead(200, { "Content-Length": payload.length, ETag: '"fixture"' });
    if (requests === 1) {
      res.write(payload.subarray(0, 32768));
      setTimeout(() => res.destroy(), 30);
    } else res.end(payload);
  });
  try { assert.deepEqual(await readFile(await downloadUpdateFile(f.options)), payload); }
  finally { await f.close(); }
});

test("invalid resumed ranges and truncated payloads never leave an installable file", async () => {
  let requests = 0;
  const f = await fixture((_req, res) => {
    requests += 1;
    if (requests === 1) {
      res.writeHead(200, { "Content-Length": payload.length, ETag: '"fixture"' });
      res.write(payload.subarray(0, 32768));
      setTimeout(() => res.destroy(), 30);
    } else {
      res.writeHead(206, { "Content-Range": `bytes 0-${payload.length - 1}/${payload.length}` });
      res.end(payload);
    }
  });
  try {
    await assert.rejects(downloadUpdateFile(f.options), /invalid update download range/);
    assert.deepEqual(await readdir(f.directory), []);
    await assert.rejects(downloadUpdateFile({ ...f.options, fetchUpdate: async () => new Response("partial") }), /truncated/);
    assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.close(); }
});

test("retryable HTTP errors are bounded; cancellation interrupts retry backoff", async () => {
  let requests = 0;
  const f = await fixture((_req, res) => { requests += 1; res.writeHead(503); res.end(); });
  try {
    await assert.rejects(downloadUpdateFile(f.options), /HTTP 503/);
    assert.equal(requests, 3);
    const active = downloadUpdateFile({ ...f.options, retryDelayMilliseconds: 10_000 });
    const rejected = assert.rejects(active, { name: "AbortError" });
    setTimeout(() => f.controller.abort(), 30);
    await rejected;
    assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.close(); }
});

test("a stalled stream times out after bounded retries and removes its partial file", async () => {
  let requests = 0;
  const f = await fixture((_req, res) => {
    requests += 1;
    res.writeHead(200, { "Content-Length": payload.length });
    res.write(payload.subarray(0, 32768));
  });
  try {
    await assert.rejects(downloadUpdateFile({ ...f.options, idleTimeoutMilliseconds: 40 }), { name: "TimeoutError" });
    assert.equal(requests, 3);
    assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.close(); }
});
