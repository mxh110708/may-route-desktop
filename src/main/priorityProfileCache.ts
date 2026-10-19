import { createHash } from "node:crypto";

import { priorityGroups, reconcilePriorityGroups } from "./priorityFailover";
import { priorityContextRevision } from "./prioritySettings";
import type { PrioritySettings } from "./prioritySettings";
import { buildRuntimeConfig } from "./runtimeConfig";
import type { CaptureMode } from "./runtimeConfig";
import type { PriorityPanelState, PrioritySummaryState } from "../shared/ipc";

export function prioritySummaryState(state: PriorityPanelState): PrioritySummaryState {
  return { settings: { group: state.settings.group }, running: state.running, directMode: state.directMode,
    active: state.active, preferred: state.preferred, monitoredSelected: state.monitoredSelected,
    needsReload: state.needsReload, selected: state.selected };
}

export interface PriorityProfileProjection {
  hash: string | null;
  revision: string;
  groups: { tag: string; nodes: string[] }[];
  settings: PrioritySettings;
  reconciled: boolean;
}

/** One current projection, with no raw configuration or credentials retained.
 * Read and hash the actual file on every request; timestamps are not identities.
 */
export class PriorityProfileCache {
  private entry: { key: string; value: PriorityProfileProjection } | undefined;

  constructor(private readonly build = buildRuntimeConfig) {}

  read(profileId: string | null, content: string | null, capture: CaptureMode,
    snapshot: { settings: PrioritySettings; revision: string }): PriorityProfileProjection {
    const hash = content === null ? null : createHash("sha256").update(content).digest("hex");
    const key = JSON.stringify([profileId, hash, capture, snapshot.revision]);
    if (this.entry?.key === key) return this.entry.value;
    // Forget the previous projection even if the replacement cannot be parsed.
    this.entry = undefined;
    const groups = content ? priorityGroups(this.build(content, capture)) : [];
    const settings = reconcilePriorityGroups(groups, snapshot.settings);
    const value = {
      hash, groups, settings,
      revision: priorityContextRevision(snapshot.revision, profileId, content),
      reconciled: JSON.stringify(settings.order) !== JSON.stringify(snapshot.settings.order),
    };
    for (const group of groups) { Object.freeze(group.nodes); Object.freeze(group); }
    Object.freeze(groups);
    Object.freeze(settings.order);
    Object.freeze(settings);
    Object.freeze(value);
    this.entry = { key, value };
    return value;
  }
}
