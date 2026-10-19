import type { Interceptor } from "@connectrpc/connect";
import { app } from "electron";

import { preferredDesktopLanguage } from "../shared/translations";
import { preferenceSnapshot } from "./database";

export function preferredLocale(): string {
  const language = preferenceSnapshot(["language"]).language;
  return preferredDesktopLanguage(language, app.getLocale());
}

export const localeInterceptor: Interceptor = (next) => async (request) => {
  if (!request.header.has("accept-language")) {
    request.header.set("accept-language", preferredLocale());
  }
  return next(request);
};
