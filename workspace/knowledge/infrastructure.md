# Infrastructure

- Vercel: team `anamnesos`, project `squidrun-site`.
- GitHub: `anamnesos/SquidRun`.
- Relay: hosted on Railway (`wss://relay-production-2c27.up.railway.app`).
- Telegram bot: configured via `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `.env`.

## TrustQuote route-owner supervisor: ELECTRON_RUN_AS_NODE launch fix (S404)

**Root cause (the stuck-STARTING bug):** `startTrustQuoteRouteOwner` in `trustquote-work-room-route-owner-supervisor.js` spawned `process.execPath` to run the route-owner script. Inside the Electron main process `process.execPath` is `electron.exe`, and spawning it **without** `ELECTRON_RUN_AS_NODE=1` launches a second full Electron app, not Node — so the route-owner script never executed, the supervisor sat at `state=STARTING` forever, and room port **9979 never bound**. Downstream symptom: the main-side readiness probe raced an 8s DOM check against a supervisor that would never reach ready, producing a false `workroom_unusable`.

**Fix:** `resolveRouteOwnerLaunchExecutable()` injects `ELECTRON_RUN_AS_NODE=1` into the spawn env when `process.execPath` is electron (skips it when already Node, or when not inside Electron); overridable via `SQUIDRUN_TRUSTQUOTE_ROUTE_OWNER_NODE_PATH` / `SQUIDRUN_SUPERVISOR_NODE_PATH`. Plus state-correctness gating in `squidrun-app.js`: readiness now requires `status.state==='running'` AND a proven route probe (`canRouteTask`); `isTrustQuoteRouteOwnerCurrent` and `getTrustQuoteRouteOwnerSessionScopeId` no longer accept a bare `running:true` with a non-`running` state.

**Restart-safety (verified S404 Oracle gate):** a running-but-not-`running` supervisor (e.g. a stale `STARTING` one) is stopped and relaunched on the next workspace-open. The stop path is **terminal-safe**: `ensureTrustQuoteRouteOwnerCurrent` always passes `killTerminalsOnStop:false` + `attachExistingTerminals:true`, so `stopTrustQuoteRouteOwner` SIGTERMs only the supervisor pid and never cleans up the attached agent terminals James can see. Stale cross-session supervisors are caught by the `session_scope_changed` stop branch; same-session not-ready ones by the `route_owner_not_ready` branch — so a stuck supervisor cannot deadlock a fresh launch. `ensure` is one-shot per workspace-open (not a loop), so a persistent failure returns a clean error rather than thrashing stop/start. Caveat (low, forward-looking): the `RUN_AS_NODE=1` env is inherited by any child the route-owner spawns; today it runs `--no-launch-agents`/attach-only so it spawns none, but if agent-launch is ever enabled, confirm the agent spawn strips `ELECTRON_RUN_AS_NODE` so the codex/claude CLIs don't inherit it.

### Manually (re)opening the TrustQuote agents from the Architect CLI (S406)

When James says "open the TrustQuote agents" and the room is dead, the symptom is `hm-send … --target-profile trustquote` returning **`scope_route_unavailable`** (route-owner alive but scoped to a previous `app-session-N`) or **`ECONNREFUSED 127.0.0.1:9979`** (no supervisor at all). After an app restart the side work-room does **not** always auto-relaunch under the new session scope.

Procedure (Architect pane, project root):
1. Diagnose: `node ui/scripts/hm-trustquote-room-route-owner.js status` (and `probe`). Check `sessionScopeId` matches the current `app-session-N` from `.squidrun/app-status.json`.
2. If scoped to an old session: `node ui/scripts/hm-trustquote-room-route-owner.js stop` (terminal-safe — kills only the supervisor pid).
3. Relaunch persistently:
   `node ui/scripts/hm-trustquote-room-route-owner.js start --launch-agents --allow-live-agents --session app-session-<N> --status-file D:\projects\squidrun\.squidrun\runtime\trustquote-work-room-route-owner\status.json`
   - `--allow-live-agents` is **required** alongside `--launch-agents`, else `start` refuses with `live_agent_launch_requires_explicit_allow`.
4. Verify: `status` shows `state:running`; port 9979 OPEN; a generic `hm-send.js builder --target-profile trustquote --file <ping>` returns `delivered.websocket` (the real liveness proof — process-alive is not enough).

**CRITICAL — use `start`, NOT `run`, for persistence.** The `start` command spawns the supervisor `detached:true` + `child.unref()` + `windowsHide:true` (see `startTrustQuoteRouteOwner`), so it survives the launching shell. Launching `run` directly as a backgrounded shell command (e.g. via a tool's `run_in_background`) ties the supervisor's lifetime to that shell task — when the task is reaped the supervisor dies, port 9979 closes, and the room silently drops. This bit S406: a backgrounded `run` looked healthy for ~70 min then died on task reap. Content-guard note: the room's content filter rejects main-context-looking bodies (`MAIN_CONTEXT_PATTERN`) — send generic liveness pings via `--file`, not inline strings full of session/lane/main-architect wording.

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

**Restart proof = continuity test.** If you still remember the prior session's conversation, the restart did
NOT happen — a real restart spawns a fresh Architect with no memory of it. Don't dig through logs to answer
"did it restart"; you'd be a new Architect if it had.

**Why `coord/restart-request.json` still matters:** it is the staged record (HEAD, clean-tree, reason) that
the executor/Codex reads as the source of truth for *what* to load. Keep it fresh (clean tree, real HEAD) AND
put the trigger in the Codex inbox. Both. The transport that would let the app push a visible message directly
into Codex Desktop is unsupported (`hm-codex-desktop-transport.js` reports `can_inject_visible_message:false`,
`can_summon_workspace:true`), which is why the inbox-poll is the path.

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
