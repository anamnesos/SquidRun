# Builder Health Sweep - 2026-04-25

## Executive State

- Live now: main Electron only. Port 9900 is owned by PID 3812. Port 9901 has no listener at the latest check.
- The earlier Eunbyeol split-brain is resolved live: both Eunbyeol parents are gone now. Historical evidence still matters because it explains ledger leakage and Telegram 409s.
- Fixes landed on disk during this sweep:
  - Bare `--profile=eunbyeol` now normalizes to standalone Eunbyeol instead of a profile-main parent.
  - Eunbyeol launcher and auto-shortcut args now include `--window=eunbyeol --standalone-window`.
  - No-chat Telegram sends under `SQUIDRUN_PROFILE=eunbyeol` default to Eunbyeol route, not James.
  - Oracle watch degraded/backoff/failed cycles now advance `heartbeat.lastTickAt`, stopping repeated relaunch against the same stale tick.
- Verification: `npx jest ui/__tests__/supervisor-daemon.test.js ui/__tests__/hm-oracle-watch-engine.test.js ui/__tests__/hm-telegram-routing.test.js ui/__tests__/launch-intent.test.js --runInBand --testTimeout=30000` passed, 114 tests.

## 1. Window Separation

### hm-send / WebSocket Ports

- Working: `ui/profile.js:28` maps main to offset 0 and Eunbyeol to offset 1; `ui/profile.js:138` computes profile port.
- Working: `ui/scripts/hm-send.js:51` resolves the target port from `SQUIDRUN_PROFILE`.
- Working: `ui/modules/websocket-runtime.js:21` uses the same profile port logic.
- Live: 9900 listens on PID 3812. No 9901 listener after James closed Eunbyeol.
- Decision: accept as-is.
- Next action: restart main when James is ready so the on-disk fixes become live.

### Eunbyeol Launch Split-Brain

- Historical bug: a process launched with only `--profile=eunbyeol` could become a profile-main parent and coexist with the correct standalone Eunbyeol parent.
- Fixed now: `ui/modules/main/launch-intent.js:25` treats profile-only Eunbyeol as the Eunbyeol window, and `ui/modules/main/launch-intent.js:43` only includes main when explicitly requested.
- Fixed now: `ui/scripts/launch-eunbyeol.ps1:21` and `ui/scripts/launch-eunbyeol.ps1:30` include the standalone window args.
- Fixed now: `ui/modules/main/squidrun-app.js:3849` and `ui/modules/main/squidrun-app.js:3850` write the same explicit args into the generated shortcut.
- Blast radius: prevents the 3:13 ghost parent on next launch. Running windows must still be relaunched to pick this up.
- Decision: fix-now done.
- Next action: after restart, verify `netstat` shows only the expected profile listener.

### Telegram Inbound

- Working: `ui/modules/telegram-poller.js:157` restricts Eunbyeol profile to `TELEGRAM_EUNBYEOL_CHAT_IDS`.
- Working: `ui/modules/telegram-poller.js:166` lets main accept James/allowlisted chats while earlier code rejects Eunbyeol-exclusive chats.
- Working: `ui/modules/main/squidrun-app.js:3371` starts the Telegram poller only for Eunbyeol profile; main logs disabled polling.
- Historical evidence: Eunbyeol casework log had Telegram 409s until 23:07:38 UTC. No later 409 was found after the duplicate shutdown window.
- Decision: accept current inbound routing, pending main restart for already-landed poller code.
- Next action: after restart, verify no 409s for 10 minutes with Eunbyeol open.

### Telegram Outbound

- Historical bug: default route in `ui/scripts/hm-telegram-routing.js` sent no-chat-id messages to James even in Eunbyeol profile, matching the LIVE SPARK rows Oracle found in `runtime-eunbyeol`.
- Fixed now: `ui/scripts/hm-telegram-routing.js:101` chooses the default route by profile; `ui/scripts/hm-telegram-routing.js:105` carries `env` into route resolution.
- Tests: `ui/__tests__/hm-telegram-routing.test.js:53` covers no-chat Eunbyeol default routing.
- Blast radius: no explicit chat-id behavior changed; only profile-default fallback changed.
- Decision: fix-now done.
- Next action: restart before trusting outbound defaults live.

### User Data Dirs

- Working: `ui/main.js:26` sets non-main profile userData under the main app data dir plus profile name.
- Live/historical: main uses `AppData/Roaming/squidrun-ui`; Eunbyeol uses `AppData/Roaming/squidrun-ui/eunbyeol`.
- Problem was not directory collapse; it was two Eunbyeol parents sharing one userData/profile while pointing at different project roots.
- Decision: accept userData layout; launch fix handles the observed failure mode.
- Next action: verify future Eunbyeol launch has one parent and expected `SQUIDRUN_PROJECT_ROOT`.

### Startup Health

- Working: `ui/scripts/hm-startup-health.js:119` strips trading sections, and `ui/scripts/hm-startup-health.js:498` applies `--profile=eunbyeol`.
- Live check returned no blockers, warnings, or fixes for `--profile=eunbyeol`.
- Decision: accept as-is.
- Next action: none.

### Memory

- Evidence ledger and team-memory are profile/root scoped through profile namespacing.
- Cognitive memory is project-root scoped, not hard profile-scoped. It is safe when Eunbyeol uses `D:\projects\eunbyeol-casework`; it is unsafe if a ghost Eunbyeol runs under `D:\projects\squidrun`.
- Existing guards in memory recall are ranking/context guards, not hard isolation.
- Decision: fix-now launch prevention; deeper cognitive namespace is fix-later.
- Next action: add a hard profile/root assertion before Eunbyeol cognitive memory writes in a later cleanup.

