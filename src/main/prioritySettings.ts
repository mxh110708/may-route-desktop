import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

import type { PrioritySettings } from "../shared/priority";
export type { PrioritySettings } from "../shared/priority";

// No provider names or priorities are inferred. Explicit regional labels have latency presets.
export const DEFAULT_PRIORITY_SETTINGS: PrioritySettings = {
  enabled: true, group: "", order: [], groupOrders: {}, failureRounds: 3,
  backupSuccessRounds: 2, recoverySuccessRounds: 3, recoveryStableMs: 120000,
  failbackCooldownMs: 60000,
  probeTimeoutMs: 8000, healthyIntervalMs: 30000, failureIntervalMs: 10000,
  groupLatencyCeilings: {},
};

export function parsePrioritySettings(value: unknown): PrioritySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("故障切换配置必须是 JSON 对象");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_PRIORITY_SETTINGS, key)) throw new Error(`未知故障切换配置项：${key}`);
  const settings = { ...DEFAULT_PRIORITY_SETTINGS, ...input } as PrioritySettings;
  if (typeof settings.enabled !== "boolean" || typeof settings.group !== "string" || (settings.group !== "" && !settings.group.trim())) throw new Error("enabled 必须是布尔值，group 必须是分组名称或尚未选择的空字符串");
  if (!settings.groupLatencyCeilings || typeof settings.groupLatencyCeilings !== "object" || Array.isArray(settings.groupLatencyCeilings)) throw new Error("groupLatencyCeilings 必须为按入口组保存的上限对象");
  settings.groupLatencyCeilings = Object.fromEntries(Object.entries(settings.groupLatencyCeilings).map(([group, value]) => {
    if (!group.trim() || !Number.isInteger(value) || value !== 0 && (value < 100 || value > 60000)) throw new Error("每个入口组的延迟上限必须为 100–60000 的整数毫秒；0 表示仅检测连通性");
    return [group, value];
  }));
  if (!Array.isArray(settings.order) || settings.order.some(v => typeof v !== "string" || !v.trim()) || new Set(settings.order).size !== settings.order.length) throw new Error("order 必须是无重复节点名称的数组");
  for (const key of ["failureRounds", "backupSuccessRounds", "recoverySuccessRounds"] as const) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1 || settings[key] > 20) throw new Error(`${key} 必须为 1–20 的整数`);
  }
  for (const key of ["recoveryStableMs", "failbackCooldownMs"] as const) {
    if (!Number.isInteger(settings[key]) || settings[key] < 10000 || settings[key] > 3600000) throw new Error(`${key} 必须为 10000–3600000 的整数毫秒`);
  }
  for (const key of ["probeTimeoutMs", "healthyIntervalMs", "failureIntervalMs"] as const) {
    const min = key === "probeTimeoutMs" ? 1000 : 5000;
    const max = key === "probeTimeoutMs" ? 60000 : 600000;
    if (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max) throw new Error(`${key} 必须为 ${min}–${max} 的整数毫秒`);
  }
  const supplied = input.groupOrders;
  if (supplied !== undefined && (!supplied || typeof supplied !== "object" || Array.isArray(supplied))) throw new Error("groupOrders 必须是按入口组保存的顺序对象");
  const orders = Object.fromEntries(Object.entries(supplied ?? {}).map(([group, order]) => {
    if (!group.trim() || !Array.isArray(order) || order.some(v => typeof v !== "string" || !v.trim()) || new Set(order).size !== order.length) throw new Error("每个入口组的顺序必须是无重复节点名称的数组");
    return [group, [...order] as string[]];
  }));
  // Legacy single-group settings migrate once; an explicit per-group entry wins.
  if (settings.group && !Object.hasOwn(orders, settings.group) && settings.order.length) Object.defineProperty(orders, settings.group, { value: [...settings.order], enumerable: true, configurable: true, writable: true });
  return { ...settings, groupOrders: orders, order: [...(Object.hasOwn(orders, settings.group) ? orders[settings.group] : settings.order)] };
}

export function priorityGroupOrder(settings: PrioritySettings, group: string): string[] {
  if (settings.groupOrders && Object.hasOwn(settings.groupOrders, group)) return settings.groupOrders[group];
  return settings.group === group ? settings.order : [];
}

export function priorityGroupSettings(settings: PrioritySettings, group: string): PrioritySettings {
  return { ...settings, group, order: [...priorityGroupOrder(settings, group)], groupOrders: {},
    groupLatencyCeilings: Object.hasOwn(settings.groupLatencyCeilings, group) ? { [group]: settings.groupLatencyCeilings[group] } : {} };
}

export async function loadPrioritySettings(path: string): Promise<PrioritySettings> {
  try { return parsePrioritySettings(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { await writeFile(path, JSON.stringify(DEFAULT_PRIORITY_SETTINGS, null, 2) + "\n", { flag: "wx" }); }
    catch (createError) { if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError; }
    return parsePrioritySettings(JSON.parse(await readFile(path, "utf8")));
  }
}

export async function prioritySettingsSnapshot(path: string): Promise<{ settings: PrioritySettings; revision: string }> {
  await loadPrioritySettings(path);
  const content = await readFile(path, "utf8");
  return { settings: parsePrioritySettings(JSON.parse(content)), revision: createHash("sha256").update(content).digest("hex") };
}

export function priorityContextRevision(settingsRevision: string, profileId: string | null, content: string | null): string {
  return createHash("sha256").update(JSON.stringify([settingsRevision, profileId, content])).digest("hex");
}

let settingsWrite: Promise<unknown> = Promise.resolve();
export function savePrioritySettings(path: string, value: unknown, expectedRevision: string, assertCurrent?: () => Promise<void>): Promise<void> {
  const task = settingsWrite.catch(() => {}).then(async () => {
    const settings = parsePrioritySettings(value);
    await assertCurrent?.();
    if ((await prioritySettingsSnapshot(path)).revision !== expectedRevision) throw new Error("配置文件已在其他位置修改，请刷新后重试；未覆盖外部修改。");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { flag: "wx" });
      if ((await prioritySettingsSnapshot(path)).revision !== expectedRevision) throw new Error("保存期间配置文件发生变化，请刷新后重试。");
      await assertCurrent?.();
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  });
  settingsWrite = task;
  return task;
}
