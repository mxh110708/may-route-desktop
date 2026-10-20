# System proxy quality monitoring

## 2026-10-20: stable-period system-proxy keeping

Local proxy keeping now confirms repeated matching-endpoint disablement before
either repair or suspension. A completed repair rearms only after fifteen seconds
of continuously observed, owned-and-enabled proxy state. Brief off/on changes
cannot repeatedly replenish the allowance; foreign/PAC settings and uncertain
commands remain latched until an explicit Route action.

Notifications require ten observed seconds of persistent abnormal state, and
the current warning is closed when that state ends. The existing local poll loop
is reused. An in-flight command is persisted as `repairing`, so restarting during
the command does not grant a duplicate write. See [the incident analysis](WINDOWS-PROXY-GUARD-2026-10-20.zh-CN.md)
for the observed timeline, exact conditions and test boundaries. Earlier
one-repair-per-session descriptions below are historical.

## 2026-10-20: regional absolute latency limits

Current source also handles sustained high latency on reachable entry nodes.
Each selector has one absolute post-TLS HTTPS response budget. Explicit regional labels use
conservative built-in presets; a saved `groupLatencyCeilings` value overrides
the preset, and zero disables latency switching for that group. Unknown or mixed
regions require an explicit limit. No normal-baseline learning or relative-rise
estimation is used. See [the configuration guide](PRIORITY-FAILOVER.zh-CN.md) for
the preset table and exact matching rules.

The second-fastest successful `httpMs` result is the latency metric: time from
sending HEAD after the TLS handshake until complete response headers arrive.
Connection and handshake setup are excluded; network RTT, server processing and
header transfer remain included, so this is not ICMP ping. One slow site cannot
condemn a node. Three consecutive over-limit samples spanning at
least ten seconds are required, with five-second waits between confirmations.
An eligible backup must repeatedly stay at or below 80% of the group's limit,
pass an immediate verification and still be valid when the selector mutation
executes. Configured priority, freshness, cooldown, stable failback, manual
selection and session cancellation all remain in effect. All-slow candidates
leave the selector unchanged and do not become all-unreachable evidence.
Whole-proxy health recovery keeps its existing independent rules.

Presets assume access from mainland China. US West's 450 ms budget was compared
against local historical responses; other regional budgets remain provisional.
See [the design analysis](LATENCY-PRESETS-2026-10-20.zh-CN.md) for evidence and
limitations. The monitor performs no baseline learning at runtime.

Healthy probe cadence, shared concurrency limits and idle-region suspension
are unchanged. The monitor reuses existing timings and keeps constant-sized
counters per node, without timing-history arrays or additional timers. Earlier
release descriptions below are historical where they differ from this section.

## 1.14.2-mxh.2: independent local-state and active-node monitoring

See [the 2026-09-27 revision](RECOVERY-REVISION-20260927.zh-CN.md) for the current
source behavior and validation boundaries. Local Windows checks run independently
at 2-second intervals with a 1-second confirmation delay, not on the 60-second
HTTPS timer. The active node has its own probe lane; at most two backup nodes are
surveyed concurrently, plus one bounded pre-switch verification. Repair allowance
and uncertain outcomes persist across application restarts. Historical sections
below describe earlier releases, not all current scheduling details.

## 1.14.2-mxh.1: Windows ownership and all-down recovery

That Windows release treats a successful local CONNECT probe and Windows
system-proxy ownership as separate signals. If `ProxyEnable` is off while the
expected HTTP and HTTPS endpoint remains configured, it confirms the drift on
two checks and requests one re-application through the existing user-session
daemon. A second drift in the same service session stops automatic retries and
shows a system warning. A foreign proxy address, PAC, auto-detection or an
unreadable registry never authorizes automatic takeover. No full core reload is
used solely to repair the Windows proxy switch.

Node failover still owns single-node recovery. A fresh round in which all
independent candidate probes fail permits one serialized whole-proxy reload
after the existing three failed whole-proxy quality rounds. The round must
start after the observation window and finish recently; stale evidence cannot
authorize a reload. See [audit](AUDIT-1.14.2.zh-CN.md) for limitations.

## mxh.7: configuration-driven policy

