import { BrowserWindow, app, dialog } from "electron";
import { join } from "node:path";

import { FontLibrary } from "./fontLibrary";
import { saveRendererPreference } from "./preferences";

function library() { return new FontLibrary(join(app.getPath("userData"), "interface-fonts")); }

export async function listInterfaceFonts() { return library().list(); }
export async function readInterfaceFont(id: unknown) {
  if (typeof id !== "string") throw new Error("Invalid font ID.");
  return library().data(id);
}
export async function selectInterfaceFont(id: unknown) {
  if (id !== "default" && id !== "wenkai") await readInterfaceFont(id);
  saveRendererPreference("interface-font", id);
}
export async function importInterfaceFont(window: BrowserWindow) {
  const result = await dialog.showOpenDialog(window, {
    title: "Import interface font / 导入界面字体",
    filters: [{ name: "TrueType / OpenType", extensions: ["ttf", "otf"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return library().import(result.filePaths[0]);
}
