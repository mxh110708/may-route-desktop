import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DESKTOP_LANGUAGES, DESKTOP_TRANSLATIONS, desktopLanguageFromLocale, preferredDesktopLanguage, translateDesktop } from "../shared/translations";

test("native menus and core requests use the same two-language fallback as the dashboard", () => {
  assert.deepEqual(DESKTOP_LANGUAGES, ["en", "zh-Hans"]);
  for (const tag of ["zh", "zh-CN", "zh-Hans", "zh-TW", "zh-Hant-HK", "ZH_HK.UTF-8"]) {
    assert.equal(desktopLanguageFromLocale(tag), "zh-Hans", tag);
  }
  for (const tag of ["en", "en-US", "ru-RU", "fa-IR", "de-DE", ""]) assert.equal(desktopLanguageFromLocale(tag), "en", tag);
  assert.equal(preferredDesktopLanguage("zh-Hant", "en-US"), "zh-Hans");
  assert.equal(preferredDesktopLanguage("ru", "zh-CN"), "en");
  assert.equal(preferredDesktopLanguage("fa", "zh-CN"), "en");
  assert.equal(preferredDesktopLanguage(undefined, "zh-TW"), "zh-Hans");
  assert.equal(preferredDesktopLanguage("auto", "fr-FR"), "en");
  assert.equal(preferredDesktopLanguage("en", "zh-CN"), "en");
  assert.equal(translateDesktop("en", "Start Service"), "Start Service");
  assert.equal(translateDesktop("zh-Hans", "Start Service"), "启动服务");
  for (const value of Object.values(DESKTOP_TRANSLATIONS)) assert.equal(typeof value, "string");
});

test("installer and Chromium packages include English and Simplified Chinese only", () => {
  const builder = readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const list = (section: RegExp) => [...builder.match(section)![1].matchAll(/^\s+- (\S+)$/gmu)].map(match => match[1]);
  assert.deepEqual(list(/^electronLanguages:\s*\n((?: +.+\n)+)/mu), ["en-US", "zh-CN"]);
  assert.deepEqual(list(/^  installerLanguages:\s*\n((?:    - .+\n)+)/mu), ["en_US", "zh_CN"]);
  const installer = readFileSync(new URL("../../build/installer.nsh", import.meta.url), "utf8");
  const ids = [...installer.matchAll(/^\s*LangString .+? \$\{(LANG_\w+)\}/gmu)].map(match => match[1]);
  assert.deepEqual([...new Set(ids)].sort(), ["LANG_ENGLISH", "LANG_SIMPCHINESE"]);
});
