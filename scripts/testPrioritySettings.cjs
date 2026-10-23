// Hidden, isolated renderer test of the real editor. Never connects to a daemon,
// touches installed application data, shows a window, or moves the desktop cursor.
const { app, BrowserWindow } = require("electron");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createRequire } = require("node:module");
const { build } = createRequire(require.resolve("vite"))("esbuild");
const directory = mkdtempSync(join(tmpdir(), "route-priority-editor-"));
app.setPath("userData", join(directory, "user-data"));
app.disableHardwareAcceleration();
// Never use console output in Electron fixtures: a closed parent pipe must not
// create an EPIPE error dialog on the user's desktop. Results go to one file.
const resultPath = process.env.MAY_PRIORITY_UI_RESULT || join(directory, "result.json");
let window;
app.whenReady().then(async () => {
  const dashboard = resolve(__dirname, "../dashboard");
  const preferencesPath = join(directory, "preferences.cjs");
  await build({
    entryPoints: [resolve(__dirname, "../src/main/preferences.ts")],
    bundle: true, platform: "node", format: "cjs", packages: "external", outfile: preferencesPath,
    alias: { "@dashboard": join(dashboard, "src") }, logLevel: "silent",
  });
  require(preferencesPath).registerPreferences();
  const preloadPath = join(directory, "preload.cjs");
  writeFileSync(preloadPath, `
    const { contextBridge, ipcRenderer } = require("electron");
    contextBridge.exposeInMainWorld("fixturePreferences", {
      initial: ipcRenderer.sendSync("preferences:snapshot"),
      set: (name, value) => ipcRenderer.invoke("preferences:call", "set", name, value),
      onChanged: listener => ipcRenderer.on("preferences:changed", (_event, name, value) => listener(name, value)),
    });
  `);
  await build({
    stdin: { contents: renderer, resolveDir: dashboard, loader: "tsx" },
    bundle: true, format: "iife", outfile: join(directory, "renderer.js"), jsx: "automatic", logLevel: "silent",
    alias: { react: join(dashboard, "node_modules/react"), "react-dom": join(dashboard, "node_modules/react-dom") },
  });
  writeFileSync(join(directory, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="renderer.js"></script>');
  window = new BrowserWindow({ show: false, webPreferences: { preload: preloadPath, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
  await window.loadFile(join(directory, "index.html"));
  const result = await window.webContents.executeJavaScript("window.runPriorityFixture()");
  await window.loadFile(join(directory, "index.html"));
  const restored = await window.webContents.executeJavaScript('window.fixturePreferences.initial["priority-editor-groups"]');
  if (restored?.fixture !== "West" || restored?.other !== "Europe") throw new Error("editor selections did not survive a fresh renderer and desktop preference snapshot");
  result.checks.push("fresh renderer restores choices from desktop SQLite preferences");
  writeFileSync(resultPath, JSON.stringify({ passed: true, ...result }, null, 2));
  window.destroy(); app.exit(0);
}).catch(error => {
  writeFileSync(resultPath, JSON.stringify({ passed: false, error: String(error.stack || error) }, null, 2));
  window?.destroy(); app.exit(1);
});

const renderer = String.raw`
import { createRoot } from "react-dom/client";
import { PrioritySettingsPanel } from "./src/views/PrioritySettingsPanel";
import { I18nProvider } from "./src/app/i18n";
import { saveLanguagePreference } from "./src/app/i18nCore";
import { configurePreferenceStorage } from "./src/lib/storage";
const preferenceValues = { ...window.fixturePreferences.initial };
const preferenceWrites = [];
const preferenceListeners = new Set();
window.fixturePreferences.onChanged((name, value) => {
  preferenceValues[name] = value;
  for (const listener of preferenceListeners) listener(name);
});
configurePreferenceStorage({
  get: name => structuredClone(preferenceValues[name]),
  set: (name, value) => {
    preferenceValues[name] = structuredClone(value);
    preferenceWrites.push(window.fixturePreferences.set(name, value).then(result => {
      if (!result.ok) throw new Error(result.error);
    }));
  },
  remove: name => { delete preferenceValues[name]; },
  subscribe: listener => { preferenceListeners.add(listener); return () => preferenceListeners.delete(listener); },
});
Object.defineProperty(document, "hidden", { get: () => false });
saveLanguagePreference("zh-Hans");
const settings = { enabled: true, group: "West", order: ["w2", "w1"], groupOrders: { West: ["w2", "w1"] },
  failureRounds: 3, backupSuccessRounds: 2, recoverySuccessRounds: 3, recoveryStableMs: 120000,
  failbackCooldownMs: 60000, probeTimeoutMs: 8000, healthyIntervalMs: 30000, failureIntervalMs: 10000,
  groupLatencyCeilings: {} };
let state = { settings, revision: "1", profileId: "fixture", path: "fixture.json", running: true, directMode: false,
  usageAware: true, activityAvailable: true, active: true, monitoredSelected: true, needsReload: false,
  selected: "w1", preferred: "w1", lastSwitch: null,
  activeGroups: [{ group: "West", selected: "w1", preferred: "w1", monitoredSelected: true }],
  groups: [{ tag: "West", nodes: ["w1", "w2"] }, { tag: "Europe", nodes: ["e1", "e2"] }] };
let saves = [], reloads = 0, listeners = new Set();
const host = { profiles: { priorityState: async () => structuredClone(state),
  prioritySave: async (next, revision) => {
    if (revision !== state.revision) throw new Error("stale save");
    saves.push(structuredClone(next)); state = { ...state, settings: structuredClone(next), revision: String(Number(revision) + 1) };
    return structuredClone(state);
  }, priorityApply: async () => { reloads++; },
  onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); } } };
let root = createRoot(document.getElementById("root"));
const panel = () => <I18nProvider><PrioritySettingsPanel host={host} /></I18nProvider>;
root.render(panel());
const delay = () => new Promise(resolve => setTimeout(resolve, 10));
async function wait(test, label) { for (let i = 0; i < 200; i++) { if (test()) return; await delay(); } throw new Error("timeout: " + label); }
function check(test, label) { if (!test) throw new Error(label); }
const button = text => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === text);
const order = () => [...document.querySelectorAll("li[data-node]")].map(n => n.dataset.node).join(",");
const custom = () => document.querySelector('[aria-label="自定义顺序"]').getAttribute("aria-checked");
async function selectField(field, option) {
  const label = [...document.querySelectorAll("label")].find(l => l.textContent === field);
  document.getElementById(label.htmlFor).click();
  await wait(() => [...document.querySelectorAll('[role="option"]')].some(b => b.textContent.trim() === option), "dropdown");
  [...document.querySelectorAll('[role="option"]')].find(b => b.textContent.trim() === option).click(); await delay();
}
const select = group => selectField("入口代理组", group);
const limitInput = (labelText = "本入口组代理响应上限（毫秒）") => {
  const label = [...document.querySelectorAll("label")].find(l => l.textContent === labelText);
  return label && document.getElementById(label.htmlFor);
};
async function editLimit(value) {
  const input = limitInput();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true })); await delay();
}
window.runPriorityFixture = async () => {
  await wait(() => order() === "w2,w1", "initial state");
  state = { ...state, initializing: true, needsReload: true, active: false, activeGroups: [], activityAvailable: false };
  for (const listener of listeners) listener();
  await wait(() => document.body.textContent.includes("正在初始化监测"), "initializing state");
  check(!button("重载并应用") && !document.body.textContent.includes("缺少匹配的探测入口"), "initialization must not claim a missing runtime");
  state = { ...state, initializing: false };
  for (const listener of listeners) listener();
  await wait(() => button("重载并应用"), "verified missing runtime");
  check(reloads === 0, "a confirmed mismatch does not reload automatically");
  state = { ...state, needsReload: false, active: true, activityAvailable: true,
    activeGroups: [{ group: "West", selected: "w1", preferred: "w1", monitoredSelected: true }] };
  for (const listener of listeners) listener();
  await wait(() => !button("重载并应用") && !document.body.textContent.includes("正在初始化监测"), "restored monitor");
  check(custom() === "true" && button("保存配置").disabled, "initial custom order");
  await select("Europe"); check(custom() === "false" && order() === "e1,e2", "Europe follows config");
  document.querySelector('[aria-label="自定义顺序"]').click(); await delay();
  document.querySelector('[aria-label="上移 e2"]').click(); await delay();
  check(order() === "e2,e1", "Europe edit");
  await select("West"); check(custom() === "true" && order() === "w2,w1", "West custom restored");
  check(!button("保存配置").disabled, "unsaved Europe retained");
  await select("Europe"); check(order() === "e2,e1", "Europe draft retained");
  button("保存配置").click(); await wait(() => saves.length === 1 && button("保存配置").disabled, "save once");
  await select("West"); check(custom() === "true" && order() === "w2,w1" && button("保存配置").disabled, "no duplicate West save");
  await select("Europe"); check(custom() === "true" && order() === "e2,e1" && button("保存配置").disabled, "no duplicate Europe save");
  await select("West");
  check(state.settings.group === "Europe", "viewing West must not rewrite the saved policy group");
  root.unmount(); root = createRoot(document.getElementById("root")); root.render(panel());
  await wait(() => order() === "w2,w1", "reopen last viewed West without saving again");
  check(custom() === "true" && order() === "w2,w1", "orders survive reopen");
  check(JSON.stringify(saves[0].groupOrders) === JSON.stringify({ West: ["w2", "w1"], Europe: ["e2", "e1"] }), "both groups saved together");
  const details = [...document.querySelectorAll("details")].find(item => item.querySelector("summary").textContent === "高延迟切换");
  check(!details.open, "latency controls start collapsed"); details.querySelector("summary").click(); await delay();
  check(limitInput().value === "", "unknown West label does not guess a region");
  await selectField("套用地区预设", "美国西部 · 450 ms");
  check(limitInput().value === "450", "regional preset applies");
  await select("Europe"); check(limitInput().value === "600", "Europe auto preset");
  await editLimit("900"); await select("West"); check(limitInput().value === "450", "West limit retained");
  button("保存配置").click(); await wait(() => saves.length === 2 && button("保存配置").disabled, "save both limits");
  check(saves[1].groupLatencyCeilings.West === 450 && saves[1].groupLatencyCeilings.Europe === 900, "per-group ceilings saved together");
  await select("Europe"); check(limitInput().value === "900" && button("保存配置").disabled, "viewing limit requires no second save");
  button("恢复地区默认值").click(); await delay(); check(limitInput().value === "600", "restore auto preset");
  await editLimit(""); check(limitInput().value === "", "empty value disables this group");
  await editLimit("99"); check(button("保存配置").disabled, "invalid ceiling blocks save");
  await editLimit(""); button("保存配置").click(); await wait(() => saves.length === 3 && button("保存配置").disabled, "save explicit off");
  check(saves[2].groupLatencyCeilings.Europe === 0 && saves[2].groupLatencyCeilings.West === 450, "off is per group");
  await select("West");
  const primary = structuredClone(state);
  state = { ...state, profileId: "other" };
  for (const listener of listeners) listener();
  await wait(() => order() === "e2,e1", "another profile does not inherit the current editor group");
  await select("West"); await select("Europe");
  state = structuredClone(primary);
  for (const listener of listeners) listener();
  await wait(() => order() === "w2,w1", "original profile restores its last viewed group");
  state = { ...state, profileId: "other" };
  for (const listener of listeners) listener();
  await wait(() => order() === "e2,e1", "second profile restores its independent choice");
  state = { ...state, groups: state.groups.filter(group => group.tag === "West") };
  for (const listener of listeners) listener();
  await wait(() => order() === "w2,w1", "removed group falls back to an existing group");
  state = { ...state, groups: [] };
  for (const listener of listeners) listener();
  await wait(() => order() === "", "empty profile does not retain a nonexistent group");
  state = { ...structuredClone(primary), profileId: null };
  for (const listener of listeners) listener();
  await wait(() => order() === "e2,e1", "no selected profile uses a valid fallback");
  await select("West");
  check(!Object.hasOwn(preferenceValues["priority-editor-groups"], "null"), "no shared null-profile preference");
  state = structuredClone(primary);
  for (const listener of listeners) listener();
  await wait(() => order() === "w2,w1", "return to original profile after deletion and empty states");
  check(saves.length === 3 && state.settings.group === "Europe", "editor memory must not save or rewrite policy");
  check(state.activeGroups.length === 1 && state.activeGroups[0].group === "West", "viewing groups must not change actual monitoring");
  const invalidPreference = await window.fixturePreferences.set("priority-editor-groups", { fixture: [] });
  check(!invalidPreference.ok, "desktop preference IPC rejects malformed selections");
  saveLanguagePreference("en"); root.unmount(); root = createRoot(document.getElementById("root")); root.render(panel());
  await wait(() => limitInput("Proxy response limit for this group (ms)"), "English latency controls");
  check(document.body.textContent.includes("Three consecutive over-limit probes"), "English rule description");
  check(!document.body.textContent.includes("baseline multiplier"), "no learning controls remain");
  state = { ...state, initializing: true, needsReload: true, active: false, activeGroups: [] };
  for (const listener of listeners) listener();
  await wait(() => document.body.textContent.includes("Initializing monitoring"), "English initialization status");
  check(!button("重载并应用") && !document.body.textContent.includes("正在初始化监测"), "English initializing view remains neutral");
  check(reloads === 0, "save must not reload the core");
  await Promise.all(preferenceWrites);
  root.unmount();
  return { saves: saves.length, reloads, checks: ["West-Europe-West custom order", "unsaved cross-group edits", "one save retains both groups", "no repeated save on region view change", "reopen remembers last viewed group without policy save", "independent editor selection per profile", "removed group and empty profile fallback", "null profile cannot overwrite stored choices", "viewing does not change actual monitoring", "desktop IPC validates editor preferences", "regional presets and independent ceilings", "restore region default", "per-group disable", "invalid ceiling rejected", "English controls", "no learning controls", "no core restart"] };
};
`;
