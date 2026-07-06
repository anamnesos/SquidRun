# Telegram Poller Reliability Fix Provenance - 2026-06-12

Source handoff: `.squidrun/coord/incoming-eunbyeol-fixes/README.md` plus patches `0005` through `0008`, provided by the Eunbyeol Builder after live verification on the standalone install.

## Defects Ported

- `0005`: `ui/modules/main/telegram-poller-worker.js` now persists fatal worker diagnostics synchronously to stderr and `.squidrun/runtime/telegram-poller-worker-crash.log` before exit. The original 05:21 UTC crash trigger remains unknown; the crash log is the tripwire for the next occurrence.
- `0006`: `ui/scripts/hm-telegram-poller-lane.js` now verifies a spawned lane child is still alive after startup and resolves `hm-send.js` through an overlay-aware runtime script path.
- `0007`: `ui/scripts/hm-telegram-poller-watchdog.js` now waits and rechecks poller freshness after an app restart before reporting recovery. If the restart is unverified, it falls through to lane recovery.
- `0008`: `ui/modules/telegram-poller.js` now defaults to no-drop backlog recovery. Delayed messages are delivered with `[delayed: Nm old]`; only the explicit 24h backstop can drop, and every backstop drop is logged with update/message identifiers and a preview.
- `2026-07-06`: `ui/modules/telegram-poller.js` now applies a bounded request deadline to `getUpdates` and media fetches, persists `request_timeout`, and clears `pollInFlight` through the normal `finally` path. `ui/scripts/hm-telegram-poller-watchdog.js` now derives freshness from `poller.lastPollAt` when present, not broad state-file writes or process aliveness, so a live-but-stuck worker is detected honestly.

## Verification Source

Eunbyeol-side live proof was reported for the patched runtime at 2026-06-12 06:45 UTC: lane restart verified child liveness, no-drop backlog policy was logged, delayed backlog was injected, and the watchdog tick verified the child alive after restart.

Main-side trunk verification for this port must include targeted poller tests, hardcode grep review for executable poller paths, and a main poller restart proof showing honest child liveness plus the no-drop policy log.
