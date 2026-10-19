import { ipcMain } from "electron";
import { REPORTS_CALL } from "../shared/ipc";
import type { ProfilesResult } from "../shared/ipc";

export function registerReports(): void {
  ipcMain.handle(REPORTS_CALL, async (_event, method: string, ...arguments_: unknown[]): Promise<ProfilesResult> => {
    try {
      return await (await import("./reportHandlers")).dispatchReportCall(method, ...arguments_);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
