# Oracle Startup Context Audit - Session 299

Generated: 2026-04-26T01:55Z  
Role: Oracle  
Scope: startup briefing, session-start hook context, startup health prefix, handoff materialization, session counter, and trading ops knowledge docs.  
Constraint: audit only. No fixes applied for this dispatch.

## Executive Summary

Startup context currently has three trust breaks:

1. `session.md` can be written with an older source session when the current session has no "meaningful" rows yet. That is how agents can see `app-session-179` while app-status is already `session 299`.
2. The "Live Account / Verified Snapshot" block is verified only when `ai-briefing.md` is generated. The session-start hook injects that file later with no TTL, no status check, and no live revalidation.
3. Paper trading is the clearest fake-removal pattern: the entry point returns early, but supervisor plumbing, health warnings, briefing logic, docs, tests, and module files remain alive. Several other disabled lanes show the same stale-status shape, though paper is the most user-visible.

Current observation: `.squidrun/handoffs/session.md` self-corrected to `app-session-299` after current-session messages existed. The startup bug is still real because the initial boot window can emit the stale fallback before current rows accumulate.

## Direct Answers

### 1. Who writes `session.md`, and why was it stuck at 179?

Writer: `ui/modules/main/auto-handoff-materializer.js`, called from `ui/modules/main/squidrun-app.js`.

- `ui/modules/main/squidrun-app.js:3404` calls `autoHandoffMaterializer.materializeLatestHandoff(...)`.
- `ui/modules/main/auto-handoff-materializer.js:99` resolves the effective app session id from app-status.
- `ui/modules/main/auto-handoff-materializer.js:295` selects source rows for the handoff.
- `ui/modules/main/auto-handoff-materializer.js:322` falls back to the latest prior session with meaningful rows when current-session rows are considered empty/noise.
- `ui/modules/main/auto-handoff-materializer.js:1078` prints `session_id` from `sourceSession.sessionId`, so fallback rows can label the handoff as an old session.

Root cause: app-status was not stuck. App-status had `session 299`. The handoff materializer used a prior meaningful session as the source and wrote that prior session id into the handoff. Early boot rows like "online", "standing by", startup health, and brief status messages are filtered as low-signal/noise, so a fresh session can look empty and trigger old-session fallback.

Severity: Critical. This makes stale context look canonical.

### 2. Freshness contract for "Live Account / Verified Snapshot"

Actual contract in code: verified at generation time only.

- `ui/modules/startup-ai-briefing.js:229` fetches live Hyperliquid state while generating the briefing.
- `ui/modules/startup-ai-briefing.js:385` formats that snapshot into the prompt/document.
- `ui/modules/startup-ai-briefing.js:444` tells the LLM to use the verified live snapshot.
- `ui/modules/startup-ai-briefing.js:566` writes `.squidrun/runtime/startup-briefing-status.json` with `generatedAt`, `liveSnapshotOk`, and open-position count.
- `.claude/hooks/session-start.sh:40` injects `.squidrun/handoffs/ai-briefing.md` blindly.

There is no TTL, max-age warning, app-status cross-check, live Hyperliquid revalidation, or "snapshot age" banner in the hook. A briefing generated at `2026-04-25T20:28Z` and loaded at `2026-04-26T01:40Z` can still be presented as "Verified Snapshot." In the current boot, `ai-briefing.md` generated at `2026-04-26T01:40:36Z` showed account value about `$557.00`; a later startup-health probe around `2026-04-26T01:50Z` showed about `$551.01`. That is normal market movement, but the injected language does not tell the agent it is a 10 minute old snapshot.

Severity: High for trading trust and live-risk context.

### 3. Other lanes/features in the same shape as paper trading

Paper trading is the only confirmed exact fake-removal pattern with an explicit "removed per James directive" comment. Other lanes share the stale-disabled-status shape:

