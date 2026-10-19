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
  private connections = new Map<string, string[]>();
  private recent = new Map<string, number>();
  private internalSources = new Map<string, number>();
  available = false;
  constructor(readonly graceMs = 60000) {}
  configure(groups: { tag: string; nodes: string[] }[]): void {
    this.reset(); this.groups = new Set(groups.map(group => group.tag));
  }
  reset(): void { this.connections.clear(); this.recent.clear(); this.internalSources.clear(); this.available = false; }
  disconnected(): void { this.connections.clear(); this.available = false; }
  ignoreSource(port: number, now: number): void {
    this.internalSources.set(String(port), now);
    for (const [key, at] of this.internalSources) if (now - at > this.graceMs) this.internalSources.delete(key);
  }
  private identify(connection: PriorityActivityConnection, now: number): string[] {
    if (connection.inbound.startsWith("mxh-priority-probe-")) return [];
    const port = connection.source?.slice(connection.source.lastIndexOf(":") + 1);
    if (port && /^(127\.0\.0\.1:|\[::1\]:)/u.test(connection.source ?? "") && now - (this.internalSources.get(port) ?? -Infinity) <= this.graceMs) return [];
    const chain = [...connection.chainList, connection.outbound, connection.fromOutbound ?? ""];
    // A concrete node used directly does not prove a selector was traversed;
    // changing that selector would not repair the direct reference anyway.
    return [...new Set(chain.filter(tag => this.groups.has(tag)))];
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
