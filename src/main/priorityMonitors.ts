import { PriorityFailover, priorityTagsFromGroups, type Candidate, type PrioritySwitchReason } from "./priorityFailover";
import type { PriorityProbeResult } from "./priorityLatency";
import { priorityGroupSettings, type PrioritySettings } from "./prioritySettings";
import { PriorityProbeScheduler, type NodeSample } from "./priorityProbeScheduler";
import { PriorityProbeBudget } from "./priorityProbeBudget";

export interface PriorityPreference { preferred: string | null; selected: string | null }
export interface PriorityMonitor {
  group: string; policy: PriorityFailover; candidates: Candidate[]; active: boolean; epoch: number;
  scheduler: PriorityProbeScheduler | null; schedulerKey: string; switching: boolean;
  target: { tag: string; until: number; applied: boolean; reason: PrioritySwitchReason } | null;
  results: { at: number; finishedAt: number; reachable: Map<string, boolean> } | null;
  selectedEvidence: NodeSample | null;
  observedSelected: string | null;
}

/** Independent policies for used selectors; all of them share one probe budget. */
export class PriorityMonitors {
  private monitors = new Map<string, PriorityMonitor>();
  private groups: { tag: string; nodes: string[] }[] = [];
  private candidates: Candidate[] = [];
  private settings: PrioritySettings | null = null;
  private remembered: Record<string, PriorityPreference> = {};
  private budget = new PriorityProbeBudget();
  private generation = 0;
  private used = new Set<string>();
  constructor(private readonly deps: {
    now(): number;
    selected(group: string): string | null;
    current(): boolean;
    probe(candidate: Candidate, policy: PriorityFailover): Promise<PriorityProbeResult>;
    switch(group: string, from: string, to: string, current: () => boolean): Promise<boolean>;
    changed(event: string, details: Record<string, unknown>): void;
    error(error: unknown): void;
  }) {}
  configure(groups: { tag: string; nodes: string[] }[], candidates: Candidate[], settings: PrioritySettings, remembered: Record<string, PriorityPreference> = {}): void {
    this.clear(); this.groups = groups; this.candidates = candidates; this.settings = settings; this.remembered = remembered;
  }
  update(settings: PrioritySettings): void {
    this.settings = settings;
    for (const monitor of this.monitors.values()) {
      const effective = priorityGroupSettings(settings, monitor.group);
      if (JSON.stringify(monitor.policy.settings) !== JSON.stringify(effective)) {
        this.remembered = { ...this.preferences };
        monitor.active = false; monitor.epoch++; this.monitors.delete(monitor.group);
      }
    }
  }
  clear(): void {
    this.generation++;
    for (const monitor of this.monitors.values()) { monitor.active = false; monitor.epoch++; monitor.policy.clearSamples(); }
    this.monitors.clear(); this.used.clear(); this.groups = []; this.candidates = []; this.settings = null; this.remembered = {};
  }
  suspend(): void {
    this.used.clear();
    for (const monitor of this.monitors.values()) if (monitor.active) {
      monitor.active = false; monitor.epoch++; monitor.policy.clearSamples(); monitor.results = null; monitor.selectedEvidence = null;
    }
  }
  get active(): PriorityMonitor[] { return [...this.monitors.values()].filter(monitor => monitor.active && monitor.policy.settings.enabled); }
  get preferences(): Record<string, PriorityPreference> {
    return Object.fromEntries([...Object.entries(this.remembered), ...[...this.monitors.values()].map(monitor => [monitor.group, {
      preferred: monitor.policy.preferred,
      selected: monitor.target?.applied ? monitor.target.tag : monitor.observedSelected,
    }] as const)]);
  }
  get needsRoutes(): boolean {
    if (!this.settings?.enabled) return false;
    const prepared = new Set(this.candidates.map(candidate => candidate.tag));
    return this.groups.some(group => priorityTagsFromGroups(this.groups, priorityGroupSettings(this.settings!, group.tag)).some(tag => !prepared.has(tag)));
  }
  private monitor(group: string): PriorityMonitor | null {
    if (!this.settings?.enabled) return null;
    const settings = priorityGroupSettings(this.settings, group);
    const tags = priorityTagsFromGroups(this.groups, settings);
    const candidates = tags.map(tag => this.candidates.find(candidate => candidate.tag === tag));
    if (!tags.length || candidates.some(candidate => !candidate)) return null;
    let monitor = this.monitors.get(group);
    if (!monitor) {
      const saved = Object.hasOwn(this.remembered, group) ? this.remembered[group] : null;
      const selected = this.deps.selected(group);
      const preferred = saved ? selected !== saved.selected ? selected : saved.preferred : selected;
      const policy = new PriorityFailover(tags, settings, preferred && tags.includes(preferred) ? preferred : null);
      monitor = { group, policy, candidates: candidates as Candidate[], active: false, epoch: 0, scheduler: null,
        schedulerKey: "", switching: false, target: null, results: null, selectedEvidence: null, observedSelected: selected };
      this.monitors.set(group, monitor);
    }
    return monitor;
  }
  tick(groups: string[]): void {
    if (!this.settings?.enabled || !this.deps.current()) { this.suspend(); return; }
    this.used = new Set(groups);
    for (const monitor of this.monitors.values()) if (!this.used.has(monitor.group) && monitor.active) {
      monitor.active = false; monitor.epoch++; monitor.policy.clearSamples(); monitor.results = null; monitor.selectedEvidence = null;
    }
    for (const group of this.used) {
      const monitor = this.monitor(group);
      if (!monitor) continue;
      if (!monitor.active) { monitor.active = true; monitor.epoch++; monitor.policy.clearSamples(); }
      const selected = this.deps.selected(group);
      if (!selected) continue;
      if (monitor.switching) continue;
      if (monitor.target) {
        if (selected !== monitor.target.tag && this.deps.now() < monitor.target.until) continue;
        if (selected === monitor.target.tag && !monitor.target.applied) this.completed(monitor, monitor.observedSelected ?? selected, selected);
        monitor.target = null;
      }
      if (monitor.policy.observeSelection(selected)) {
        monitor.epoch++; monitor.results = null; monitor.selectedEvidence = null;
        monitor.observedSelected = selected;
        this.deps.changed("priority-manual-preference", { group, selected, preferred: monitor.policy.preferred });
      }
      monitor.observedSelected = selected;
      const generation = this.generation, epoch = monitor.epoch;
      const contextCurrent = () => generation === this.generation && monitor.active && this.used.has(group) &&
        this.monitors.get(group) === monitor && monitor.epoch === epoch && this.deps.current();
      const current = () => contextCurrent() && this.deps.selected(group) === selected;
      const key = `${generation}:${epoch}:${selected}`;
      if (monitor.schedulerKey !== key) {
        if (monitor.scheduler?.busy) continue;
        monitor.schedulerKey = key; monitor.results = null; monitor.selectedEvidence = null;
        monitor.scheduler = new PriorityProbeScheduler({
          now: this.deps.now,
          probe: async (candidate, lane) => await this.budget.run(lane, current, () => this.deps.probe(candidate, monitor.policy)) ?? { reachable: false, latencyMs: null },
          sample: async sample => {
            if (!current()) return;
            if (sample.tag === selected) monitor.selectedEvidence = sample;
            const next = monitor.policy.record(new Map([[sample.tag, sample.reachable]]), this.deps.now(), sample.at, new Map([[sample.tag, sample.latencyMs]]), new Map([[sample.tag, sample.totalMs]]));
            if (next && next !== selected) void this.switch(monitor, selected, next, current, contextCurrent);
          },
          activeDelay: reachable => monitor.policy.nextProbeDelay(selected, new Map([[selected, reachable]])),
          backupInterval: () => monitor.selectedEvidence?.reachable === false || monitor.policy.qualitySuspect(selected)
            ? monitor.policy.settings.failureIntervalMs : monitor.policy.settings.healthyIntervalMs,
          round: (at, finishedAt, reachable) => { if (current() && reachable.size === monitor.candidates.length) monitor.results = { at, finishedAt, reachable }; },
          error: this.deps.error,
        });
      }
      monitor.scheduler!.tick(key, selected, monitor.candidates, current);
    }
  }
  private async switch(monitor: PriorityMonitor, selected: string, next: string, current: () => boolean, contextCurrent: () => boolean): Promise<void> {
    if (monitor.switching || !current()) return;
    const candidate = monitor.candidates.find(item => item.tag === next);
    if (!candidate) return;
    monitor.switching = true;
    try {
      const at = this.deps.now();
      const result = await this.budget.run("active", current, () => this.deps.probe(candidate, monitor.policy));
      if (!current() || result === undefined) return;
      monitor.policy.record(new Map([[next, result.reachable]]), this.deps.now(), at, new Map([[next, result.latencyMs]]), new Map([[next, result.totalMs]]));
      const decision = monitor.policy.decision(this.deps.now());
      if (!result.reachable || decision?.tag !== next) return;
      monitor.target = { tag: next, until: this.deps.now() + 5000, applied: false, reason: decision.reason };
      const switched = await this.deps.switch(monitor.group, selected, next, () => current() && monitor.policy.decide(this.deps.now()) === next);
      if (!contextCurrent()) return;
      if (!switched) { monitor.target = null; return; }
      this.completed(monitor, selected, next);
    } catch (error) { this.deps.error(error); }
    finally { monitor.switching = false; }
  }
  private completed(monitor: PriorityMonitor, from: string, to: string): void {
    const reason = monitor.target?.reason ?? "recovered";
    monitor.target = { tag: to, until: this.deps.now() + 5000, applied: true, reason };
    monitor.policy.switched(to, this.deps.now()); monitor.epoch++;
    monitor.results = null; monitor.selectedEvidence = null;
    this.deps.changed("priority-switch-completed", { group: monitor.group, from, to, preferred: monitor.policy.preferred,
      reason: reason === "latency" ? "响应或完整建连请求持续超过地区上限，切换至健康备用" : reason === "unstable" ? "短时间内反复失败或超限，切换至稳定备用" : reason === "recovered" ? "首选恢复稳定" : "当前入口不可达，切换至健康备用" });
  }
}

/** A partial regional outage must not restart a core serving another healthy region. */
export function regionalRecoveryEvidence(evidence: ("selected-healthy" | "all-down" | "unavailable")[]): "unavailable" | "all-down" | "reachable" {
  if (evidence.includes("unavailable")) return "unavailable";
  if (evidence.includes("all-down")) return evidence.every(value => value === "all-down") ? "all-down" : "unavailable";
  return "reachable";
}