- `tradingAutomation` / Alpaca stocks: disabled/manual-only, but status still carries stale market phase data from `2026-03-19`; docs still describe Alpaca-driven stock supervisor operations.
- `polymarketTradingAutomation`: disabled, but supervisor status still carries old `lastProcessedAt` and scheduled `nextEvent`.
- `launchRadarAutomation`, `newsScanAutomation`, `pendingFollowupAutomation`, `marketResearchAutomation`, `eunbyeolCheckInAutomation`, `yieldRouterAutomation`: disabled, but status still carries stale run metadata.
- `oracleWatch`: enabled and heartbeating, but supervisor status can read `running: false` because it is not inside an active tick at that instant. This can be misread as "watch loop dead."
- `cryptoTradingAutomation` and `marketScannerAutomation`: not fake removals, but they remain broad automated consult/scanner lanes while the strategy directive has shifted to ORDI-pattern gating. They need clearer gating/status language so startup context does not imply generic broad-trade readiness.

Severity: High for paper, medium for stock/crypto context trust, low-to-medium for inactive experimental lanes.

### 4. Other "removed per James directive YYYY-MM-DD" gates

Exact search found one direct hit:

- `ui/supervisor-daemon.js:4045` - `Paper-trading automation removed per James directive (2026-04-20T04:35Z).`

Related but not the same fake-removal pattern:

- `ui/modules/main/squidrun-app.js:2403` comments that Eunbyeol shortcut auto-creation was disabled per James instruction. This appears to gate a narrow startup behavior, not hide a large still-alive subsystem.

## Per-Source Findings

### `.claude/hooks/session-start.sh`

- `.claude/hooks/session-start.sh:24` runs `hm-startup-health.js` during startup context injection. Severity: Medium. The hook can mutate runtime state while also producing context because health runs in auto-fix mode unless told otherwise.
- `.claude/hooks/session-start.sh:40` injects `.squidrun/handoffs/ai-briefing.md` without checking `generatedAt`, startup-briefing status, or live-snapshot age. Severity: High.
- `.claude/hooks/session-start.sh:44` chooses the latest handoff by mtime across `session.md`, `last-session.md`, `last-session-summary.md`, and `workspace/knowledge/session-*-handoff.md`. Severity: High. This can prefer a stale-but-newer backup or knowledge artifact over canonical current-session context.
- `.claude/hooks/session-start.sh:90` injects multiple context sources into one block without contradiction checks. Severity: Medium.

### `.claude/hooks/pre-compact-memory.sh`

- `.claude/hooks/pre-compact-memory.sh:30` repeats the latest-mtime handoff selection logic from session-start. Severity: Medium.
- `.claude/hooks/pre-compact-memory.sh:91` tells agents to manually update the handoff file as cross-session memory. Severity: Medium. This conflicts with current auto-materialized handoff behavior and with role docs that discourage manual per-pane handoff maintenance.

### `.claude/hooks/user-prompt-timestamp.js`

- `.claude/hooks/user-prompt-timestamp.js:109` injects local/KST timestamp only. Severity: None. No stale startup context found here.

### `ui/modules/startup-ai-briefing.js`

- `ui/modules/startup-ai-briefing.js:229` fetches Hyperliquid once during generation. Severity: Informational by itself.
- `ui/modules/startup-ai-briefing.js:385` formats the live snapshot as a "verified" block but does not encode a TTL into the generated markdown. Severity: High when consumed later.
- `ui/modules/startup-ai-briefing.js:543` writes `Generated:` at the document top, but hook consumers do not enforce it. Severity: Medium.
- `ui/modules/startup-ai-briefing.js:566` writes status metadata, but session-start does not read or validate it. Severity: High.
- `ui/modules/startup-ai-briefing.js:285` still resolves paper portfolios and paper PnL for the briefing. Severity: Medium/High while paper removal is in progress.

### `ui/scripts/hm-startup-health.js`

- `ui/scripts/hm-startup-health.js:39` no longer lists paper in `REQUIRED_LANES`, which is good.
- `ui/scripts/hm-startup-health.js:105` still maps `paper_trading_automation` / `paperTradingAutomation` as lane keys. Severity: Medium.
- `ui/scripts/hm-startup-health.js:311` warns on `paperTradingAutomation.enabled === false`. Severity: High. This is the current "disabled lane still warning every boot" trust break.
- `ui/scripts/hm-startup-health.js:445` auto-deletes cruft and can perform startup repairs in default mode. Severity: Medium. The hook label says "auto-fixed where safe," but context generation should distinguish observations from mutations.

