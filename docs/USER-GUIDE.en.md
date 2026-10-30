# May Route user guide

Baseline: Windows x64, 1.14.2-may.27. See the [Chinese manual](USER-GUIDE.zh-CN.md) for detailed parameters and troubleshooting.

## Install and import

Download the Windows installer from the owned Release channel and verify the corresponding checksum information. Updates validate version, installer identity and signer. Existing installations retain their recorded location; data and application binaries have distinct ownership.

Import a trusted sing-box profile, select it, choose the required nodes and start the service. The application does not provide private nodes or a universal service password. Deploy export, Route import and loading the active runtime are separate steps.

The data directory contains profiles, settings, fonts and bounded logs, potentially with private credentials. Use the application's open-data-directory action rather than guessing its location after a custom install. Uninstall can retain or remove data; retaining is the default. Do not override an unknown non-empty directory to bypass ownership checks.

## Capture versus routing

| Control | Meaning |
| --- | --- |
| System Proxy | Captures applications that honor the Windows proxy setting; some applications do not. |
| TUN | Captures matching traffic through a virtual network interface. |
| Rule | Routes already captured requests using the active rules and groups. |
| Global | Uses the global path for captured traffic; does not force an uncaptured program to honor system proxy. |
| Direct | Direct routing mode, different from stopping the service or exiting the app. |

Establish which program owns capture before enabling Route alongside another proxy client. Do not repeatedly toggle multiple clients during read-only diagnosis.

Campus-licensed databases may require DIRECT plus an actual campus-authorized network. Direct routing does not provide that network off campus. Check the real host, redirects, rule order and selected category, rather than forcing every research/model-download domain into interactive AI routing.

## Failover

The status panel displays actual monitored entry groups. The editor dropdown only selects which group's settings you view or edit, and remembers that choice. Order and latency limits are saved per group; viewing another group does not reset them.

Real user connection chains, including explicit detours, activate monitoring. One used group gets one monitor; multiple used groups are monitored independently. About one minute of activity grace prevents repeated stop/start. Internal probes do not activate idle groups, and direct concrete-node use is not inferred to traverse a selector merely because it is a member.

Three HTTPS targets are checked; two must succeed. Response-phase and complete-request timing remain separate from ICMP RTT. Regional limits, confirmed high latency and a bounded repeated-anomaly window filter jitter. Backups need their own fresh verification and a 20% margin below limits. If none qualifies, keep the current selection; never silently switch to DIRECT.

A participating manually selected node becomes preferred. Default unreachable confirmation is three rounds, backup readiness two successes, preferred recovery three successes plus 120 seconds of stability, with a 60-second failback cooldown. Actual switch time also includes request duration and backup readiness. See [policy details](PRIORITY-FAILOVER.zh-CN.md).

## Proxy ownership, tray and updates

The guard separates local CONNECT health from Windows proxy ownership. It can confirm and repair its disabled expected endpoint, but yields to foreign endpoints/PAC. Healthy identical settings are not repeatedly written. Direct and stopped states are not probed in the same way.

Left-click the Windows tray icon to show/restore the main window. Right-click opens a native menu; submenus expand on hover. Hidden windows do not stop a running proxy. Simplified Chinese and English are supported. Imported TTF/OTF fonts remain local to the application; native menus use the Windows font.

Update connection settings support unauthenticated HTTP, HTTPS and SOCKS5 proxies. Empty means the updater uses no explicit application proxy; OS TUN routing may still apply. A failed explicit proxy does not fall back to direct. Downloads can be cancelled before installer handoff, with stream and partial-file cleanup. See [update connection](UPDATE-CONNECTION.zh-CN.md).

## Diagnostics

Hidden UI work pauses while backend proxy, monitoring and diagnostic duties continue. Compare memory/CPU only across equivalent service, foreground/background, profile and traffic conditions. Historical benchmarks do not promise a fixed RAM number or improvement in every state.

Use `core-runtime.log` and `system-proxy-health.log` from the application data directory, retaining exact time and error category but removing credentials, node addresses and private destinations. See [troubleshooting](TROUBLESHOOTING.zh-CN.md).
