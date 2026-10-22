import { createServer } from "node:net";
import { DEFAULT_PRIORITY_SETTINGS, priorityGroupOrder, type PrioritySettings } from "./prioritySettings";
import { PriorityLatency } from "./priorityLatency";

export interface Candidate { tag: string; port: number }

/** Structural entry groups only: every member must resolve to a concrete proxy. */
export function priorityGroups(content: string): { tag: string; nodes: string[] }[] {
  const config = JSON.parse(content);
  const outbounds = Array.isArray(config.outbounds) ? config.outbounds : [];
  const concrete = new Set(outbounds.filter((node: any) => typeof node?.tag === "string" &&
    typeof node.type === "string" && !["direct", "block", "selector", "urltest", "dns"].includes(node.type))
    .map((node: any) => node.tag));
  return outbounds.filter((group: any) => group.type === "selector" && typeof group.tag === "string" &&
    Array.isArray(group.outbounds) && group.outbounds.length > 0 &&
    group.outbounds.every((tag: unknown) => typeof tag === "string" && concrete.has(tag)))
    .map((group: any) => ({ tag: group.tag, nodes: [...new Set<string>(group.outbounds)] }));
}

export function reconcilePrioritySettings(content: string, settings: PrioritySettings): PrioritySettings {
  return reconcilePriorityGroups(priorityGroups(content), settings);
}

export function reconcilePriorityGroups(groups: { tag: string; nodes: string[] }[], settings: PrioritySettings): PrioritySettings {
  const group = groups.find((group) => group.tag === settings.group);
  // Preserve an intentional subset; newly introduced nodes remain available in
  // the editor instead of silently opting excluded nodes into monitoring.
  const available = new Set(group?.nodes);
  const order = priorityGroupOrder(settings, settings.group).filter((tag) => available.has(tag));
  const groupOrders = Object.fromEntries(groups.flatMap(item => {
    const members = new Set(item.nodes);
    const saved = priorityGroupOrder(settings, item.tag).filter(tag => members.has(tag));
    return saved.length ? [[item.tag, saved]] : [];
  }));
  const groupTags = new Set(groups.map(item => item.tag));
  const groupLatencyCeilings = Object.fromEntries(Object.entries(settings.groupLatencyCeilings).filter(([tag]) => groupTags.has(tag)));
  return { ...settings, order, groupOrders, groupLatencyCeilings };
}

export function priorityTags(content: string, settings: PrioritySettings = DEFAULT_PRIORITY_SETTINGS): string[] {
  if (!settings.enabled) return [];
  return priorityTagsFromGroups(priorityGroups(content), settings);
}

export function priorityTagsFromGroups(groups: { tag: string; nodes: string[] }[], settings: PrioritySettings): string[] {
  if (!settings.enabled) return [];
  const group = groups.find(group => group.tag === settings.group);
  if (!group) return [];
  const available = group.nodes;
  if (!settings.order.length) return available;
  const nodes = new Set(available);
  const order = settings.order.filter(tag => nodes.has(tag));
  return order.length ? order : available;
}

export async function allocateProbePorts(count: number): Promise<number[]> {
  const servers: ReturnType<typeof createServer>[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = createServer(); servers.push(server);
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    }
    return servers.map(s => (s.address() as { port: number }).port);
  } finally { await Promise.all(servers.map(s => new Promise<void>(resolve => s.close(() => resolve())))); }
}

export function priorityProbeTags(content: string, settings: PrioritySettings): string[] {
  return settings.enabled ? [...new Set(priorityGroups(content).flatMap(group => group.nodes))] : [];
}

export function addProbeRoutes(content: string, ports: number[], settings: PrioritySettings = DEFAULT_PRIORITY_SETTINGS, allGroups = false): { content: string; candidates: Candidate[] } {
  const config = JSON.parse(content), tags = allGroups ? priorityProbeTags(content, settings) : priorityTags(content, settings);
  if (tags.length !== ports.length) throw new Error("priority probe port count mismatch");
  if (!tags.length) return { content, candidates: [] };
  const candidates = tags.map((tag, i) => ({ tag, port: ports[i] }));
  config.inbounds ??= []; config.route ??= {}; config.route.rules ??= [];
  const rules: unknown[] = [];
  candidates.forEach((candidate, i) => {
    const tag = `may-priority-probe-${i}`;
    if (config.inbounds.some((v: any) => v.tag === tag)) throw new Error("reserved priority probe tag collision");
    config.inbounds.push({ type: "http", tag, listen: "127.0.0.1", listen_port: candidate.port });
    rules.push({ inbound: [tag], action: "route", outbound: candidate.tag });
  });
  config.route.rules.unshift(...rules);
  return { content: JSON.stringify(config), candidates };
}

