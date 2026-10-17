import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { setTimeout as delay } from "node:timers/promises";

import type { UpdateFetch } from "./updateConnection";

const ATTEMPTS = 3;
const IDLE_TIMEOUT = 30_000;

class DownloadHTTPError extends Error {
  constructor(readonly status: number) { super(`download update: HTTP ${status}`); }
}

function transient(error: unknown): boolean {
  if (error instanceof DownloadHTTPError) return [408, 429, 500, 502, 503, 504].includes(error.status);
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || /net::ERR_(?:CONNECTION_(?:CLOSED|RESET|TIMED_OUT|ABORTED)|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED|HTTP2_PROTOCOL_ERROR)|ECONNRESET|ETIMEDOUT|premature close|terminated|fetch failed/iu.test(error.message);
}

interface DownloadOptions {
  directory: string;
  url: string;
  fileSize: number;
  fetchUpdate: UpdateFetch;
  signal: AbortSignal;
  userAgent: string;
  onProgress(progress: number): void;
  // Tests use a short delay; production retries are bounded and stay on the same connection.
  retryDelayMilliseconds?: number;
  idleTimeoutMilliseconds?: number;
}

export async function downloadUpdateFile(options: DownloadOptions): Promise<string> {
  const { directory, url, fileSize, fetchUpdate, signal, onProgress } = options;
  signal.throwIfAborted();
  const fileName = basename(new URL(url).pathname);
  if (fileName === "" || fileName === "." || fileName === "..") throw new Error("invalid update download URL");
  await mkdir(directory, { recursive: true });
  const destination = join(directory, fileName);
  const temporary = `${destination}.download`;
  const existing = await stat(destination).catch(() => null);
  signal.throwIfAborted();
  if (existing?.isFile() && fileSize > 0 && existing.size === fileSize) {
    onProgress(1);
    return destination;
  }

  for (const entry of await readdir(directory)) {
    signal.throwIfAborted();
    await rm(join(directory, entry), { recursive: true, force: true });
  }
  let committed = false;
  let written = 0;
  let validator = "";
  try {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      signal.throwIfAborted();
      if (written > 0 && validator === "") {
        await rm(temporary, { force: true });
        written = 0;
        onProgress(0);
      }
      const controller = new AbortController();
      const requestSignal = AbortSignal.any([signal, controller.signal]);
      let timer: ReturnType<typeof setTimeout>;
      const armTimeout = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new DOMException("Update download stalled", "TimeoutError")), options.idleTimeoutMilliseconds ?? IDLE_TIMEOUT);
        timer.unref();
      };
      let response: Response | undefined;
      try {
        const headers = new Headers({ "User-Agent": options.userAgent });
        if (written > 0) {
          headers.set("Range", `bytes=${written}-`);
          headers.set("If-Range", validator);
        }
        armTimeout();
        response = await fetchUpdate(url, { headers, signal: requestSignal, cache: "no-store" });
        if (!response.ok || response.body === null) throw new DownloadHTTPError(response.status);
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get("content-range") ?? "");
          if (written === 0 || range === null || Number(range[1]) !== written || Number(range[2]) < written ||
              Number(range[2]) >= Number(range[3]) || (fileSize > 0 && Number(range[3]) !== fileSize)) {
            throw new Error("invalid update download range");
          }
          const resumedValidator = response.headers.get(validator.startsWith('"') ? "etag" : "last-modified");
          if (resumedValidator !== null && resumedValidator !== validator) throw new Error("update download changed while resuming");
        } else if (response.status === 200) {
          written = 0;
          const etag = response.headers.get("etag") ?? "";
          validator = etag.startsWith('"') ? etag : response.headers.get("last-modified") ?? "";
          onProgress(0);
        } else {
          throw new Error(`unexpected update download status: ${response.status}`);
        }
        const total = fileSize || written + Number(response.headers.get("content-length") ?? 0);
        const append = written > 0;
        await pipeline(
          Readable.fromWeb(response.body as unknown as WebReadableStream),
          async function* (source: AsyncIterable<Buffer>) {
            for await (const chunk of source) {
              signal.throwIfAborted();
              written += chunk.length;
              if (fileSize > 0 && written > fileSize) throw new Error("downloaded update exceeds its expected size");
              armTimeout();
              if (total > 0) onProgress(Math.min(written / total, 1));
              yield chunk;
            }
          },
          createWriteStream(temporary, { flags: append ? "a" : "w" }),
          { signal: requestSignal },
        );
        if (fileSize > 0 && written !== fileSize) throw new Error(`downloaded update is truncated: ${written} of ${fileSize} bytes`);
        signal.throwIfAborted();
        await rename(temporary, destination);
        committed = true;
        signal.throwIfAborted();
        onProgress(1);
        return destination;
      } catch (error) {
        signal.throwIfAborted();
        const cause = controller.signal.aborted ? controller.signal.reason as unknown : error;
        if (attempt + 1 >= ATTEMPTS || !transient(cause)) throw cause;
        written = (await stat(temporary).catch(() => null))?.size ?? 0;
      } finally {
        clearTimeout(timer!);
        if (response?.body !== null && response?.body !== undefined && !response.body.locked) {
          await response.body.cancel().catch(() => {});
        }
      }
      await delay(options.retryDelayMilliseconds ?? 1000 * (attempt + 1), undefined, { signal });
    }
    throw new Error("update download failed");
  } catch (error) {
    // Only this invocation's generated files are removed, after pipeline has closed them.
    await rm(temporary, { force: true });
    if (committed) await rm(destination, { force: true });
    throw error;
  }
}
