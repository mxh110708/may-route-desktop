import { WindowsProxyRecoveryGate, type WindowsProxyOwnership } from "./systemProxyRecovery";

export type WindowsProxyHealth = "inactive" | "unsupported" | "healthy" | "confirming" | "repairing" | "retrying" | "unknown";
export const WINDOWS_PROXY_POLL_MS = 2_000;
export const WINDOWS_PROXY_CONFIRM_MS = 1_000;
export const WINDOWS_PROXY_WARNING_MS = 10_000;
const MAX_OBSERVATION_GAP_MS = 5_000;

export interface WindowsProxyContext {
  // Service/profile/capture intent, deliberately not node selection.
  key: string;
  read(): Promise<WindowsProxyOwnership>;
  repair(): Promise<void>;
  current(): boolean;
}

/** Local-state guard; no Internet probes or permanent foreign-owner latch. */
export class WindowsProxyMonitor {
  private gate = new WindowsProxyRecoveryGate();
  private session = 0;
  private busy = false;
  private pending = false;
  private contextKey: string | null = null;
  private warningSince: { since: number; at: number } | null = null;
  private warned = false;
  private state: WindowsProxyHealth = "inactive";
  constructor(private readonly deps: {
    context(): Promise<WindowsProxyContext | null>;
    enqueue(operation: () => Promise<void>): Promise<void>;
    changed(state: WindowsProxyHealth): void;
    warning(state: WindowsProxyHealth): void;
    dismissWarning?(): void;
    now?(): number;
    log(event: string, details?: Record<string, unknown>): void;
  }) {}

  newSession(): void {
    this.session++;
    this.contextKey = null;
    this.gate.reset();
    this.publish("inactive");
  }

  /** Cancel queued/awaiting work before the stop RPC waits on the service queue. */
  stop(): void {
    this.session++;
    this.contextKey = null;
    this.gate.interruptConfirmation();
    this.publish("inactive");
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private publish(state: WindowsProxyHealth): void {
    if (state !== this.state) {
      this.state = state;
      this.deps.changed(state);
      this.deps.log("windows-proxy-state", { state });
    }
    if (state !== "confirming" && state !== "repairing" && state !== "retrying") {
      this.warningSince = null;
      if (this.warned) this.deps.dismissWarning?.();
      this.warned = false;
      return;
    }
    const now = this.now(), prior = this.warningSince;
    if (!prior || now < prior.at || now - prior.at > MAX_OBSERVATION_GAP_MS) this.warningSince = { since: now, at: now };
    else prior.at = now;
    if (now - this.warningSince!.since >= WINDOWS_PROXY_WARNING_MS && !this.warned) {
      this.warned = true;
      this.deps.warning("retrying");
      this.deps.log("windows-proxy-warning", { state: "retrying" });
    }
  }

  async poll(): Promise<number> {
    if (this.busy) return WINDOWS_PROXY_POLL_MS;
    this.busy = true;
    const session = this.session;
    try {
      const context = await this.deps.context();
      if (session !== this.session) return WINDOWS_PROXY_CONFIRM_MS;
      if (!context) {
        this.contextKey = null;
        this.gate.interruptConfirmation();
        this.publish("inactive");
        return WINDOWS_PROXY_POLL_MS;
      }
      if (context.key !== this.contextKey) {
        this.contextKey = context.key;
        this.gate.interruptConfirmation();
        this.warningSince = null;
      }
      const ownership = await context.read();
      if (session !== this.session || !context.current()) {
        this.gate.interruptConfirmation();
        return WINDOWS_PROXY_CONFIRM_MS;
      }
      if (this.pending) return WINDOWS_PROXY_CONFIRM_MS;
      const action = this.gate.observe(ownership, this.now());
      if (action === "repair") {
        this.pending = true;
        this.publish("repairing");
        void this.deps.enqueue(async () => {
          try {
            if (session !== this.session || !context.current()) return;
            const before = await context.read();
            if (session !== this.session || !context.current()) return;
            if (before === "owned" || before === "unknown") {
              this.gate.cancelPendingRepair();
              this.publish(before === "owned" ? "healthy" : "unknown");
              return;
            }
            this.gate.dispatched(this.now());
            await context.repair();
            if (session !== this.session || !context.current()) return;
            const after = await context.read();
            if (session !== this.session || !context.current()) return;
            this.publish(after === "owned" ? "healthy" : after === "unknown" ? "unknown" : "retrying");
            this.deps.log("windows-proxy-repair-result", { state: after });
          } catch {
            if (session === this.session && context.current()) {
              // Bounded RPC; read again and retry known mismatches after the
              // cooldown. A pending write is never duplicated in parallel.
              this.gate.interruptConfirmation();
              this.publish("unknown");
              this.deps.log("windows-proxy-repair-result-unknown");
            }
          } finally { this.pending = false; }
        }).catch(() => {
          this.pending = false;
          if (session === this.session && context.current()) this.publish("unknown");
        });
      } else this.publish(action === "retry" ? "confirming" : action);
      return action === "retry" || action === "repair" ? WINDOWS_PROXY_CONFIRM_MS : WINDOWS_PROXY_POLL_MS;
    } catch {
      if (session === this.session) {
        this.gate.interruptConfirmation();
        this.warningSince = null;
        this.publish("unknown");
      }
      return WINDOWS_PROXY_POLL_MS;
    } finally { this.busy = false; }
  }
}