interface History { good: number; bad: number; since: number; at: number; sampleAt: number; recent: { at: number; bad: boolean }[] }
export type PrioritySwitchReason = "unreachable" | "latency" | "unstable" | "recovered";
const QUALITY_WINDOW_MS = 120_000;
/** Keep configured priority; switch for confirmed failures or sustained poor quality. */
export class PriorityFailover {
  private history = new Map<string, History>();
  private readonly latency: PriorityLatency;
  private lastSwitch = -Infinity;
  private expected: string | null = null;
  private lastSample: number | null = null;
  private preferredTag: string | null;
  constructor(readonly tags: string[], readonly settings: PrioritySettings = DEFAULT_PRIORITY_SETTINGS, preferred?: string | null) {
    this.preferredTag = preferred ?? tags[0] ?? null;
    this.latency = new PriorityLatency(settings);
  }
  get preferred(): string | null { return this.preferredTag; }
  clearSamples(): void { this.history.clear(); this.latency.clear(); this.lastSample = null; }
  isMonitored(tag: string): boolean { return this.tags.includes(tag); }
  observeSelection(selected: string): boolean {
    const changed = this.expected !== null && selected !== this.expected;
    if (changed) {
      this.preferredTag = selected;
      this.clearSamples();
      this.lastSwitch = -Infinity;
    }
    this.expected = selected;
    return changed;
  }
  get ownsNodeRecovery(): boolean {
    return this.settings.enabled && this.expected !== null && this.isMonitored(this.expected);
  }
  private rankedTags(): string[] {
    return this.preferredTag !== null && this.isMonitored(this.preferredTag)
      ? [this.preferredTag, ...this.tags.filter(tag => tag !== this.preferredTag)] : this.tags;
  }
  record(results: Map<string, boolean>, now: number, sampleAt = now, latencies?: ReadonlyMap<string, number | null>, totals?: ReadonlyMap<string, number | null | undefined>): string | null {
    if (!Number.isFinite(now) || !Number.isFinite(sampleAt) || sampleAt > now) return this.decide(now);
    // Sleep/offline gaps are not proof of continuous recovery or consecutive failure.
    const staleGap = Math.max(120000, Math.max(this.settings.healthyIntervalMs, this.settings.failureIntervalMs) + this.tags.length * this.settings.probeTimeoutMs + 30000);
    if (this.lastSample !== null && now - this.lastSample > staleGap) this.clearSamples();
    this.lastSample = now;
    for (const tag of this.tags) {
      // Independent active/backup lanes only count samples actually collected.
      if (!results.has(tag)) continue;
      const prior = this.history.get(tag);
      if (prior && sampleAt < prior.sampleAt) continue;
      if (prior && now - prior.at > staleGap) this.latency.clear(tag);
      const old = prior && now - prior.at <= staleGap ? prior : { good: 0, bad: 0, since: now, at: now, sampleAt, recent: [] };
      const ok = results.get(tag) === true;
      const slow = this.latency.record(tag, ok, latencies?.get(tag), now, sampleAt, totals?.get(tag));
      const recent = ok && slow === null ? [] : [...old.recent.filter(value => value.at >= now - QUALITY_WINDOW_MS), { at: sampleAt, bad: !ok || slow === true }].slice(-this.qualityWindowSize);
      this.history.set(tag, ok ? { good: old.good + 1, bad: 0, since: old.good ? old.since : now, at: now, sampleAt, recent } : { good: 0, bad: old.bad + 1, since: now, at: now, sampleAt, recent });
    }
    return this.decide(now);
  }
  private get qualityRounds(): number { return Math.max(3, this.settings.failureRounds); }
  private get qualityWindowSize(): number { return 2 * this.qualityRounds - 1; }
  private unstable(tag: string, now: number): boolean {
    const recent = this.history.get(tag)?.recent ?? [];
    return recent.length === this.qualityWindowSize && recent[0].at >= now - QUALITY_WINDOW_MS &&
      recent.at(-1)!.bad && recent.at(-1)!.at - recent[0].at >= 10_000 && recent.filter(value => value.bad).length >= this.qualityRounds;
  }
  qualitySuspect(tag: string): boolean {
    return this.latency.high(tag) || (this.history.get(tag)?.recent.some(value => value.bad && value.at >= (this.lastSample ?? 0) - QUALITY_WINDOW_MS) ?? false);
  }
  decide(now: number): string | null {
    return this.decision(now)?.tag ?? null;
  }
  decision(now: number): { tag: string; reason: PrioritySwitchReason } | null {
    if (!this.settings.enabled || this.expected === null || !this.isMonitored(this.expected)) return null;
    const current = this.history.get(this.expected);
    const fresh = (h: History | undefined): h is History => !!h && now >= h.at &&
      now - h.at <= Math.max(45000, this.settings.healthyIntervalMs + this.settings.probeTimeoutMs + 5000);
    if (!fresh(current)) return null;
    const ranked = this.rankedTags();
    if (current.bad >= this.settings.failureRounds) {
      // A newly failed backup must not be trapped by the failback cooldown.
      const ready = ranked.filter(t => t !== this.expected && fresh(this.history.get(t)) && this.history.get(t)!.good >= this.settings.backupSuccessRounds);
      const tag = ready.find(t => !this.latency.high(t)) ?? ready[0];
      return tag ? { tag, reason: "unreachable" } : null;
    }
    if (now - this.lastSwitch < this.settings.failbackCooldownMs) return null;
    if (this.latency.confirmed(this.expected, now)) {
      const tag = ranked.find(t => t !== this.expected && fresh(this.history.get(t)) &&
        this.history.get(t)!.good >= this.settings.backupSuccessRounds && this.latency.backupReady(t));
      return tag ? { tag, reason: "latency" } : null;
    }
    if (this.unstable(this.expected, now)) {
      const tag = ranked.find(t => t !== this.expected && fresh(this.history.get(t)) &&
        this.history.get(t)!.good >= this.settings.backupSuccessRounds && !this.qualitySuspect(t) && this.latency.backupReady(t));
      return tag ? { tag, reason: "unstable" } : null;
    }
    const index = ranked.indexOf(this.expected);
    const tag = ranked.slice(0, index).find(t => {
      const h = this.history.get(t);
      return fresh(h) && h.good >= this.settings.recoverySuccessRounds && now - h.since >= this.settings.recoveryStableMs && this.latency.recovered(t, now);
    });
    return tag ? { tag, reason: "recovered" } : null;
  }
  latencyHigh(tag: string): boolean { return this.latency.high(tag); }
  nextProbeDelay(selected: string, results: ReadonlyMap<string, boolean>): number {
    const failures = this.history.get(selected)?.bad ?? 0;
    if (failures >= this.settings.failureRounds || this.unstable(selected, this.lastSample ?? 0)) return this.settings.failureIntervalMs;
    // Confirm a newly failed active node promptly, but back off after the configured
    // failure threshold when no backup is ready; do not probe indefinitely at burst rate.
    if (this.isMonitored(selected) && failures > 0 && failures < this.settings.failureRounds) return 1_000;
    // Slow but reachable nodes need a short sustained window, not one-second
    // failure bursts. This caps confirmation traffic at one probe per five seconds.
    if (this.latency.high(selected)) return this.latency.confirmed(selected, this.lastSample ?? 0) ? this.settings.failureIntervalMs : 5_000;
    if (this.qualitySuspect(selected)) return this.unstable(selected, this.lastSample ?? 0) ? this.settings.failureIntervalMs : 5_000;
    return [...results.values()].every(Boolean) ? this.settings.healthyIntervalMs : this.settings.failureIntervalMs;
  }
  switched(tag: string, now: number): void { this.expected = tag; this.lastSwitch = now; }
}
