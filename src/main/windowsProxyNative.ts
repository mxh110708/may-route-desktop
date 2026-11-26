import { app } from "electron";
import { createRequire } from "node:module";
import { join } from "node:path";

interface WindowsProxyNativeModule { readSystemProxyFlags(): number }
const loadModule = createRequire(import.meta.url);
let loaded: WindowsProxyNativeModule | null = null;

export function readSystemProxyFlags(): number {
  loaded ??= loadModule(app.isPackaged
    ? join(process.resourcesPath, "native", "windows_share.node")
    : join(app.getAppPath(), "bin", "windows", process.arch, "windows_share.node")) as WindowsProxyNativeModule;
  const flags = loaded.readSystemProxyFlags();
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffff_ffff) throw new Error("invalid Windows proxy flags");
  return flags;
}
