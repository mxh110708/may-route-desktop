# May Route

This repository is a personal Windows distribution based on the official
`SagerNet/sing-box-for-desktop` project. It keeps upstream behavior while
adding two official-style overview controls:

- Routing mode: Rule, Global, Direct.
- Traffic capture: System Proxy, TUN Mode.

The Windows installation is deliberately parallel to the official desktop
client. It uses a separate application identity, service, registry key, pipe,
and data directories.

The assisted uninstaller presents explicit choices to keep application data
for a later reinstall or to delete all application data. Keeping data is the
default. A fresh installer can recover a non-empty data directory only when it
has a valid May Route installation marker; unmarked, malformed, or unsafe
directories remain blocked.

System Proxy mode has a conservative recovery monitor for Rule and Global
routing. A healthy CONNECT path is checked once per minute. A failed check is
confirmed every five seconds, and only three consecutive failures trigger one
serialized profile reload. Direct mode and stopped services are not probed.
State changes, probe results and recovery errors are written to
`system-proxy-health.log` in the May Route user-data directory. On Windows,
loopback quality and actual system-proxy ownership are evaluated separately.
A disabled switch with the expected endpoint is confirmed twice before one
reassertion; foreign endpoints or PAC settings are never reclaimed.

Application and tray artwork reuse unchanged icon files from the official
desktop project. `resources/upstream-icons.json` records the upstream commit
and SHA-256 values; `pnpm icons` verifies these assets without redrawing them.
The product name, application identity, and
update channel remain May Route, and this is still an unofficial personal
distribution.

## Interface fonts and tray

UI, native menus, core status messages and installers support only English and
Simplified Chinese. Automatic detection maps Chinese regional variants to
Simplified Chinese and otherwise falls back to English. Old Traditional Chinese
preferences use Simplified Chinese; old Persian/Russian preferences use English.
Translation catalogs are flat strings; unused locale dictionaries, plural-rule
caches, RTL layouts and Chromium/installer locale packs are removed. See
[two-language validation](docs/TWO-LANGUAGES-2026-10-18.zh-CN.md).

The original interface font remains the default. LXGW WenKai is bundled as an
optional font with its complete OFL license. TTF/OTF imports are limited to
32 MiB, validated and copied into `interface-fonts` inside the application user
data directory; fonts are never installed into Windows. The main interface and
renderer-based tray share the saved choice. An unavailable font falls back to
the original font. Windows native menus use the system menu font.

WenKai keeps complete character coverage and the unchanged original TTF for
recovery, while loading common text and remaining CJK ranges as local WOFF2
segments. Range definitions are deferred until WenKai is selected. Coverage,
source hashes and runtime ranges are checked by `pnpm test:interface-fonts`.
See [resident-memory verification](docs/RESIDENT-MEMORY-2026-10-18.zh-CN.md)
for measurements, shaping checks and the boundaries of the isolated comparison.
Connection snapshots now share unchanged pages, and bounded stream histories use
an adaptive array path when actively displayed. Closed log pages retain compact,
lossless diagnostics for offline reopening. Font management and report handlers
load on first use. See [stream-memory verification](docs/STREAM-MEMORY-2026-10-19.zh-CN.md)
for compatibility checks and measurements.

On Windows, one left click dismisses the tray menu and shows or restores the
main window. Right click manually opens a native Electron Menu with ten root
actions. Native submenus handle hover expansion, keeping parents visible,
screen-edge placement and keyboard traversal. No additional double-click handler
repeats primary activation. The menu follows the application theme while using
the platform menu font. It does not preload a renderer window on Windows.
System Proxy/TUN, routing, profiles, updates and node selection reuse the main
window's existing backend operations. Routing status is cached from the daemon
stream so opening the menu does not wait for an RPC. Profile and connection
changes dismiss the old popup; each new popup builds from current state. Busy,
transitioning and disconnected states disable unavailable mutations.
The renderer-based tray remains available for Linux, with bounded resize IPC
restricted to its own window.

## Background resource usage

Hidden desktop pages pause replayable data streams, UI clocks and failover-panel polling.
They retain component state and unsaved form values, then read current data
when visible again. This only pauses presentation; a running proxy keeps its
backend monitoring, log archiving, failover and recovery behavior.
An open connection-history view keeps its bounded event stream while hidden:
the proxy's closed-connection cache is GC-evictable and cannot reliably replay
missed history. Leaving that page still releases its unused table. This active
stream can also defer stopped-worker retirement; preserving history takes
precedence over releasing that worker.

On Windows, a connected but stopped proxy with every window hidden, minimized
or closed can release its application worker after 15 seconds. Observer RPCs
are cancelled first; in-flight commands prevent retirement. Returning to a
window or invoking a worker-backed tray action resumes the authenticated worker
on demand. A command that completes during the idle transition resumes service
observation, so a completed service start is not treated as still stopped.
No proxy stop, network setting change or Windows working-set trim is used.
See `docs/BACKGROUND-PERFORMANCE-2026-10-18.zh-CN.md` for measured scope and limits.

Terminal rendering and release-note Markdown are loaded on first use and remain
available offline from the signed installation. Production renderer scripts
are minified. The bundle audit fails a build if optional terminal/Markdown
dependencies enter an initial or shared startup chunk, or if either feature
is missing. Stopped clients also avoid runtime-only groups/routing subscriptions
in their visible dashboard and Linux tray; service-status observation remains.

