import type { PrioritySettings } from "./prioritySettings";
import { priorityLatencyCeiling, priorityTotalLatencyCeiling } from "../../dashboard/src/lib/priorityLatencyPresets";

/** Response-phase and complete-request durations stay separate; neither estimates ICMP RTT. */
export interface PriorityProbeResult { reachable: boolean; latencyMs: number | null; totalMs?: number | null }

/** The second successful target must respond: one slow site cannot condemn a node. */
export function priorityProbeResult(results: PromiseSettledResult<{ httpMs: number; totalMs: number }>[]): PriorityProbeResult {
  const successes = results.filter(result => result.status === "fulfilled");
  if (successes.length < 2) return { reachable: false, latencyMs: null, totalMs: null };
  const second = (field: "httpMs" | "totalMs") => {
    const times = successes.map(result => result.value[field]).filter(time => Number.isFinite(time) && time >= 0).sort((a, b) => a - b);
    return times.length === successes.length ? times[1] : null;
  };
  return { reachable: true, latencyMs: second("httpMs"), totalMs: second("totalMs") };
}

interface LatencyHistory {
  sampleAt: number; high: number; highSince: number;
  normal: number; normalSince: number;
}

// Fixed confirmation and hysteresis, independent of regional network distance.
const CONFIRM_ROUNDS = 3;
const CONFIRM_DURATION_MS = 10_000;
const READY_RATIO = 0.8;

/** Constant-sized counters per node; no learned baseline, sample arrays or timers. */
export class PriorityLatency {
  private histories = new Map<string, LatencyHistory>();
  private readonly ceiling: number | undefined;
  constructor(private readonly settings: PrioritySettings) {
    this.ceiling = priorityLatencyCeiling(settings.group, settings.groupLatencyCeilings);
  }
  clear(tag?: string): void { if (tag === undefined) this.histories.clear(); else this.histories.delete(tag); }
  record(tag: string, reachable: boolean, latencyMs: number | null | undefined, now: number, sampleAt: number, totalMs?: number | null): boolean | null {
    if (this.ceiling === undefined) return false;
    if (sampleAt > now) return null;
    const previous = this.histories.get(tag);
    if (previous && sampleAt < previous.sampleAt) return null;
    const history = previous ?? { sampleAt, high: 0, highSince: sampleAt, normal: 0, normalSince: now };
    history.sampleAt = sampleAt;
    const known = reachable && latencyMs != null && Number.isFinite(latencyMs) && latencyMs >= 0 &&
      (totalMs === undefined || totalMs !== null && Number.isFinite(totalMs) && totalMs >= latencyMs);
    const totalCeiling = priorityTotalLatencyCeiling(this.ceiling);
    const high = known && (latencyMs! >= this.ceiling || totalMs !== undefined && totalMs! >= totalCeiling);
    if (!known) {
      history.high = 0; history.normal = 0;
    } else {
      if (high) {
        if (!history.high) history.highSince = sampleAt;
        history.high = Math.min(CONFIRM_ROUNDS, history.high + 1);
        history.normal = 0;
      } else {
        history.high = 0;
        // Leave a 20% margin below the limit so near-limit jitter cannot cause
        // switching or an immediate return to a still marginal preferred node.
        if (latencyMs! <= this.ceiling * READY_RATIO && (totalMs === undefined || totalMs! <= totalCeiling * READY_RATIO)) {
          if (!history.normal) history.normalSince = now;
          history.normal = Math.min(Math.max(this.settings.backupSuccessRounds, this.settings.recoverySuccessRounds), history.normal + 1);
        } else history.normal = 0;
      }
    }
    this.histories.set(tag, history);
    return known ? high : null;
  }
  high(tag: string): boolean { return (this.histories.get(tag)?.high ?? 0) > 0; }
  confirmed(tag: string, now: number): boolean {
    const history = this.histories.get(tag);
    return !!history && now >= history.sampleAt && history.high >= CONFIRM_ROUNDS &&
      history.sampleAt - history.highSince >= CONFIRM_DURATION_MS;
  }
  recovered(tag: string, now: number): boolean {
    const history = this.histories.get(tag);
    if (this.ceiling === undefined) return true;
    return !!history && history.normal >= this.settings.recoverySuccessRounds &&
      now - history.normalSince >= this.settings.recoveryStableMs;
  }
  backupReady(tag: string): boolean {
    return this.ceiling === undefined || (this.histories.get(tag)?.normal ?? 0) >= this.settings.backupSuccessRounds;
  }
}
