import { execFile } from "node:child_process";
import { join } from "node:path";

import { app, BrowserWindow, ipcMain, session } from "electron";
import { compare, gt, prerelease, valid } from "semver";

import { InstallUpdateResult } from "../shared/gen/experimental/boxdd/desktop_service_pb";
import { UPDATES_CALL, UPDATES_STATE_CHANGED } from "../shared/ipc";
import type {
  AppUpdateInfo,
  ProfilesResult,
  UpdateInstallResult,
  UpdatesState,
  UpdateTrack,
} from "../shared/ipc";
import { applicationCacheDirectory } from "./appCache";
import { parseBooleanPreference, Preference } from "./database";
import { desktopService } from "./daemon";
import { normalizeUpdateProxyAddress, UpdateConnection, type UpdateFetch } from "./updateConnection";
import { downloadUpdateFile } from "./updateDownload";
import { UpdateInstallation } from "./updateInstallation";
import {
  isChannelVersion,
  isTrustedDownloadURL,
  releasesURL,
  selectWindowsAsset,
  updatesSupported,
  type UpdateAsset,
} from "./updateSource";
import { userAgent } from "./userAgent";

const RELEASES_URL = releasesURL(__CUSTOM_BUILD__);
const RELEASES_PER_PAGE = 100;
const RELEASES_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const EXIT_CODE_CANCELLED = 1223;
const EXIT_CODE_LAUNCH_FAILED = 1224;

const UPDATES_SUPPORTED = updatesSupported(
  __CUSTOM_BUILD__,
  process.platform,
  process.arch,
);
const APP_IS_PRERELEASE = prerelease(__APP_VERSION__) !== null;

function parseString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("invalid string preference");
  }
  return value;
}

function parseUpdateTrack(value: unknown): UpdateTrack {
  if (value !== "stable" && value !== "beta") {
    throw new Error("invalid update track preference");
  }
  return value;
}

const updateTrackPreference = new Preference<UpdateTrack>(
  "update_track",
  APP_IS_PRERELEASE ? "beta" : "stable",
  parseUpdateTrack,
);
const checkUpdateEnabledPreference = new Preference(
  "check_update_enabled",
  false,
  parseBooleanPreference,
);
const updateCheckPromptedPreference = new Preference(
  "update_check_prompted",
  false,
  parseBooleanPreference,
);
const cachedUpdateInfoPreference = new Preference("cached_update_info", "", parseString);
const lastShownUpdateVersionPreference = new Preference(
  "last_shown_update_version",
  "",
  parseString,
);
const githubTokenPreference = new Preference("github_token", "", parseString);
const updateProxyPreference = new Preference("update_proxy", "", normalizeUpdateProxyAddress);
const updateConnection = new UpdateConnection(() =>
  session.fromPartition("mxh-route-updates", { cache: false }),
);
const installation = new UpdateInstallation();

function currentTrack(): UpdateTrack {
  if (__CUSTOM_BUILD__) {
    return "beta";
  }
  return updateTrackPreference.get();
}

const runtime = {
  info: null as AppUpdateInfo | null,
  checking: false,
  downloading: false,
  cancelling: false,
  installing: false,
  downloadProgress: 0,
};

function updatesState(): UpdatesState {
  return {
    supported: UPDATES_SUPPORTED,
    githubTokenSupported: !__CUSTOM_BUILD__,
    trackSelectable: !__CUSTOM_BUILD__,
    track: currentTrack(),
    checkUpdateEnabled: checkUpdateEnabledPreference.get(),
    proxyAddress: updateProxyPreference.get(),
    prompted: updateCheckPromptedPreference.get(),
    info: runtime.info,
    checking: runtime.checking,
    downloading: runtime.downloading,
    cancelling: runtime.cancelling,
    installing: runtime.installing,
    downloadProgress: runtime.downloadProgress,
  };
}

function broadcastState(): void {
  const state = updatesState();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(UPDATES_STATE_CHANGED, state);
    }
  }
}

function shouldIncludeVersion(version: string, track: UpdateTrack): boolean {
  const normalizedVersion = valid(version);
  if (normalizedVersion === null || !isChannelVersion(__CUSTOM_BUILD__, normalizedVersion)) {
    return false;
  }
  return gt(normalizedVersion, __APP_VERSION__) || (track === "stable" && APP_IS_PRERELEASE);
}

