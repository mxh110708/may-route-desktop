import { WindowsProxyRecoveryGate, type WindowsProxyOwnership } from "./systemProxyRecovery";

export type WindowsProxyHealth = "inactive" | "unsupported" | "healthy" | "confirming" | "repairing" | "foreign" | "suspended" | "unknown";
export const WINDOWS_PROXY_POLL_MS = 2_000;
export const WINDOWS_PROXY_CONFIRM_MS = 1_000;
export const WINDOWS_PROXY_REARM_MS = 15_000;
export const WINDOWS_PROXY_WARNING_MS = 10_000;
const MAX_OBSERVATION_GAP_MS = 5_000;
export type ProxyRecoveryCheckpoint = "available" | "repairing" | "used" | "foreign" | "unknown";

export interface WindowsProxyContext {
  // Service/profile/mode identity, deliberately NOT node selection or network epoch.
  key: string;
  read(): Promise<WindowsProxyOwnership>;
  repair(): Promise<void>;
  current(): boolean;
}

/** Independent local-state loop. No Internet probes and no network observation window. */
export class WindowsProxyMonitor {
  private gate = new WindowsProxyRecoveryGate();
  private session = 0;
  private busy = false;
  private pending = false;
  private uncertain = false;
  private contextKey: string | null = null;
  private loaded = false;
  private checkpoint: ProxyRecoveryCheckpoint = "available";
  private ownedSince: number | null = null;
  private ownedAt: number | null = null;
  private warningSince: { state: WindowsProxyHealth; since: number; at: number } | null = null;
  private warned = new Set<WindowsProxyHealth>();
  private state: WindowsProxyHealth = "inactive";
  constructor(private readonly deps: {
    context(): Promise<WindowsProxyContext | null>;
    enqueue(operation: () => Promise<void>): Promise<void>;
    changed(state: WindowsProxyHealth): void;
    warning(state: WindowsProxyHealth): void;
    dismissWarning?(): void;
    now?(): number;
    log(event: string, details?: Record<string, unknown>): void;
    loadCheckpoint?(): ProxyRecoveryCheckpoint;
    saveCheckpoint?(state: ProxyRecoveryCheckpoint): void;
  }) {}

