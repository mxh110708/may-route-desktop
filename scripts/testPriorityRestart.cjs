// Two fully separate Electron processes; isolated data, hidden renderer, no daemon.
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const directory = mkdtempSync(join(tmpdir(), "route-priority-restart-"));
const output = process.env.MAY_PRIORITY_UI_RESULT || join(directory, "result.json");
const results = [];
try {
  for (const phase of ["initial", "restore"]) {
    const resultPath = join(directory, `${phase}.json`);
    const child = spawnSync(require("electron"), [join(__dirname, "testPrioritySettings.cjs")], {
      env: { ...process.env, MAY_PRIORITY_UI_DIRECTORY: directory, MAY_PRIORITY_UI_PHASE: phase, MAY_PRIORITY_UI_RESULT: resultPath },
      timeout: 60000, windowsHide: true, stdio: "pipe",
    });
    if (child.error) throw child.error;
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    if (child.status !== 0 || !result.passed) throw new Error(result.error || `editor ${phase} failed`);
    results.push(result);
  }
  writeFileSync(output, JSON.stringify({ passed: true, processes: results.length, saves: results.reduce((n, r) => n + r.saves, 0), reloads: results.reduce((n, r) => n + r.reloads, 0), checks: results.flatMap(r => r.checks) }, null, 2));
} catch (error) {
  writeFileSync(output, JSON.stringify({ passed: false, error: String(error.stack || error) }, null, 2));
  process.exitCode = 1;
}
