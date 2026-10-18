interface Chunk {
  fileName: string;
  code: string;
  isEntry: boolean;
  imports: string[];
  modules: Record<string, unknown>;
}

export function auditMainLoading(chunks: Chunk[]) {
  const byName = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
  const reached = new Set<string>();
  const visit = (name: string) => {
    if (/^dbus-next(?:\/|$)/u.test(name)) throw new Error("Linux D-Bus dependency is eager in the main process");
    const chunk = byName.get(name);
    if (!chunk || reached.has(name)) return;
    reached.add(name);
    chunk.imports.forEach(visit);
  };
  const entries = chunks.filter(chunk => chunk.isEntry);
  if (entries.length === 0) throw new Error("Main entry chunks are missing");
  entries.forEach(chunk => visit(chunk.fileName));
  const owners = chunks.filter(chunk => Object.keys(chunk.modules).some(id => id.replaceAll("\\", "/").endsWith("/main/x11Tray.ts")));
  if (owners.length === 0 || owners.some(chunk => reached.has(chunk.fileName))) {
    throw new Error("Linux tray must remain bundled and deferred");
  }
  return { initial: [...reached], linuxTray: owners.map(chunk => chunk.fileName) };
}

const deferredFeatures = {
  terminal: "/views/TerminalRuntime.tsx",
  releaseNotes: "/components/GitHubMarkdownContent.tsx",
  settings: "/views/SettingsView.tsx",
  tools: "/views/ToolsView.tsx",
  tailscale: "/views/TailscaleView.tsx",
  usbip: "/views/UsbipView.tsx",
  openConnect: "/views/OpenConnectView.tsx",
  openVPN: "/views/OpenVPNView.tsx",
  crashReports: "/views/CrashReportsView.tsx",
  oomReports: "/views/OOMReportsView.tsx",
  powerReports: "/views/PowerReportsView.tsx",
};
const heavyDependency = /\/(?:@xterm\/(?:xterm|addon-fit)|react-markdown|remark-gfm|remark-gemoji)\//u;

/** Enforce the startup boundary against the actual bundle, including shared chunks. */
export function auditRendererLoading(chunks: Chunk[]) {
  const byName = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
  const initial = new Set<string>();
  const entries = chunks.filter(chunk => chunk.isEntry).map(entry => {
    const reached = new Set<string>();
    const visit = (name: string) => {
      if (reached.has(name)) return;
      const chunk = byName.get(name);
      if (!chunk) throw new Error(`Missing renderer import: ${name}`);
      reached.add(name);
      initial.add(name);
      for (const id of Object.keys(chunk.modules)) {
        if (heavyDependency.test(id.replaceAll("\\", "/"))) {
          throw new Error(`Heavy optional dependency is eager in ${entry.fileName}: ${id}`);
        }
      }
      chunk.imports.forEach(visit);
    };
    visit(entry.fileName);
    return {
      entry: entry.fileName,
      scripts: [...reached],
      bytes: [...reached].reduce((sum, name) => sum + Buffer.byteLength(byName.get(name)!.code), 0),
    };
  });
  if (entries.length === 0) throw new Error("Renderer entry chunks are missing");
  const deferred = Object.fromEntries(Object.entries(deferredFeatures).map(([name, suffix]) => {
    const owners = chunks.filter(chunk => Object.keys(chunk.modules).some(id => id.replaceAll("\\", "/").endsWith(suffix)));
    if (owners.length === 0) throw new Error(`Optional renderer feature is missing: ${name}`);
    if (owners.some(chunk => initial.has(chunk.fileName))) throw new Error(`Optional renderer feature is eager: ${name}`);
    return [name, owners.map(chunk => chunk.fileName)];
  }));
  return { entries, deferred };
}
