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
const resultPath = process.env.MXH_PRIORITY_UI_RESULT || join(directory, "result.json");
let window;
app.whenReady().then(async () => {
  const dashboard = resolve(__dirname, "../dashboard");
  await build({
    stdin: { contents: renderer, resolveDir: dashboard, loader: "tsx" },
    bundle: true, format: "iife", outfile: join(directory, "renderer.js"), jsx: "automatic", logLevel: "silent",
    alias: { react: join(dashboard, "node_modules/react"), "react-dom": join(dashboard, "node_modules/react-dom") },
  });
  writeFileSync(join(directory, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="renderer.js"></script>');
  window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
  await window.loadFile(join(directory, "index.html"));
  const result = await window.webContents.executeJavaScript("window.runPriorityFixture()");
  writeFileSync(resultPath, JSON.stringify({ passed: true, ...result }, null, 2));
  window.destroy(); app.exit(0);
}).catch(error => {
  writeFileSync(resultPath, JSON.stringify({ passed: false, error: String(error.stack || error) }, null, 2));
  window?.destroy(); app.exit(1);
});

const renderer = String.raw`
import { createRoot } from "react-dom/client";
import { PrioritySettingsPanel } from "./src/views/PrioritySettingsPanel";
Object.defineProperty(document, "hidden", { get: () => false });
const settings = { enabled: true, group: "West", order: ["w2", "w1"], groupOrders: { West: ["w2", "w1"] },
  failureRounds: 3, backupSuccessRounds: 2, recoverySuccessRounds: 3, recoveryStableMs: 120000,
  failbackCooldownMs: 60000, probeTimeoutMs: 8000, healthyIntervalMs: 30000, failureIntervalMs: 10000 };
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
root.render(<PrioritySettingsPanel host={host} />);
const delay = () => new Promise(resolve => setTimeout(resolve, 10));
async function wait(test, label) { for (let i = 0; i < 200; i++) { if (test()) return; await delay(); } throw new Error("timeout: " + label); }
function check(test, label) { if (!test) throw new Error(label); }
const button = text => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === text);
const order = () => [...document.querySelectorAll("li[data-node]")].map(n => n.dataset.node).join(",");
const custom = () => document.querySelector('[aria-label="自定义顺序"]').getAttribute("aria-checked");
async function select(group) {
  const label = [...document.querySelectorAll("label")].find(l => l.textContent === "入口代理组");
  document.getElementById(label.htmlFor).click();
  await wait(() => [...document.querySelectorAll('[role="option"]')].some(b => b.textContent.trim() === group), "dropdown");
  [...document.querySelectorAll('[role="option"]')].find(b => b.textContent.trim() === group).click(); await delay();
}
window.runPriorityFixture = async () => {
  await wait(() => order() === "w2,w1", "initial state");
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
  root.unmount(); root = createRoot(document.getElementById("root")); root.render(<PrioritySettingsPanel host={host} />);
  await wait(() => order() === "e2,e1", "reopen editor"); await select("West");
  check(custom() === "true" && order() === "w2,w1", "orders survive reopen");
  check(JSON.stringify(saves[0].groupOrders) === JSON.stringify({ West: ["w2", "w1"], Europe: ["e2", "e1"] }), "both groups saved together");
  check(reloads === 0, "save must not reload the core");
  root.unmount();
  return { saves: saves.length, reloads, checks: ["West-Europe-West custom order", "unsaved cross-group edits", "one save retains both groups", "no repeated save on region view change", "reopen retains orders", "no core restart"] };
};
`;