### `.squidrun/handoffs/session.md`

- Current file now shows `app-session-299`, generated around `2026-04-26T01:48Z`. Severity: Informational.
- Earlier startup showed `app-session-179` because the materializer fallback selected old meaningful rows. Severity: Critical as a system behavior, even though the file later self-corrects.

### `.squidrun/handoffs/last-session.md`

- This appears to be a mirror/backup of handoff content. Severity: Medium. Because session-start selects by latest mtime, a backup can become the selected "mandatory read" even if canonical `session.md` is not current.

### `.squidrun/handoffs/ai-briefing.md`

- Current file generated at `2026-04-26T01:40:36Z`, but hook has no max-age. Severity: High.
- Live-trading block is generated prose from a point-in-time snapshot. Severity: High if interpreted as current live account truth after market moves.

### `.squidrun/handoffs/last-session-summary.md`

- Included in latest-mtime handoff selection. Severity: Medium. It is a summary artifact, not a canonical current-session file, and should not be able to outrank current `session.md`.

### `ui/modules/main/squidrun-app.js`

- `ui/modules/main/squidrun-app.js:2386` starts startup briefing generation during app init.
- `ui/modules/main/squidrun-app.js:2476` increments/writes app-status later.
- `ui/modules/main/squidrun-app.js:3383` runs briefing generation asynchronously and does not block pane/session-start launch.
- `ui/modules/main/squidrun-app.js:3404` starts auto-handoff materialization.

Severity: High. There is a race: panes can consume old `ai-briefing.md` or old/fallback handoff context while generation/materialization is still running.

### `ui/modules/main/settings-manager.js`

- `ui/modules/main/settings-manager.js:424` writes `.squidrun/app-status.json`.
- `ui/modules/main/settings-manager.js:440` increments the session counter from the previous baseline.
- `ui/modules/main/settings-manager.js:493` writes atomically.

Severity: Low. The app-status writer appears consistent; it is not the source of the `179` value.

### `ui/modules/context-compressor.js`

- `ui/modules/context-compressor.js:200` reads `.squidrun/handoffs/session.md` as-is.
- `ui/modules/context-compressor.js:262` treats handoff content as required/high-priority.
- `ui/modules/context-compressor.js:426` separately reads app-status and current session progress.

Severity: Medium/High. If context compression runs during the fallback window, it can package `Generated Session 299` together with a handoff labeled `app-session-179`, preserving split-brain context into future resumes.

### `knowledge/trading-supervisor-ops.md`

- `knowledge/trading-supervisor-ops.md:18` still describes stock-market-day supervisor phases. Severity: Medium.
- `knowledge/trading-supervisor-ops.md:39` still describes Alpaca client/news flow. Severity: Medium.
- `knowledge/trading-supervisor-ops.md:50` points to `workspace/.squidrun/runtime/trading-supervisor-state.json`, which appears stale/wrong for current runtime layout. Severity: Medium.
- `knowledge/trading-supervisor-ops.md:56` says startup health warns on `paper_trading_automation`. Severity: High because it canonizes a removed lane warning.

### `workspace/knowledge/trading-operations.md`

- `workspace/knowledge/trading-operations.md:1` says it was last updated in session 273. Severity: Medium.
- `workspace/knowledge/trading-operations.md:35` says James pattern notes are "context, not hard pre-trade gates." Severity: High strategic contradiction with the new ORDI-pattern / dump-history mandatory directive.
- `workspace/knowledge/trading-operations.md:84` correctly says AI startup briefing is transcript-derived and not a live wallet oracle. Severity: Good guardrail, but session-start does not surface this warning strongly enough.
- `workspace/knowledge/trading-operations.md:119` says to throw away paper-trading logic. Severity: High doc/code mismatch because the paper pipeline still exists.

## Fake-Removal / Dead-Plumbing Evidence

### Paper Trading

