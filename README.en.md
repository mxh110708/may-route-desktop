# May Route

A Windows sing-box client with Rule/Global/Direct routing, System Proxy/TUN capture and activity-aware entry-group failover. The supported interface languages are Simplified Chinese and English.

[简体中文](README.md) · [Releases](https://github.com/mxh110708/may-route-desktop/releases/latest) · [User guide](docs/USER-GUIDE.en.md) · [Documentation](docs/README.md)

The maintained desktop/installer acceptance target is **Windows x64**; the documentation baseline is **1.14.4-may.3**. Upstream Linux scripts and cross-platform core code do not establish equivalent May desktop support on other platforms.

The current source integrates sing-box **1.14.4** as **1.14.4-may.1**. May revisions restart at 1 for each new upstream base. See the [release notes](docs/RELEASE-1.14.4-may.1.zh-CN.md) and [upstream synchronization record](docs/UPSTREAM-SING-BOX-1.14.4-2026-11-25.zh-CN.md) for provenance, compatibility changes and validation.

This is an independently maintained derivative of [sing-box-for-desktop](https://github.com/SagerNet/sing-box-for-desktop), not an official SagerNet package. This repository owns the desktop application, installer, update channel, Windows capture and failover. [Dashboard](https://github.com/mxh110708/may-route-dashboard) is embedded UI; [Core](https://github.com/mxh110708/may-route-core) is the paired service core. End users install the desktop release, not three separate repositories.

## Features

- Separate routing mode and traffic capture controls.
- Configuration, groups, node selection, manual latency tests, connections and logs.
- Per-entry-group priority and regional latency limits, monitoring only groups actually traversed by user activity.
- Confirmed unreachable, sustained-high-latency and repeated short-window failure handling, with backup rechecks and stable failback.
- Continuous system-proxy keeping while Route's system-proxy capture is on; turning the master switch off stops the guard. Healthy settings are not rewritten.
- Native Windows tray: left click restores the main window; right click opens the menu; submenus expand on hover.
- Fixed May Release updates, separate update-proxy settings and cancellable downloads before installer handoff.

## Use

Download and verify the Windows installer, choose installation/data locations and import a trusted sing-box profile. No private nodes or universal service password are bundled. Start the service, select capture and routing modes deliberately, then verify real traffic and the actual connection chain.

Rule/Global/Direct determines request routing. System Proxy/TUN determines traffic capture. Global does not make an uncaptured application use the proxy, and Direct does not turn an off-campus network into a campus-authorized connection.

## Failover and proxy ownership

Failover derives active groups from real connection chains and explicit detours. The editor's selected group is only a viewing/editing preference. One used region gets one monitor; multiple used regions are monitored separately, with about a minute of activity grace. Internal probes do not activate idle groups.

Three HTTPS targets are used, with at least two successful responses for reachability. Response-phase and full-request durations are separate and are not ICMP RTT. Regional limits, fixed confirmation and hysteresis filter brief jitter; unknown/mixed regions remain explicit choices. Backups must pass their own checks. No healthy backup means no switch, and failover never silently selects DIRECT.

Manual selection of a participating node makes it the current preferred node; automatic failover does not erase that preference. See [detailed policy](docs/PRIORITY-FAILOVER.zh-CN.md).

System-proxy health and Windows settings are evaluated separately. While system-proxy capture is on, confirmed endpoint/PAC/auto-detection changes are repaired, with at least ten seconds between retries. Turn Route off before using another proxy client. Unknown readings do not authorize writes. Hidden UI work can pause while proxy service, diagnostics and monitoring continue. Memory depends on state, profile, traffic and active views; historical measurements are not a fixed RAM promise.

Desktop [1.14.4-may.3](docs/RELEASE-1.14.4-may.3.zh-CN.md) displays full node names using a shared card-width baseline. Wider windows add columns and narrower windows remove columns, without a column-count cap. Cards in the same row share a height, with protocol and latency aligned at the bottom. The paired core remains pinned to 1.14.4-may.1; editor restoration and proxy keeping from may.2 remain included.

See the [user guide](docs/USER-GUIDE.en.md), [troubleshooting](docs/TROUBLESHOOTING.zh-CN.md), [update connection](docs/UPDATE-CONNECTION.zh-CN.md), [development](docs/DEVELOPMENT.zh-CN.md), [implementation notes](CUSTOM.md) and [history](docs/HISTORY.md).

Preserve upstream [license and attribution](LICENSE). Do not publish profiles, subscription credentials, tokens, private keys or signing material. Report exact version, mode, service state, time and redacted diagnostics.