function setUpdateInfo(info: AppUpdateInfo | null): void {
  runtime.info = info;
  if (info === null) {
    cachedUpdateInfoPreference.set("");
    lastShownUpdateVersionPreference.set("");
  } else {
    cachedUpdateInfoPreference.set(JSON.stringify(info));
  }
  broadcastState();
}

function parseCachedUpdateInfo(cached: string): AppUpdateInfo | null {
  let value: unknown;
  try {
    value = JSON.parse(cached);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.versionName !== "string" ||
    typeof candidate.releaseURL !== "string" ||
    typeof candidate.downloadURL !== "string" ||
    typeof candidate.releaseNotes !== "string" ||
    typeof candidate.isPrerelease !== "boolean" ||
    typeof candidate.fileSize !== "number" ||
    !isTrustedDownloadURL(__CUSTOM_BUILD__, candidate.downloadURL)
  ) {
    return null;
  }
  return {
    versionName: candidate.versionName,
    releaseURL: candidate.releaseURL,
    downloadURL: candidate.downloadURL,
    releaseNotes: candidate.releaseNotes,
    isPrerelease: candidate.isPrerelease,
    fileSize: candidate.fileSize,
  };
}

function loadCachedUpdate(): boolean {
  const cached = cachedUpdateInfoPreference.get();
  if (cached === "") {
    return false;
  }
  const info = parseCachedUpdateInfo(cached);
  const track = currentTrack();
  if (
    info === null ||
    (track === "stable" && info.isPrerelease) ||
    !shouldIncludeVersion(info.versionName, track)
  ) {
    setUpdateInfo(null);
    return false;
  }
  runtime.info = info;
  return lastShownUpdateVersionPreference.get() !== info.versionName;
}

type GitHubAsset = UpdateAsset;

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  body?: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubAsset[];
}

async function fetchReleases(
  track: UpdateTrack,
  githubToken: string,
  fetchUpdate: UpdateFetch,
): Promise<GitHubRelease[]> {
  const releases: GitHubRelease[] = [];
  const headers = new Headers({
    "Accept": "application/vnd.github+json",
    "User-Agent": userAgent(),
  });
  const token = __CUSTOM_BUILD__ ? "" : githubToken.trim();
  if (token !== "") {
    headers.set("Authorization", `token ${token}`);
  }
  let page = 1;
  for (;;) {
    const response = await fetchUpdate(
      `${RELEASES_URL}?per_page=${RELEASES_PER_PAGE}&page=${page}`,
      {
        headers,
        signal: AbortSignal.timeout(RELEASES_REQUEST_TIMEOUT_MILLISECONDS),
      },
    );
    if (!response.ok) {
      throw new Error(`fetch releases: HTTP ${response.status}`);
    }
    const pageReleases = (await response.json()) as GitHubRelease[];
    releases.push(...pageReleases);
    if (track !== "stable" || pageReleases.length < RELEASES_PER_PAGE) {
      return releases;
    }
    page += 1;
  }
}

function findWindowsAsset(version: string, assets: GitHubAsset[]): GitHubAsset | null {
  return selectWindowsAsset(__CUSTOM_BUILD__, process.arch, version, assets);
}

async function checkForUpdate(): Promise<AppUpdateInfo | null> {
  if (!UPDATES_SUPPORTED) {
    throw new Error("updates are not supported on this platform");
  }
  if (runtime.checking) {
    throw new Error("update check already in progress");
  }
  if (runtime.downloading || runtime.installing) return runtime.info;
  runtime.checking = true;
  broadcastState();
  try {
    const track = currentTrack();
    const releases = await updateConnection.run(updateProxyPreference.get(), (fetchUpdate) =>
      fetchReleases(track, githubTokenPreference.get(), fetchUpdate),
    );
    if (currentTrack() !== track) {
      return runtime.info;
    }
    let best: AppUpdateInfo | null = null;
    for (const release of releases) {
      if (release.draft) {
        continue;
      }
      const version = release.tag_name.startsWith("v")
        ? release.tag_name.slice(1)
        : release.tag_name;
      if (!shouldIncludeVersion(version, track)) {
        continue;
      }
      const asset = findWindowsAsset(version, release.assets);
      if (asset === null) {
        continue;
      }
      if (track === "stable" && release.prerelease) {
        continue;
      }
      if (best !== null && compare(version, best.versionName) <= 0) {
        continue;
      }
      best = {
        versionName: version,
        releaseURL: release.html_url,
        downloadURL: asset.browser_download_url,
        releaseNotes: release.body ?? "",
        isPrerelease: release.prerelease,
        fileSize: asset.size,
      };
    }
    setUpdateInfo(best);
    return best;
  } finally {
    runtime.checking = false;
    broadcastState();
  }
}

