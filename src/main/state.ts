import { ConnectError } from "@connectrpc/connect";
import { EventEmitter } from "node:events";

import { ServiceStatus_Type } from "../shared/gen/daemon/started_service_pb";
import type { Group } from "../shared/gen/daemon/started_service_pb";
import { DaemonOwnership } from "../shared/gen/experimental/boxdd/desktop_service_pb";
import type { DaemonConnectionState } from "../shared/ipc";
import { desktopService, startedService } from "./daemon";
import { preferredLocale } from "./locale";
import { onPreferenceChanged } from "./preferences";
import { bundledDaemonVersion, probeService } from "./repair";
import { backgroundIdleGate } from "./backgroundIdle";

const RECONNECT_DELAY = 3000;
const HANDSHAKE_TIMEOUT = 3000;
const MAXIMUM_BACKOFF = 5000;
const SESSION_RESTART_DELAY = 1000;

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

class DaemonState extends EventEmitter {
  connection: DaemonConnectionState = { phase: "connecting" };
  status: ServiceStatus_Type | null = null;
  groups: Group[] = [];
  routing: { modeList: string[]; currentMode: string } = { modeList: [], currentMode: "" };

  private started = false;
  private wakeRetry: (() => void) | null = null;

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    if (desktopService === null || startedService === null) {
      this.setConnection({ phase: "unavailable", errorMessage: "daemon socket is not configured" });
      return;
    }
    onPreferenceChanged((name) => {
      if (name === "language" && this.connection.phase === "connected") {
        void this.syncLocale();
      }
    });
    void this.loopConnection();
  }

  private async syncLocale(): Promise<void> {
    try {
      await desktopService!.setLocale(
        { locale: preferredLocale() },
        { timeoutMs: HANDSHAKE_TIMEOUT },
      );
    } catch {}
  }

  retryConnection() {
    this.wakeRetry?.();
  }

  private setConnection(connection: DaemonConnectionState) {
    if (JSON.stringify(this.connection) === JSON.stringify(connection)) return;
    this.connection = connection;
    this.emit("connection");
    this.emit("change");
  }

  private interruptibleSleep(durationMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeRetry = null;
        resolve();
      }, durationMs);
      this.wakeRetry = () => {
        clearTimeout(timer);
        this.wakeRetry = null;
        resolve();
      };
    });
  }

  private async loopConnection(): Promise<void> {
    let attempt = 0;
    for (;;) {
      await backgroundIdleGate.wait();
      if (backgroundIdleGate.paused) continue;
      try {
        const info = await desktopService!.getDaemonInfo({}, { timeoutMs: HANDSHAKE_TIMEOUT });
        const bundledVersion = await bundledDaemonVersion();
        if (bundledVersion !== null && info.version !== bundledVersion) {
          this.setConnection({
            phase: "version-mismatch",
            daemonVersion: info.version,
            bundledDaemonVersion: bundledVersion,
          });
          attempt = 0;
          await this.interruptibleSleep(RECONNECT_DELAY);
          continue;
        }
        if (info.ownership === DaemonOwnership.AVAILABLE) {
          await desktopService!.claimService({}, { timeoutMs: HANDSHAKE_TIMEOUT });
          continue;
        }
        if (info.ownership === DaemonOwnership.OTHER) {
          this.status = null;
          this.groups = [];
          this.setConnection({
            phase: "owned-by-other-user",
            daemonVersion: info.version,
          });
          attempt = 0;
          await this.interruptibleSleep(RECONNECT_DELAY);
          continue;
        }
        if (info.ownership !== DaemonOwnership.CALLER) {
          throw new Error("daemon returned an invalid ownership state");
        }
        await this.syncLocale();
        attempt = 0;
        this.setConnection({ phase: "connected", daemonVersion: info.version });
      } catch (error) {
        attempt++;
        const probe = await probeService();
        if (probe === "not-installed" || probe === "not-running") {
          this.setConnection({ phase: probe });
        } else {
          this.setConnection({
            phase: "unavailable",
            errorMessage: ConnectError.from(error).rawMessage,
          });
        }
        await this.interruptibleSleep(Math.min(1000 * attempt, MAXIMUM_BACKOFF));
        continue;
      }
      const session = new AbortController();
      const pause = () => session.abort();
      const idleSignal = backgroundIdleGate.signal;
      idleSignal.addEventListener("abort", pause, { once: true });
      if (idleSignal.aborted) pause();
      if (process.platform !== "win32") void this.loopGroups(session.signal);
      let routingSession: AbortController | null = null;
      session.signal.addEventListener("abort", () => routingSession?.abort(), { once: true });
      this.emit("session", session.signal);
      try {
        for await (const message of startedService!.subscribeServiceStatus(
          {},
          { signal: session.signal },
        )) {
          if (session.signal.aborted) break;
          const nextStatus = message.status ?? ServiceStatus_Type.IDLE;
          if (process.platform === "win32" && nextStatus !== this.status) {
            routingSession?.abort();
            routingSession = null;
            this.groups = [];
            this.routing = { modeList: [], currentMode: "" };
            if (nextStatus === ServiceStatus_Type.STARTED) {
              routingSession = new AbortController();
              void this.loopGroups(routingSession.signal);
              void this.loopRouting(routingSession.signal);
            }
          }
          this.status = nextStatus;
          this.emit("change");
        }
      } catch {}
      session.abort();
      idleSignal.removeEventListener("abort", pause);
      if (backgroundIdleGate.paused) continue;
      this.status = null;
      this.groups = [];
      this.routing = { modeList: [], currentMode: "" };
      this.emit("change");
      await sleep(SESSION_RESTART_DELAY);
    }
  }

  private async loopGroups(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const message of startedService!.subscribeGroups({}, { signal })) {
          if (signal.aborted) return;
          this.groups = message.group;
          this.emit("change");
        }
      } catch {}
      if (signal.aborted) return;
      if (this.groups.length > 0) {
        this.groups = [];
        this.emit("change");
      }
      if (!signal.aborted) {
        await sleep(RECONNECT_DELAY);
      }
    }
  }

  private async loopRouting(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const status = await startedService!.getClashModeStatus({}, { signal, timeoutMs: HANDSHAKE_TIMEOUT });
        if (signal.aborted) return;
        this.routing = { modeList: status.modeList, currentMode: status.currentMode };
        this.emit("change");
        for await (const message of startedService!.subscribeClashMode({}, { signal })) {
          if (signal.aborted) return;
          this.routing = { ...this.routing, currentMode: message.mode };
          this.emit("change");
        }
      } catch {}
      if (signal.aborted) return;
      this.routing = { modeList: [], currentMode: "" };
      this.emit("change");
      await sleep(RECONNECT_DELAY);
    }
  }
}

export const daemonState = new DaemonState();