  // Explicit user start/reapply resets all gates, including foreign/unknown.
  // Node switches and automatic reloads never grant a fresh repair allowance.
  newSession(): void {
    this.saveCheckpoint("available");
    this.loaded = true;
    this.session++;
    this.gate.reset();
    this.uncertain = false;
    this.resetObservation();
    this.warned.clear();
    this.publish("inactive");
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private saveCheckpoint(state: ProxyRecoveryCheckpoint): void {
    this.deps.saveCheckpoint?.(state);
    this.checkpoint = state;
  }
  private resetObservation(): void {
    this.ownedSince = this.ownedAt = null;
    this.warningSince = null;
  }
  private observeOwned(ownership: WindowsProxyOwnership): void {
    if (ownership !== "owned") { this.ownedSince = this.ownedAt = null; return; }
    const now = this.now();
    if (this.ownedAt === null || now < this.ownedAt || now - this.ownedAt > MAX_OBSERVATION_GAP_MS) this.ownedSince = now;
    this.ownedAt = now;
    // Only a spent matching-endpoint repair can rearm. A real foreign takeover
    // or uncertain RPC remains latched until an explicit Route action.
    if (this.checkpoint === "used" && this.ownedSince !== null && now - this.ownedSince >= WINDOWS_PROXY_REARM_MS) {
      this.saveCheckpoint("available");
      this.gate.reset();
      this.warned.delete("suspended");
      this.deps.log("windows-proxy-recovery-rearmed", { stableMs: now - this.ownedSince });
    }
  }

  private publish(state: WindowsProxyHealth): void {
    const previous = this.state;
    if (state !== this.state) {
      this.state = state;
      this.deps.changed(state);
      this.deps.log("windows-proxy-state", { state });
    }
    if (state !== "foreign" && state !== "suspended") {
      this.warningSince = null;
      if (previous === "foreign" || previous === "suspended") this.deps.dismissWarning?.();
      return;
    }
    const now = this.now(), warning = this.checkpoint === "foreign" ? "foreign" : state;
    const prior = this.warningSince;
    if (!prior || prior.state !== warning || now < prior.at || now - prior.at > MAX_OBSERVATION_GAP_MS) {
      this.warningSince = { state: warning, since: now, at: now };
    } else prior.at = now;
    if (now - this.warningSince!.since >= WINDOWS_PROXY_WARNING_MS && !this.warned.has(warning)) {
      this.warned.add(warning);
      this.deps.warning(warning);
      this.deps.log("windows-proxy-warning", { state: warning });
    }
  }

  async poll(): Promise<number> {
    if (this.busy) return WINDOWS_PROXY_POLL_MS;
    this.busy = true;
    const session = this.session;
    try {
      if (!this.loaded) {
        this.checkpoint = this.deps.loadCheckpoint?.() ?? "available";
        if (this.checkpoint !== "available") this.gate.suspend();
        this.uncertain = this.checkpoint === "unknown" || this.checkpoint === "repairing";
        this.loaded = true;
      }
      const context = await this.deps.context();
      if (session !== this.session) return WINDOWS_PROXY_CONFIRM_MS;
      if (!context) {
        this.contextKey = null;
        this.resetObservation();
        this.gate.interruptConfirmation();
        this.publish("inactive");
        return WINDOWS_PROXY_POLL_MS;
      }
      if (context.key !== this.contextKey) {
        this.contextKey = context.key;
        this.resetObservation();
        this.gate.interruptConfirmation();
      }
      const ownership = await context.read();
      if (session !== this.session || !context.current()) {
        this.gate.interruptConfirmation();
        this.resetObservation();
        return WINDOWS_PROXY_CONFIRM_MS;
      }
      if (this.pending) return WINDOWS_PROXY_CONFIRM_MS;
      if (this.uncertain) {
        // A timed-out RPC may already have reached the OS. Read, but do not
        // reissue it or mistake a late successful result for a new allowance.
        this.publish("unknown");
        return WINDOWS_PROXY_POLL_MS;
      }
      this.observeOwned(ownership);
      const action = this.gate.observe(ownership);
      if (action === "foreign" && this.checkpoint !== "foreign") this.saveCheckpoint("foreign");
      if (action === "repair") {
        this.pending = true;
        this.publish("repairing");
        void this.deps.enqueue(async () => {
          let dispatched = false;
          try {
            if (session !== this.session || !context.current()) return;
            const before = await context.read();
            if (session !== this.session || !context.current()) return;
            if (before !== "detached") {
              this.gate.cancelPendingRepair();
              this.gate.observe(before);
              if (before === "foreign") this.saveCheckpoint("foreign");
              this.publish(before === "owned" ? "healthy" : before);
              return;
            }
            // Persist intent before dispatch. A crash here must not turn a
            // possibly in-flight command into a completed repair on restart.
            this.saveCheckpoint("repairing");
            dispatched = true;
            await context.repair();
            if (session !== this.session) return;
            this.saveCheckpoint("used");
            if (!context.current()) return;
            const after = await context.read();
            if (session !== this.session || !context.current()) return;
            if (after === "foreign") { this.gate.observe(after); this.saveCheckpoint("foreign"); }
            this.publish(after === "owned" ? "healthy" : after === "detached" ? "suspended" : after);
            this.deps.log("windows-proxy-repair-result", { state: after });
          } catch {
            if (session === this.session) {
              this.uncertain = true;
              this.saveCheckpoint("unknown");
              this.publish("unknown");
              this.deps.log("windows-proxy-repair-result-unknown");
            }
          } finally {
            if (!dispatched && session === this.session) this.gate.cancelPendingRepair();
            this.pending = false;
          }
        }).catch(() => {
          this.pending = false;
          if (session === this.session) { this.uncertain = true; this.publish("unknown"); }
        });
      } else {
        this.publish(action === "retry" ? "confirming" : action);
      }
      return action === "retry" || action === "repair" ? WINDOWS_PROXY_CONFIRM_MS : WINDOWS_PROXY_POLL_MS;
    } catch {
      if (session === this.session) {
        this.gate.interruptConfirmation();
        this.resetObservation();
        this.publish("unknown");
      }
      return WINDOWS_PROXY_POLL_MS;
    } finally { this.busy = false; }
  }
}