function reportDownloadProgress(progress: number): void {
  if (progress < 1 && Math.abs(progress - runtime.downloadProgress) < 0.01) {
    return;
  }
  runtime.downloadProgress = progress;
  broadcastState();
}

async function downloadUpdate(info: AppUpdateInfo, signal: AbortSignal): Promise<string> {
  if (!isTrustedDownloadURL(__CUSTOM_BUILD__, info.downloadURL)) {
    throw new Error("untrusted update download URL");
  }
  const proxy = updateProxyPreference.get();
  try {
    return await updateConnection.run(proxy, (fetchUpdate) => downloadUpdateFile({
      directory: join(applicationCacheDirectory(), "updates"),
      url: info.downloadURL,
      fileSize: info.fileSize,
      fetchUpdate,
      signal,
      userAgent: userAgent(),
      onProgress: reportDownloadProgress,
    }), signal);
  } catch (error) {
    signal.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Update download (${proxy === "" ? "direct connection" : `proxy ${proxy}`}): ${reason}`);
  }
}

function launchUpdateInstallerElevated(installerPath: string): Promise<boolean> {
  const quotedInstallerPath = `'${installerPath.replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `Start-Process -FilePath ${quotedInstallerPath} -ArgumentList '--updated','--force-run' -Verb RunAs`,
    "exit 0",
    "} catch {",
    "if ($_.Exception.InnerException -is [System.ComponentModel.Win32Exception] -and $_.Exception.InnerException.NativeErrorCode -eq 1223) {",
    `exit ${EXIT_CODE_CANCELLED}`,
    "}",
    `exit ${EXIT_CODE_LAUNCH_FAILED}`,
    "}",
  ].join("\n");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true },
      (error) => {
        if (error === null) {
          resolve(true);
          return;
        }
        if (typeof error.code !== "number") {
          reject(error);
          return;
        }
        if (error.code === EXIT_CODE_CANCELLED) {
          resolve(false);
          return;
        }
        reject(new Error(`failed to launch the elevated update installer (${error.code})`));
      },
    );
  });
}

function resetInstallationState(): void {
  runtime.downloading = false;
  runtime.cancelling = false;
  runtime.installing = false;
  runtime.downloadProgress = 0;
  broadcastState();
}

function prepareInstallation(): AppUpdateInfo {
  if (!UPDATES_SUPPORTED) {
    throw new Error("updates are not supported on this platform");
  }
  const info = runtime.info;
  if (info === null) {
    throw new Error("no update available");
  }
  if (runtime.downloading || runtime.installing) {
    throw new Error("update installation already in progress");
  }
  runtime.downloading = true;
  runtime.cancelling = false;
  runtime.installing = false;
  runtime.downloadProgress = 0;
  broadcastState();
  return info;
}

async function downloadAndInstall(): Promise<UpdateInstallResult> {
  const info = prepareInstallation();
  try {
    const result = await installation.run((signal) => downloadUpdate(info, signal), async (installerPath) => {
      if (desktopService === null) {
        throw new Error("daemon is not available");
      }
      runtime.downloading = false;
      runtime.installing = true;
      broadcastState();
      const response = await desktopService.installUpdate({ installerPath });
      switch (response.result) {
        case InstallUpdateResult.STARTED:
          app.quit();
          return "started";
        case InstallUpdateResult.SIGNER_MISMATCH:
          if (__CUSTOM_BUILD__) {
            throw new Error("custom update signer does not match the installed application");
          }
          resetInstallationState();
          return "signer-mismatch";
        case InstallUpdateResult.NOT_NEWER:
          if (__CUSTOM_BUILD__) {
            throw new Error("custom update installer is not newer than the installed application");
          }
          resetInstallationState();
          return "not-newer";
        default:
          throw new Error("daemon returned an invalid update installation result");
      }
    });
    if (result === "cancelled") resetInstallationState();
    return result;
  } catch (error) {
    resetInstallationState();
    throw error;
  }
}