The application worker reclaims its unused Go heap once after configuration or
schema processing and 10 seconds with no active application RPC. A new request
defers collection; long-running streams protect active work. This policy is
limited to the application worker and does not change the proxy process's GC
settings, concurrency or memory limit. It does not run periodic cleanup.
Rebuildable stream tables are discarded when their last view unsubscribes;
log pause snapshots and stale font loads release references after use. Active
views, current data, normal log limits, selected fonts and drafts are retained.
See `docs/MEMORY-PERFORMANCE-2026-10-18.zh-CN.md` for the four-state comparison
and normal-use checks; startup byte counts are not used as RAM savings.

Windows startup does not load the Linux tray's D-Bus implementation. The
Linux implementation stays bundled and loads only for X11; disabling the tray
during initialization cancels its pending creation. Settings, advanced tools,
endpoint pages and reports load locally on first navigation. The production
bundle audits verify these boundaries, including indirect shared imports.
Hidden connection-history views continue collecting their bounded history but
publish no React notifications until visible again. Unused authoritative
endpoint/outbound caches and completed schema-response promises release their
references; active sessions and parsed editor schemas remain available.
See `docs/THIRD-PERFORMANCE-2026-10-18.zh-CN.md` for the Clash Verge source
comparison, measurement scope and limits of this additional round.

Priority failover reconciles saved order against the selected configuration on
both the editor and runtime paths. Surviving custom members keep their order;
new nodes remain available for explicit inclusion. An entirely obsolete order
falls back to the current group's order, and a missing group is not replaced
automatically. Editor revisions bind policy, profile identity and content, so a
profile overwrite also invalidates stale edits. Unsaved edits are preserved
with a conflict prompt; a clean editor refreshes on profile changes.

## Upstream maintenance

The maintained branch is `custom-main`. The official repositories are kept as
the `upstream` remotes in all three working trees:

- Desktop: `SagerNet/sing-box-for-desktop`
- Dashboard: `SagerNet/sing-box-dashboard`
- Core: `SagerNet/sing-box`

The corresponding personal `origin` repositories are
`mxh110708/may-route-desktop`, `mxh110708/may-route-dashboard`, and
`mxh110708/may-route-core`.

Run `scripts/sync-upstream.ps1` only from a clean working tree. It fetches the
three upstream repositories, checks out the requested official desktop/core
version, reapplies the custom branches with rebases, updates the dashboard
submodule pointer, and stops on any conflict. Because rebasing rewrites the
personal branches, publish only with `--force-with-lease`, and only after the
tests and signed local package succeed.

When moving from a prerelease line to a stable tag whose history is not a
direct descendant, pass the old core tag explicitly, for example:

`scripts/sync-upstream.ps1 -Version 1.14.0 -BaseVersion 1.14.0-beta.14`

This replays only the custom core commits instead of treating intervening
upstream development commits as local changes. The proxy is optional; pass
`-Proxy http://127.0.0.1:PORT` only when a local proxy is actually listening.

## Update channel

Custom builds check only public Releases from
`mxh110708/may-route-desktop`. They accept only an installer whose
name exactly matches the custom release version. The privileged service also
requires the update installer to use the same signer as the installed build.
Unsafe signer-mismatch and not-newer fallbacks are disabled in custom builds.

The updater shows the saved connection explicitly; an empty update proxy means
direct access, and the example in an empty input is not an enabled proxy.
Downloads can be cancelled until installer handoff. Cancellation waits for
stream closure and partial-file cleanup. Transient download failures retry at
most three times on the same connection, with validated Range/If-Range resume
when available and a 30-second connection/inactivity timeout. An explicit proxy
never falls back to direct access. See
`docs/UPDATE-DOWNLOAD-2026-10-17.zh-CN.md` for validation boundaries.

## Secrets and releases

CI is intentionally test-only and receives no signing material. Windows
installers are built locally with `scripts/build-custom-release.ps1`; the code
signing certificate and password stay outside this repository. Never commit a
proxy profile, VPS archive, credential, token, private key, or signing file.
Upload release artifacts directly from the machine that built them. Do not
relay locally built installers through BERO or another host for publication.
Synchronize committed source through the personal GitHub remotes with normal
push, fetch and fast-forward operations; build artifacts and signing material
are not a source-synchronization mechanism.
When dependency downloads require a local proxy, pass its URL through the
script's optional `-Proxy` parameter; the value is process-local and is not
stored in the repository.
The upstream-pinned Rust toolchain can likewise remain portable by passing its
Cargo and rustup directories through `-CargoHome` and `-RustupHome`; neither
directory is added to the machine-wide PATH.
An already-downloaded Electron archive can be supplied with `-ElectronDist` to
avoid a network download during packaging. The path is process-local and is
not persisted in the repository or the user's environment.

The custom release revision comes from `custom-version.json`, while the
official base version remains in `version.json`. A prerelease such as
`1.14.0-beta.14` becomes `1.14.0-beta.14.mxh.1`; this preserves correct SemVer
ordering when the next official prerelease appears. Increment the custom
revision when the base version does not change.

This project remains under the upstream license in `LICENSE` and is not an
official SagerNet distribution.

调优保留与回退决策见 [2026-10-19 多轮性能复核](docs/PERFORMANCE-AUDIT-2026-10-19.zh-CN.md)，不能将各轮专项收益相加或当作所有状态的固定降幅。

已发布及待发布改动的逐项新测量、保留理由和成本见 [2026-10-19 逐项实测](docs/INDIVIDUAL-PERFORMANCE-2026-10-19.zh-CN.md)；旧 GPU CPU 异常的定位与修正口径见 [CPU 计时复核](docs/GPU-MEASUREMENT-2026-10-19.zh-CN.md)。