Provider-name ranking has been removed. The application data directory's
`priority-failover.json` controls enabled state, selector name, optional explicit
node order, failure/recovery thresholds and probe intervals. Empty `order` uses
the selector's configured concrete-node order. Changes apply on proxy restart or
profile reload; mismatched old runtime caches are not reused. Existing settings
are never overwritten by defaults. See [configuration guide](PRIORITY-FAILOVER.zh-CN.md).

The mxh.6 fixed-provider behavior described below is historical, not the current
ordering policy. Its log retention and independent-probe design still apply.

## mxh.6: priority failover and retained logs

`US-West Entry` uses a fixed provider priority: DMIT, then VMISS, then MoeCloud.
Existing IPv4/IPv6 order within a provider is preserved. Only concrete node
members of this selector participate; other selectors and DIRECT are untouched.
This is failover, not minimum-latency selection. Runtime-only loopback HTTP probe
listeners route independently through each candidate without changing the live
selector. Ports are allocated at startup; the source profile is not modified.
Both system-proxy and TUN capture modes use this monitor. Direct routing mode
suspends decisions. Keep the desktop application running (tray is sufficient).

Each candidate is tested against three certificate-verified HTTPS endpoints.
Two successes make a usable round; HTTP 403/429 is reachable. Slow completed
responses alone do not disqualify a node. Three failed rounds on the selected
node and two successful rounds on a backup permit failover. Higher-priority
nodes must have three successful rounds spanning at least 120 seconds before
failback, with a 60-second failback cooldown. A failure resets the stable window.
All-down leaves the selection unchanged; it never chooses DIRECT. Probe rounds
are serialized, with at least 10 seconds between failing rounds and 30 seconds
when all nodes are healthy. Failure detection also includes probe duration.

The manual-selection pause described in mxh.6 is historical. Current builds treat
a manually selected monitored node as the preferred node: fail over when it fails,
then return after stable recovery. The preference and runtime probe mapping
survive a desktop restart for the same profile. Profile/mode/service changes
cancel stale decisions.
Existing connections are not promised seamless migration. The selector's
configured interrupt policy remains unchanged.

`system-proxy-health.log` now retains 10 MiB per file and five backups, and includes per-node probe results, selected-node
changes and errors. Node recovery takes precedence over blind service reloads;
a whole-proxy failure can still request recovery when the selected node's
independent probe was recently healthy.

`core-runtime.log` archives the daemon log subscription in the application data
directory (10 MiB per file, five rotated backups). Restarting or clearing the
daemon's in-memory log does not delete this archive. Initial/reconnected buffer
replays are labelled historical, and reset boundaries are recorded. Timestamps
are receipt times; original core messages may also contain their own timestamps.
The archive can contain node names, destination addresses and domains: keep it
private. Credential-shaped fields are redacted; full profiles are never saved
by this logger. It cannot recover logs already lost before installation or while
the desktop application was closed. Normal app exit allows a bounded flush;
forced termination/disk errors can still lose the final records.

## Earlier system-proxy recovery policy

Version mxh.5 replaces CONNECT-only checks with certificate-verified TLS and a
small HTTPS HEAD request. Three fixed public endpoints are sampled: gstatic,
Cloudflare and ChatGPT. No cookies, credentials or user browsing data are sent.

Every sample records local TCP time, CONNECT time, TLS time, HTTP-header time,
total duration and HTTP status. CONNECT time is not a separate DNS measurement;
the proxy handles DNS/remote dialing internally. This is latency/availability
monitoring, not a bandwidth test. HTTP 403/429 remains a reachable response and
does not alone trigger a restart.

First sample is scheduled five seconds after the desktop monitor starts; normal
interval is 60 seconds. At least two targets must fail or take five seconds or
longer to count as a bad round. Three consecutive bad rounds (five-second retry
delay) permit one serialized reload. Continued failure remains logged without
repeated reloads until a satisfactory round rearms the gate. Changed profile,
service state, capture mode or Direct mode cancels a stale recovery request.

`system-proxy-health.log` in the application's configured data directory records
monitor startup, service changes, skips, samples and recovery operations. It
rotates at 2 MiB and retains one `.1` backup. It contains fixed probe hostnames
and timings, not profile contents, node credentials or visited URLs.

These probes cannot establish why a past outage occurred, nor guarantee every
website or a separate application's language initialization works correctly.
The testdata certificate/key are public, self-signed test-only fixtures and must
never be used by a deployed service.