async function installWithElevation(): Promise<boolean> {
  if (__CUSTOM_BUILD__) {
    throw new Error("unsafe update installation fallback is disabled for custom builds");
  }
  const info = prepareInstallation();
  try {
    const result = await installation.run((signal) => downloadUpdate(info, signal), async (installerPath) => {
      runtime.downloading = false;
      runtime.installing = true;
      broadcastState();
      const launched = await launchUpdateInstallerElevated(installerPath);
      if (!launched) {
        resetInstallationState();
        return false;
      }
      app.quit();
      return true;
    });
    if (result === "cancelled") {
      resetInstallationState();
      return false;
    }
    return result;
  } catch (error) {
    resetInstallationState();
    throw error;
  }
}

const handlers: Record<string, (...callArguments: never[]) => Promise<unknown>> = {
  async state(): Promise<UpdatesState> {
    return updatesState();
  },

  async check(): Promise<AppUpdateInfo | null> {
    return checkForUpdate();
  },

  async getGitHubToken(): Promise<string> {
    if (__CUSTOM_BUILD__) {
      return "";
    }
    return githubTokenPreference.get();
  },

  async setGitHubToken(value: string): Promise<void> {
    if (__CUSTOM_BUILD__) {
      throw new Error("GitHub tokens are not used by the public custom update channel");
    }
    const token = parseString(value).trim();
    githubTokenPreference.set(token === "" ? null : token);
  },

  async setProxyAddress(value: string): Promise<string> {
    if (runtime.checking || runtime.downloading || runtime.installing) {
      throw new Error("Update operation in progress");
    }
    const proxy = normalizeUpdateProxyAddress(value);
    updateProxyPreference.set(proxy === "" ? null : proxy);
    broadcastState();
    return proxy;
  },

  downloadAndInstall,

  async cancelDownload(): Promise<boolean> {
    if (!runtime.downloading || runtime.installing) return false;
    runtime.cancelling = true;
    broadcastState();
    return installation.cancel();
  },

  installWithElevation,

  async setTrack(track: UpdateTrack): Promise<void> {
    const parsed = parseUpdateTrack(track);
    updateTrackPreference.set(parsed);
    if (runtime.info !== null && parsed === "stable" && runtime.info.isPrerelease) {
      setUpdateInfo(null);
    } else {
      broadcastState();
    }
  },

  async setCheckUpdateEnabled(value: boolean): Promise<void> {
    checkUpdateEnabledPreference.set(parseBooleanPreference(value));
    updateCheckPromptedPreference.set(true);
    broadcastState();
  },

  async setPrompted(): Promise<void> {
    updateCheckPromptedPreference.set(true);
    broadcastState();
  },

  async markShown(): Promise<void> {
    if (runtime.info !== null) {
      lastShownUpdateVersionPreference.set(runtime.info.versionName);
    }
  },
};

export function registerUpdates(): void {
  ipcMain.handle(
    UPDATES_CALL,
    async (
      _event,
      method: string,
      ...callArguments: unknown[]
    ): Promise<ProfilesResult> => {
      const handler = handlers[method];
      if (!handler) {
        return { ok: false, error: `unknown updates method: ${method}` };
      }
      try {
        const value = await handler(...(callArguments as never[]));
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}

export async function runStartupUpdateCheck(present: () => void): Promise<void> {
  if (!UPDATES_SUPPORTED) {
    return;
  }
  const shouldPresentCached = loadCachedUpdate();
  if (!updateCheckPromptedPreference.get() || !checkUpdateEnabledPreference.get()) {
    return;
  }
  if (shouldPresentCached) {
    present();
  }
  let found: AppUpdateInfo | null;
  try {
    found = await checkForUpdate();
  } catch {
    return;
  }
  if (found !== null && lastShownUpdateVersionPreference.get() !== found.versionName) {
    present();
  }
}