## 2. Supervisor / Oracle Watch

- Historical bug confirmed: `ui/supervisor-daemon.js:3982` relaunches stale Oracle watch, but `hm-oracle-watch-engine` backoff/degraded/failure paths kept the old `heartbeat.lastTickAt`.
- Fixed now: `ui/scripts/hm-oracle-watch-engine.js:424`, `2409`, and `2528` advance `lastTickAt` for degraded/backoff/failed completed cycles.
- Tests: `ui/__tests__/hm-oracle-watch-engine.test.js:1100`, `1213`, and `1305` guard the heartbeat advancement behavior.
- Current live caveat: supervisor PID 15936 started before this patch, so the fix is on disk only until supervisor/app restart.
- Decision: fix-now done.
- Next action: restart supervisor with app restart, then confirm no repeated `INPROC_RELAUNCH` lines with the same `lastTickAt`.

## 3. Runtime Conflicts

- Duplicate Eunbyeol: resolved live. No 9901 listener at latest check.
- Telegram 409: historical only after duplicate close; last casework 409 was 23:07:38 UTC.
- Bridge relay: both main and Eunbyeol use `SQUIDRUN_DEVICE_ID=VIGIL` via `ui/modules/cross-device-target.js:14` and `ui/modules/main/squidrun-app.js:7291`. While both were open, logs showed `reason=replaced` conflicts every few seconds. Conflicts stopped after Eunbyeol closed.
- Log volume: Eunbyeol logs self-watch `app.log` changes heavily; in the last 1000 lines, SquidRun-root Eunbyeol had 101 self-watch entries and casework Eunbyeol had 104.
- SMS polling: main logs duplicate Twilio SIDs every 10 seconds. Behavior is safe but noisy.
- Decision: bridge identity is fix-later design; log self-watch and SMS noise are fix-later.
- Next action: pick one bridge owner for `VIGIL` or issue profile-specific bridge identities; add watcher ignore for app logs.

## 4. Dirty Working Tree

- Current dirty count: 127 paths total, 81 modified, 7 deleted, 39 untracked.
- Builder changes from this sweep:
  - `ui/modules/main/launch-intent.js` - fix-now Eunbyeol profile-only launch normalization.
  - `ui/__tests__/launch-intent.test.js` - coverage for profile-only Eunbyeol and explicit main inclusion.
  - `ui/scripts/launch-eunbyeol.ps1` - explicit standalone window args.
  - `ui/modules/main/squidrun-app.js` - explicit standalone args for generated Eunbyeol shortcut; file also contains pre-existing unrelated edits.
  - `ui/scripts/hm-telegram-routing.js` - profile-aware no-chat default route.
  - `ui/__tests__/hm-telegram-routing.test.js` - coverage for Eunbyeol default route.
  - `ui/scripts/hm-oracle-watch-engine.js` - heartbeat advancement on degraded/backoff/failure cycles; file already had large pre-existing Oracle watch edits.
  - `ui/__tests__/hm-oracle-watch-engine.test.js` - heartbeat regression coverage; file already had large pre-existing Oracle watch coverage.
  - `ui/__tests__/supervisor-daemon.test.js` - restored explicit immediate-consultation opt-in for a market-scanner test.
- Pre-existing intentional WIP buckets:
  - Layer-B live execution work: `ui/scripts/hm-defi-execute.js`, `hm-defi-close.js`, `hm-defi-status.js`, `hm-trailing-stop.js`, bracket manager/executor/orchestrator/risk tests and modules.
  - Oracle/market scanner work: `ui/scripts/hm-oracle-watch-engine.js`, `hm-oracle-watch-rules.js`, `hm-oracle-watch-regime.js`, `ui/supervisor-daemon.js`, market-scanner/orchestrator/spark modules and tests.
  - Profile/routing/runtime isolation: `ui/profile.js`, `ui/main.js`, `ui/modules/websocket-runtime.js`, `ui/scripts/hm-send.js`, startup health, Telegram tests.
  - Ollama/subtitle removal: deleted `ollama-extract` and subtitle pipeline files/tests, plus local-model capability updates and `ui/package.json`.
  - Memory/logging/event bus: evidence ledger tests, logger, event bus, memory recall/team-memory tests.
  - Ops/docs/runtime: `.claude` hooks/settings, docs, workspace agent-trading JSON, Tokenomist file, desktop helper scripts.
- Accidental drift candidates needing owner review:
  - `tokenomist-current.yml` is a large churn file and should not be committed casually.
  - `workspace/agent-trading/*.json` are live paper/runtime state and need explicit commit decision.
  - `hyperliquid_info.json`, FB scrape scripts, Gasline diagram, and `workspace/drafts/` look unrelated to this sweep.
- Decision: do not bundle all dirty work into one commit.
- Next action: commit this sweep as a surgical patch only after reviewing mixed dirty files, or stash/split pre-existing WIP first.

## 5. Dist / Packaged Installer

- `ui/dist/win-unpacked` is stale and still predates the truncation fix, launch fix, routing fix, and Oracle watch fix.
- Previous Architect instruction was to hold dist rebuild until running-app fix is verified or James greenlights release packaging.
- Decision: fix-later, explicitly documented gap.
- Next action: rebuild dist before next installer/release tag, not during live trading cleanup.

## 6. Verification Summary

- Passed: launch intent and routing tests.
- Passed: Oracle watch engine heartbeat tests.
- Passed: supervisor suite with longer per-test timeout.
- Live not restarted: main Electron PID 3812 and supervisor PID 15936 still pre-patch.
