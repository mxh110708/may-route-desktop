import assert from "node:assert/strict";
import test from "node:test";
import { auditMainLoading, auditRendererLoading } from "./rendererLoading";

function fixture() {
  const chunk = (fileName: string, module: string, isEntry = false, imports: string[] = []) => ({
    fileName, code: "0123456789", isEntry, imports, modules: { [module]: {} },
  });
  return [
    chunk("index.js", "/app/main.tsx", true, ["shared.js"]),
    chunk("tray.js", "/app/tray.tsx", true, ["shared.js"]),
    chunk("shared.js", "/app/shared.ts"),
    chunk("terminal.js", "/app/views/TerminalRuntime.tsx", false, ["xterm.js"]),
    chunk("xterm.js", "/app/node_modules/@xterm/xterm/lib/xterm.js"),
    chunk("notes.js", "/app/components/GitHubMarkdownContent.tsx", false, ["markdown.js"]),
    chunk("markdown.js", "/app/node_modules/react-markdown/lib/index.js"),
    ...["SettingsView", "ToolsView", "TailscaleView", "UsbipView", "OpenConnectView", "OpenVPNView", "CrashReportsView", "OOMReportsView", "PowerReportsView"].map(name => chunk(`${name}.js`, `/app/views/${name}.tsx`)),
  ];
}

test("optional features remain bundled without loading into either entry", () => {
  const result = auditRendererLoading(fixture());
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].bytes, 20);
  assert.deepEqual(result.deferred.terminal, ["terminal.js"]);
  assert.deepEqual(result.deferred.releaseNotes, ["notes.js"]);
});

test("an indirect eager shared dependency fails the build", () => {
  const chunks = fixture();
  chunks.find(chunk => chunk.fileName === "shared.js")!.imports.push("xterm.js");
  assert.throws(() => auditRendererLoading(chunks), /Heavy optional dependency is eager/);
});

test("features cannot disappear or move back into the entry graph", () => {
  assert.throws(() => auditRendererLoading(fixture().filter(chunk => chunk.fileName !== "notes.js")), /feature is missing: releaseNotes/);
  const chunks = fixture();
  chunks.find(chunk => chunk.fileName === "index.js")!.imports.push("notes.js");
  assert.throws(() => auditRendererLoading(chunks), /Heavy optional dependency is eager|feature is eager/);
});

test("Windows startup cannot eagerly import the Linux tray protocol stack", () => {
  const chunks: Parameters<typeof auditMainLoading>[0] = [
    { fileName: "index.js", code: "", isEntry: true, imports: [], modules: { "/app/main/index.ts": {} } },
    { fileName: "x11.js", code: "", isEntry: false, imports: ["dbus-next"], modules: { "/app/main/x11Tray.ts": {} } },
  ];
  assert.deepEqual(auditMainLoading(chunks).linuxTray, ["x11.js"]);
  chunks[0].imports.push("x11.js");
  assert.throws(() => auditMainLoading(chunks), /Linux D-Bus dependency is eager/);
  assert.throws(() => auditMainLoading(chunks.slice(0, 1)), /Linux tray must remain/);
});
