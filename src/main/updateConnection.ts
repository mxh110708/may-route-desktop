import { isIP } from "node:net";

import type { ProxyConfig } from "electron";

const INVALID_ADDRESS = "Invalid update proxy address";
const DEFAULT_PORTS: Record<string, number> = {
  "http:": 80,
  "https:": 443,
  "socks5:": 1080,
};

export function normalizeUpdateProxyAddress(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(INVALID_ADDRESS);
  }
  const address = value.trim();
  if (address === "") {
    return "";
  }
  // Never pass Chromium proxy-rule syntax, credentials or URL suffixes through.
  if (address.length > 2048 || /[\s\u0000-\u001f\u007f\\?#@;,=]/u.test(address)) {
    throw new Error(INVALID_ADDRESS);
  }
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error(INVALID_ADDRESS);
  }
  const defaultPort = DEFAULT_PORTS[url.protocol];
  const host = url.hostname;
  const validHost = host.startsWith("[")
    ? host.endsWith("]") && isIP(host.slice(1, -1)) === 6
    : /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?$/i.test(host);
  const port = url.port === "" ? defaultPort : Number(url.port);
  if (
    defaultPort === undefined ||
    !/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/?$/iu.test(address) ||
    !validHost ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    !Number.isInteger(port) || port < 1 || port > 65535
  ) {
    throw new Error(INVALID_ADDRESS);
  }
  return `${url.protocol}//${host}:${port}`;
}

export type UpdateFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface UpdateNetworkSession {
  setProxy(config: ProxyConfig): Promise<void>;
  fetch: UpdateFetch;
  closeAllConnections(): Promise<void>;
}

/** One private session, serialized through body consumption before changing its proxy. */
export class UpdateConnection {
  private session: UpdateNetworkSession | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly createSession: () => UpdateNetworkSession) {}

  run<T>(address: string, operation: (fetchUpdate: UpdateFetch) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const proxy = normalizeUpdateProxyAddress(address);
    let started = false;
    const result = this.tail.then(async () => {
      signal?.throwIfAborted();
      started = true;
      const network = this.session ??= this.createSession();
      // Fail closed if an old connection cannot be closed or the proxy cannot be set.
      await network.closeAllConnections();
      signal?.throwIfAborted();
      await network.setProxy(proxy === "" ? { mode: "direct" } : {
        mode: "fixed_servers",
        proxyRules: proxy,
        proxyBypassRules: "<-loopback>",
      });
      try {
        signal?.throwIfAborted();
        return await operation(network.fetch.bind(network));
      } finally {
        // Keep the original request/body error if closing sockets also fails.
        await network.closeAllConnections().catch(() => {});
      }
    });
    this.tail = result.then(() => {}, () => {});
    if (signal === undefined) return result;
    return new Promise<T>((resolve, reject) => {
      const cancelQueued = () => { if (!started) reject(signal.reason); };
      signal.addEventListener("abort", cancelQueued, { once: true });
      if (signal.aborted) cancelQueued();
      result.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancelQueued));
    });
  }
}
