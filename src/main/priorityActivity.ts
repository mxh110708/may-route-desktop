import { parseConfig } from "./runtimeConfig";

export interface PriorityActivityConnection {
  id: string; inbound: string; source?: string; outbound: string; fromOutbound?: string; chainList: string[];
  createdAt?: bigint; closedAt?: bigint;
}
export interface PriorityActivityEvent {
  type: number; id: string; connection?: PriorityActivityConnection;
  uplinkDelta?: bigint; downlinkDelta?: bigint; closedAt?: bigint;
}

/** Keep only live IDs and group tags. Never retain endpoints, domains or full connections. */
export class PriorityActivity {
  private groups = new Set<string>();
  private detourGroups = new Map<string, string>();
  private connections = new Map<string, string[]>();
  private recent = new Map<string, number>();
  private internalSources = new Map<string, number>();
  available = false;
  constructor(readonly graceMs = 60000) {}
  configure(groups: { tag: string; nodes: string[] }[], content?: string): void {
    this.reset(); this.groups = new Set(groups.map(group => group.tag));
    this.detourGroups.clear();
    if (!content) return;
    // The core reports selector hops but stops at a concrete outbound. Retain
    // only explicit fixed detour edges, never credentials or selector members.
    const outbounds = parseConfig(content).outbounds;
    const detours = new Map<string, string>();
    if (Array.isArray(outbounds)) for (const outbound of outbounds) {
      if (outbound && typeof outbound.tag === "string" && typeof outbound.detour === "string") detours.set(outbound.tag, outbound.detour);
    }
    for (const tag of detours.keys()) {
      const seen = new Set<string>();
      let next = tag;
      while (!seen.has(next)) {
        if (this.groups.has(next)) { this.detourGroups.set(tag, next); break; }
        seen.add(next);
        const detour = detours.get(next);
        if (!detour) break;
        next = detour;
      }
    }
  }
  reset(): void { this.connections.clear(); this.recent.clear(); this.internalSources.clear(); this.available = false; }
  disconnected(): void { this.connections.clear(); this.available = false; }
  ignoreSource(port: number, now: number): void {
    this.internalSources.set(String(port), now);
    for (const [key, at] of this.internalSources) if (now - at > this.graceMs) this.internalSources.delete(key);
  }
  private identify(connection: PriorityActivityConnection, now: number): string[] {
    if (connection.inbound.startsWith("may-priority-probe-")) return [];
    const port = connection.source?.slice(connection.source.lastIndexOf(":") + 1);
    if (port && /^(127\.0\.0\.1:|\[::1\]:)/u.test(connection.source ?? "") && now - (this.internalSources.get(port) ?? -Infinity) <= this.graceMs) return [];
    const chain = [...connection.chainList, connection.outbound, connection.fromOutbound ?? ""];
    // Membership alone does not prove a selector was traversed. A configured
    // fixed detour does; changing its entry selector affects this exit's route.
    const used = new Set<string>();
    for (const tag of chain) {
      const group = this.groups.has(tag) ? tag : this.detourGroups.get(tag);
      if (group) used.add(group);
    }
    return [...used];
  }
  ingest(message: { reset: boolean; events: PriorityActivityEvent[] }, now: number): void {
    if (message.reset) { this.connections.clear(); this.recent.clear(); }
    this.available = true;
    for (const event of message.events) {
      const closedAt = Number(event.connection?.closedAt || event.closedAt || 0n);
      if (event.type === 0 || (event.type === 2 && event.connection)) {
        if (!event.connection) continue;
        const groups = this.identify(event.connection, now);
        if (!groups.length) { this.connections.delete(event.id); continue; }
        const at = closedAt > 0 ? Math.min(now, closedAt) : now;
        this.mark(groups, at, now);
        if (closedAt === 0 && event.type !== 2) this.connections.set(event.id, groups);
      }
      const existing = this.connections.get(event.id);
      if (existing && (event.type === 2 || (event.uplinkDelta ?? 0n) > 0n || (event.downlinkDelta ?? 0n) > 0n)) {
        this.mark(existing, closedAt > 0 ? Math.min(now, closedAt) : now, now);
      }
      if (event.type === 2 || closedAt > 0) this.connections.delete(event.id);
    }
  }
  private mark(groups: string[], at: number, now: number): void {
    if (now - at > this.graceMs) return;
    for (const group of groups) this.recent.set(group, Math.max(this.recent.get(group) ?? -Infinity, at));
  }
  active(now: number): string[] {
    for (const [group, at] of this.recent) if (now - at > this.graceMs) this.recent.delete(group);
    return [...this.recent.keys()].filter(tag => this.groups.has(tag));
  }
  get retainedConnections(): number { return this.connections.size; }
}
