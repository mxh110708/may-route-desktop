import { BrowserWindow, app, ipcMain, shell } from "electron";

import { APP_CALL } from "../shared/ipc";
import type { ProfilesResult } from "../shared/ipc";
import { shareFile } from "./sharing";
import { resizeTrayMenu } from "./trayMenu";

export function registerApplication(showMainWindow: (route?: string) => void) {
  ipcMain.handle(
    APP_CALL,
    async (event, method: string, ...arguments_: unknown[]): Promise<ProfilesResult> => {
      try {
        switch (method) {
          case "version":
            return { ok: true, value: __APP_VERSION__ };
          case "listFonts":
            return { ok: true, value: await (await import("./interfaceFonts")).listInterfaceFonts() };
          case "readFont":
            return { ok: true, value: await (await import("./interfaceFonts")).readInterfaceFont(arguments_[0]) };
          case "selectFont":
            await (await import("./interfaceFonts")).selectInterfaceFont(arguments_[0]);
            return { ok: true, value: undefined };
          case "importFont": {
            const window = BrowserWindow.fromWebContents(event.sender);
            if (!window) throw new Error("Font import window unavailable.");
            return { ok: true, value: await (await import("./interfaceFonts")).importInterfaceFont(window) };
          }
          case "openDataDirectory": {
            const error = await shell.openPath(app.getPath("userData"));
            if (error) throw new Error(error);
            return { ok: true, value: undefined };
          }
          case "resizeTrayMenu":
            resizeTrayMenu(event.sender, arguments_[0]);
            return { ok: true, value: undefined };
          case "shareFile": {
            const window = BrowserWindow.fromWebContents(event.sender);
            if (window === null) {
              throw new Error("sharing window is unavailable");
            }
            const [fileName, data] = arguments_;
            if (typeof fileName !== "string" || !(data instanceof Uint8Array)) {
              throw new Error("invalid shared file");
            }
            await shareFile(window, fileName, data);
            return { ok: true, value: undefined };
          }
          case "showMainWindow": {
            const route = arguments_[0];
            if (route !== undefined && (typeof route !== "string" || !["overview", "groups", "connections", "logs", "settings", "settings/app", "settings/ports"].includes(route))) throw new Error("Invalid application route.");
            showMainWindow(route as string | undefined);
            return { ok: true, value: undefined };
          }
          // window.close() in a sandboxed renderer destroys the web contents
          // without firing the window's close event (verified against this
          // Electron build), so the tray menu window cannot dismiss itself; it
          // asks the main process to close it, which the tray menu window
          // intercepts into a hide.
          case "closeTrayMenu":
            BrowserWindow.fromWebContents(event.sender)?.close();
            return { ok: true, value: undefined };
          case "quit":
            app.quit();
            return { ok: true, value: undefined };
          default:
            return { ok: false, error: `unknown app method: ${method}` };
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );
}