Confirmed fake-removal shape:

- `ui/supervisor-daemon.js:54` still requires `./modules/trading/paper-trading-automation`.
- `ui/supervisor-daemon.js:80` hard-disables `SQUIDRUN_PAPER_TRADING_AUTOMATION`.
- `ui/supervisor-daemon.js:1910` still builds paper-trading state and summaries.
- `ui/supervisor-daemon.js:3128` still includes paper automation in loop result handling.
- `ui/supervisor-daemon.js:3281` still has paper wake scheduling.
- `ui/supervisor-daemon.js:3660` through `ui/supervisor-daemon.js:4032` still contains the paper workflow body.
- `ui/supervisor-daemon.js:4045` early-returns with the "removed per James directive" comment.
- `ui/supervisor-daemon.js:9003` still reports `paperTradingAutomation` in status.
- `ui/modules/trading/paper-trading-automation.js` still exists.
- `ui/__tests__/paper-trading-automation.test.js` still exists.
- `ui/scripts/hm-paper-competition-audit.js` still exists.
- `ui/modules/startup-ai-briefing.js:285` still includes paper state in startup briefing generation.
- `ui/scripts/hm-startup-health.js:311` still warns when paper is disabled.

Severity: High. This is exactly the pattern James called out.

### Disabled Status Lanes With Stale Metadata

These are not confirmed fake-removals, but they have the same user-facing trust risk if surfaced as startup truth:

- `tradingAutomation`: disabled/manual-only with stale March market-phase state.
- `polymarketTradingAutomation`: disabled with stale run metadata and scheduled next event.
- `launchRadarAutomation`, `newsScanAutomation`, `pendingFollowupAutomation`, `marketResearchAutomation`, `eunbyeolCheckInAutomation`, `yieldRouterAutomation`: disabled but still present in supervisor status with old timestamps or events.
- `paperCompetition`: still present as a status concept even when empty.

Severity: Medium. If they are intentionally dormant, status should either omit them from startup summaries or mark them explicitly as archived/dormant with no live schedule semantics.

## Prioritized Fix List

1. Fix handoff source selection so `session.md` always labels the current app session. If prior-session rows are used as fallback context, print them under a separate "prior context" block with explicit source session and age.
2. Make session-start wait for current startup briefing generation or print a hard stale warning. Use `.squidrun/runtime/startup-briefing-status.json` and enforce a max age for live trading snapshots.
3. Stop latest-mtime handoff selection from outranking canonical current-session context. Prefer `.squidrun/handoffs/session.md` only after validating its `session_id` against app-status; treat `last-session*` and `workspace/knowledge/session-*-handoff.md` as backups with labels.
4. Complete the paper-trading rip across supervisor, startup-health, startup briefing, tests, scripts, and docs. Remove disabled-lane warnings for intentionally archived lanes.
5. Split startup health into report-only context mode and explicit repair mode. Session-start should not mutate runtime state unless the hook says so clearly and records what changed.
6. Update trading ops docs to reflect the ORDI-pattern framework, mandatory dump-history / substitute-evidence gate, and current live-vs-paper boundaries.
7. Normalize supervisor status for disabled/dormant lanes: no stale `nextEvent`, no old `lastProcessedAt` presented as live status, and no disabled lane warnings unless a required lane is unexpectedly off.
8. Clarify `oracleWatch.running` semantics. Use `enabled`, `heartbeatFresh`, and `lastRunAt` instead of a momentary `running: false` that reads like a dead loop.
9. Add contradiction checks in the startup context assembly: app-status session id vs handoff session id, AI briefing age vs live-account label, and docs that mention removed lanes still appearing in status.

## Suggested Builder Batch

Fast trust-restoration batch:

1. Handoff session-label fix.
2. AI briefing TTL/stale warning in session-start.
3. Paper warning removal from startup-health after Builder's full rip lands.
4. Latest-mtime handoff selection replacement.

Follow-up cleanup batch:

1. Disabled lane status normalization.
2. Trading docs refresh.
3. Context compressor contradiction guard.
4. Startup health report-only mode for hooks.

