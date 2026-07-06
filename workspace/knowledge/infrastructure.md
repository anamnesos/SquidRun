# Infrastructure

- Vercel: team `anamnesos`, project `squidrun-site`.
- GitHub: `anamnesos/SquidRun`.
- Relay: hosted on Railway (`wss://relay-production-2c27.up.railway.app`).
- Telegram bot: configured via `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `.env`.

## TrustQuote arm manifest vs readiness scope (S407)

The Squid Room desired-arm manifest is durable app-room state, not session state. Its registry row must be keyed by the canonical sentinel `app-room:trustquote`, which is intentionally format-distinct from `app-session-N:trustquote` and survives restarts. Current room readiness stays session-scoped through `readinessSessionId`: check-ins, missing-watchdogs, apply requests, and desired/ready/missing counts are evaluated against the current session, for example `app-session-408:trustquote`.

The projection path must resolve the canonical manifest directly, then recompute readiness against the requested/current session. A fresh 408 projection is expected to find the `app-room:trustquote` manifest with `desired=3`, `ready=0`, and `missing=3` until fresh 408 identity check-ins land. Startup must not auto-seed or auto-migrate this manifest; explicit seed/migration tooling must target `app-room:trustquote`, treat an already-canonical row as `already_canonical`, and refuse duplicate canonical plus legacy rows as a blocker instead of repairing them silently.

## How restarts ACTUALLY happen (READ THIS BEFORE STAGING ANY RESTART)

The Architect **cannot** restart the SquidRun app from its own pane, and staging
`.squidrun/coord/restart-request.json` (via `hm-restart-request.js`) is **NOT enough** on its own —
that is the wrong box. James has had to explain this repeatedly; do not make him say it again.

**The real model (from James, S396):**
- **Codex Desktop is a separate desktop app** (ChatGPT/Codex with **computer-use**), running alongside SquidRun.
- It is the actor that physically restarts the SquidRun Electron app.
- It runs an **automation that polls its OWN inbox every ~5 minutes**.
- **Empty inbox = no restart.** If nothing is in the Codex inbox, Codex Desktop does nothing, no matter how clean your `coord/` restart-request is.

**The Codex inbox = the codex-attention-bridge**, managed by `ui/scripts/hm-codex-attention.js`:
- View it: `node ui/scripts/hm-codex-attention.js` → check `active_count` / `active_request_ids`.
- Put a restart request IN it:
  ```
  node ui/scripts/hm-codex-attention.js create --requested-by architect \
    --target-window squidrun-main --work-item-id <id> \
    --reason "<why restart + HEAD + gate status>" \
    --check "Restart main SquidRun Electron (main profile, not side profile)" \
    --check "Confirm fresh app-status.json session > <current> with new timestamp" \
    --check "Confirm loaded HEAD is <commit> on <branch>" \
    --check "Return PASS only if relaunched at that HEAD; BLOCKED if cannot launch/inspect"
  ```
- After creating, verify `active_count` went to ≥1 so you KNOW it is queued (don't assume).

**Restart proof = session evidence, NOT memory.** (Corrected S442 by Oracle — the old "if you remember, it
didn't restart" test is INVERTED since warm resume went production at S425/S426: core panes come back
REMEMBERING everything via `--resume` pins.) Real proof a restart happened: `app-status.json` session number
incremented + fresh `started` timestamp, `[resume]` spawn lines, one process per pane. If you remember the
prior session AND the session number has NOT incremented, THEN the restart didn't happen. Do not re-stage a
restart that already worked.

**Why `coord/restart-request.json` still matters:** it is the staged record (HEAD, clean-tree, reason) that
the executor/Codex reads as the source of truth for *what* to load. Keep it fresh (clean tree, real HEAD) AND
put the trigger in the Codex inbox. Both. The transport that would let the app push a visible message directly
into Codex Desktop is unsupported (`hm-codex-desktop-transport.js` reports `can_inject_visible_message:false`,
`can_summon_workspace:true`), which is why the inbox-poll is the path.

**`hm-restart-execute.js` launch-target guard (S443):** main-profile relaunch must resolve to the app launcher
(`npm start` from `ui/`) unless an explicit registry `launchCommand` exists. Do not replay a captured
`electron.exe <script>` command line for main SquidRun: after the old app dies, a surviving helper such as
`ui/scripts/hm-bidirectional-wake-watchdog.js` can be the only remaining Electron process and replaying it
starts the helper instead of the app. The process selector must also reject Electron-hosted `ui/scripts/*`
helpers as primary app targets. Regression command for this script-level test file:
`npm --prefix ui test -- --runTestsByPath __tests__/hm-restart-execute.test.js --runInBand`.

**Codex attention poller heartbeat alarm (S443):** Codex Desktop now writes
`.squidrun/runtime/codex-attention-bridge/poller-heartbeat.json` during its attention-poller cycle. Startup
health reads that file and emits `codex_attention_poller_heartbeat_stale` when an existing heartbeat is stale
or unreadable. Default threshold is 15 minutes, overrideable with
`SQUIDRUN_CODEX_ATTENTION_POLLER_HEARTBEAT_STALE_MS` or
`--codex-attention-poller-heartbeat-stale-ms=<ms>`. This is the tripwire for "the restart hand is absent":
do not use retired `.squidrun/coord/codex-heartbeat.json` for this.

**S400/S405 Codex Desktop cleanup boundary** (S405 split-verdict after 3-way consensus — Oracle over-deletion, Codex `.codex/automations` check, Architect in-repo grep). Keep the live/current surfaces only:
- `.squidrun/runtime/codex-attention-bridge` — **VERIFIED LIVE** restart + coordination path (`watch-codex-attention-requests`). This is the one that matters.
- `.squidrun/runtime/codex-desktop-capability-status-v0.json`
- `.squidrun/runtime/codex-desktop-inbound-transport-report-v0.json`
- `.squidrun/coord/codex-heartbeat.json` — KEEP: has an in-repo READER (`hm-codex-heartbeat-check.js`). But its WRITER (the `squidrun-codex-wake-bridge` poller) is retired/uninstalled, so it is frozen (dead since May 30) and the heartbeat check will read stale **by design now** — that is expected, not a bug.
- `.squidrun/coord/codex-inbox.jsonl` — KEEP, but **asymmetric**: WRITE-side LIVE (`hm-alignment-audit.js` line ~261 `appendJsonLine(instanceConfig.codexInboxPath,…)`, wired via `operator-registry.json` line 15 `codexInbox`), READ-side RETIRED (the wake-bridge poller is uninstalled). => envelopes written here are currently **UNCONSUMED**. Do NOT delete; do NOT touch `operator-registry.json` line 15 (pulling it breaks the audit tool). Restored as an empty log after the S405 over-deletion.
- `.squidrun/coord/restart-request.json`
- `.squidrun/coord/restart-handoff.md`
- `.squidrun/coord/restart-execute-log.jsonl`

**RETIRED DEAD (S405) — dropped from keep-list, do NOT recreate (resurrection-trap guard):**
- `.squidrun/coord/codex-inbox-processed.json` and `.squidrun/coord/codex-wake-bridge-status.json` — OUTPUTS of the retired `squidrun-codex-wake-bridge` poller. Zero in-repo reader AND zero in-repo writer; the consumer automation is uninstalled per Codex Desktop's own `.codex/automations` check. They will NOT regenerate. Kill rationale: dead poller outputs. Leave absent; recreating them would be fabrication.

Deleted S400 stale/corpse artifacts with no live consumers: old `codex-*2026-04-29`
briefing/guardrail/maintenance notes, one-off postrestart proof snapshots, detached
restart helper/result/launch files, and extracted Codex app protocol bundles under
`.squidrun/runtime/codex-app-*`. Do not recreate those as parking lots. A stale
heartbeat means "current proof not established", not "Codex Desktop is dead"; check
the attention bridge and current capability status before assigning restart/proof work.

**Cleanup doctrine — before deleting ANY `coord/`/`runtime/` state (S405 lesson, learned the hard way via an over-deletion of external-owned state):** verify ALL of —
(a) in-repo **readers**, (b) in-repo **writers** (a file with no reader may still have a live writer, like `codex-inbox.jsonl`), (c) `operator-registry.json` references, and (d) **external** automation registries (`.codex/automations`) via Codex Desktop. "No grep hit" does NOT mean dead: external consumers (Codex Desktop) have no in-repo reader at all, so a grep-clean file can still be live external-owned state. gitignored coord/runtime files are unrecoverable once deleted. When ownership cannot be verified across all four, HANDS OFF and flag rather than delete.
