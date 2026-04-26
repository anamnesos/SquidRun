# Oracle Health Sweep - 2026-04-25

## Scope Covered

Oracle covered observed behavior, logs, runtime state, ledgers, case-state files, and memory-health indicators for the comprehensive SquidRun health sweep. This report focuses on what the system actually did or recorded, not code ownership.

Covered:
- Communication hygiene from the active comms journals in `.squidrun/runtime/evidence-ledger.db` and `.squidrun/runtime-eunbyeol/evidence-ledger.db`
- Eunbyeol/case state in `workspace/knowledge/case-operations.md` plus verified file existence for referenced artifacts
- Trading state coherence across live Hyperliquid snapshots, supervisor state, trade journal, attribution file, and peak-PnL state
- Memory drift indicators from supervisor status, SQLite files, and supervisor logs
- Runtime/app log volume, repeated errors, and silent operational failures
- Recurring operational failures today, especially Oracle watch heartbeat flapping

Skipped:
- Direct code fixes and launch-guard implementation. Builder owns code paths.
- Killing or restarting live windows. Architect confirmed James already closed the duplicate Eunbyeol parent.
- Legal drafting or trading execution. This is an audit report only.

## Findings

1. Historical profile/routing split-brain, now resolved but recurrence path unknown.

(a) Finding: Main trading runtime and `runtime-eunbyeol` both delivered wrong-domain material during the split-brain era. Main runtime sent Eunbyeol/case/Korean context to the user Telegram lane. `runtime-eunbyeol` sent trading LIVE SPARK alerts to the user Telegram lane. Architect later confirmed James closed the duplicate PID 13632 cluster at about 16:04 local; the remaining Eunbyeol parent is PID 30572 with `--window=eunbyeol --standalone-window`. Treat this as historical leakage plus recurrence risk, not an active leak.

(b) Evidence:
- Main `.squidrun/runtime/evidence-ledger.db`, `comms_journal`:
  - row `39856`, `2026-04-22T09:20:24.670Z`, architect to user Telegram, Korean comfort message.
  - row `39672`, `2026-04-22T06:17:58.010Z`, architect to user Telegram, English text referencing Eunbyeol NHI records.
  - row `39650`, `2026-04-22T05:52:58.832Z`, architect to user Telegram, trading status mixed with "no more race with Eunbyeol msgs".
  - row `39245`, `2026-04-22T04:06:50.731Z`, architect to user Telegram, relay disabled because Eunbyeol messages were being lost.
- `.squidrun/runtime-eunbyeol/evidence-ledger.db`, `comms_journal`:
  - rows `1173`, `1171`, `1169`, `1166`, `1159`, dated `2026-04-24`, trading LIVE SPARK BLAST alerts sent from the Eunbyeol runtime.
  - rows `1097` and `1098`, `2026-04-23T10:19:36Z`, claim the earlier wrong-window routing came from `hm-send.js` hardcoding port `9900` instead of profile-aware `9901`, and that the routing fix was applied.
- Architect update during sweep: PID 13632 duplicate is gone; PID 30572 remains.

(c) Why it matters: This is the exact class of failure James flagged: trading windows receiving Eunbyeol context and case windows receiving trading context. The current duplicate is closed, but the ghost launch path can recreate the failure.

(d) Fix proposal: Builder-owned recurrence guard: enforce one active Eunbyeol profile lock, reject `--profile=eunbyeol` without `--window=eunbyeol` in production launches, and add route assertions that block trading supervisors/alerts under `runtime-eunbyeol`.

2. Live trading state is incoherent around the current AXS short.

(a) Finding: Live Hyperliquid/supervisor state shows one live AXS short, almost no free margin, and a stop above liquidation. Local ledgers, attribution, and peak-PnL trackers do not represent that live position.

(b) Evidence:
- `.squidrun/runtime/crypto-trading-supervisor-state.json`:
  - lines `201` and `249`: `totalMarginUsed` is `632.514601`.
  - lines `210` and `258`: `withdrawable` is `0.023917`.
  - lines `215-226` and `263-274`: live coin `AXS`, `szi=-1929.4`, `liquidationPx=1.757481535`.
- `.squidrun/runtime/consultation-requests/consultation-1777158027001-e5eaky.json`:
  - lines `21-27`: live AXS short, `stopLossPrice=1.7755`, above liquidation for a short.
  - lines `46` and `48`: account equity `632.54`, liquid capital `0.02`.
- `.squidrun/runtime/trade-journal.db`, table `positions`: only open row found was `id=47`, `ETH/USD`, opened `2026-04-15`, not AXS.
- `.squidrun/runtime/agent-position-attribution.json`: stale open entries exist for symbols such as AVAX, RESOLV, ETH, and SOL, but no current AXS attribution.
- `.squidrun/runtime/defi-peak-pnl.json`: `positions` is `{}` despite the live AXS short.

(c) Why it matters: Position-management code can consult stale local truth while the account is effectively fully deployed. A stop above liquidation is not protective.

(d) Fix proposal: Make the Hyperliquid snapshot authoritative on every supervisor tick. Quarantine stale ledger/attribution entries, create an explicit AXS manual/unattributed record, and hard-alert or reject any live stop on the wrong side of liquidation.

3. Oracle watch lane is flapping repeatedly.

(a) Finding: Today had roughly 25 stale/recovered Oracle watch cycles, with stale messages duplicated to Architect and Oracle. The long-running log shows thousands of in-process relaunch warnings since April 17.

(b) Evidence:
- `.squidrun/runtime/evidence-ledger.db`, `comms_journal`, since `2026-04-25T00:00Z`: 51 rows containing "Oracle watch heartbeat stale" and 51 rows containing "recovered". This includes duplicate recipient rows and Oracle relay rows, roughly 25 stale/recovered cycles.
- Examples:
  - rows `44066/44067`, stale at `2026-04-25T21:49:51Z`, last tick `2026-04-25T21:45:49.103Z`.
  - rows `44077/44078`, stale at `2026-04-25T22:20:22Z`, last tick `2026-04-25T22:16:19.935Z`.
  - rows `44084/44085`, stale at `2026-04-25T22:33:41Z`, last tick `2026-04-25T22:29:38.879Z`.
- `.squidrun/runtime/supervisor.log`: 2,582 `[ORACLE WATCH][INPROC_RELAUNCH]` warnings, with recent samples around lines `269957` and `269969`.
- Supervisor status showed the watch enabled with in-process heartbeat green while detached `running=false`, implying unclear ownership rather than a simple dead process.

(c) Why it matters: The trigger lane goes blind during stale periods, then spams recovery messages. Operators learn to ignore the lane health even when real opportunities or failures are involved.

(d) Fix proposal: Choose one heartbeat owner model, either detached process or in-process scheduler. Emit only state-transition health events, include counters, and escalate after N missed intervals instead of every duplicate recipient.

4. Case-state dashboard is internally contradictory and has missing artifact paths.

(a) Finding: `workspace/knowledge/case-operations.md` mixes updated facts with stale headings and stale blocks. It also names NurseCura v4 artifacts and an image-injection script that are not present on disk.

(b) Evidence:
- `workspace/knowledge/case-operations.md`:
  - line `4`: last updated says `2026-04-16 session 282`, despite 4/23 and 4/24 facts appearing later.
  - line `33`: Hillstate 14-day reply deadline says expired `2026-04-17`, but the same line still says "3 days left".
  - line `44`: Qeline/Haeundae police item still references `2026-04-07 14:00` as upcoming.
  - line `58`: `tools/inject-evidence-images.js` marked in progress, but the file is missing.
  - lines `89-91`: NurseCura v4 HTML/PDF claimed delivered, evidence slots still empty.
  - line `64`: states the three National Tax Service splits are Hillstate, not Qeline.
  - line `93`: contradicts line 64 by saying Qeline has three NTS split investigations.
  - line `68`: says Channel A broadcast confirmed for `2026-04-27 19:20 KST`.
  - line `107`: still calls Channel A stale/unverified.
- Missing files verified:
  - `D:\projects\squidrun\workspace\NurseCura_사업계획서_v4.html`
  - `D:\projects\squidrun\workspace\NurseCura_사업계획서_v4.pdf`
  - `D:\projects\squidrun\tools\inject-evidence-images.js`
- Existing relevant files verified:
  - `D:\projects\squidrun\workspace\NurseCura_사업계획서_v2.html`
  - `D:\projects\squidrun\workspace\NurseCura_사업계획서.html`
  - `D:\projects\squidrun\workspace\NurseCura_사업계획서_완성본.docx`
  - `D:\projects\Jeon Myeongsam Case\documents\고소장_전명삼_최종.txt`
  - `D:\projects\Hillstate Case\reference\confirmed-facts.md`
  - `D:\projects\Korean Fraud\reference\confirmed-facts.md`

(c) Why it matters: This file is the shared case brain. Agents will ask the wrong questions or route Korean/legal work from contradictory state, and the NurseCura grant deadline is `2026-04-30 16:00 KST`.

(d) Fix proposal: Rebuild one canonical case-state table from verified files only. Mark missing artifacts as missing, not shipped. Make Channel A, Hillstate, Qeline, and NurseCura each a single-source status row.

5. Memory/cognitive state is not trustworthy enough to drive recommendations.

(a) Finding: Startup health says memory drift, and local state confirms cognitive/index inconsistency. Supervisor has repeated the same memory drift and module-missing failures thousands of times.

(b) Evidence:
- `.squidrun/runtime/cognitive-memory.db`: file exists but is 0 bytes, modified `2026-04-21T22:51:11Z`.
- `.squidrun/runtime/supervisor-status.json`, `memoryConsistency` around lines `342-352`: `synced=false`, `drift_detected`, `missingInCognitiveCount=10`, `orphanedNodeCount=29`.
- `.squidrun/runtime/supervisor.log` grouped counts:
  - 9,071 memory consistency drift warnings.
  - 8,808 `Memory index refresh failed: The specified module could not be found`.
  - 8,789 `Memory index refresh (change:session.md) failed: The specified module could not be found`.
  - 5,272 `Sleep cycle failed: The specified module could not be found`.
  - 5,272 `[ERROR] Supervisor tick failed: The specified module could not be found`.

(c) Why it matters: The rule "verify before recommending" cannot hold if the memory index is structurally stale or empty and warnings are normalized as background noise.

(d) Fix proposal: Stop treating memory drift as a passive warning. Pick the active memory store, rebuild the cognitive index once, archive stale active-task/session-summary memories, and make future module-missing memory refresh failures a single actionable health item.

6. Repeated operational failures are being normalized by log volume.

(a) Finding: `supervisor.log` is about 26.9 MB and `daemon.log` is about 17.5 MB. Important failures are buried under repeated known-state logs.

(b) Evidence:
- `.squidrun/runtime/supervisor.log` grouped counts:
  - 2,582 Oracle watch in-process relaunches.
  - 2,020 Oracle watch engine `429 Too Many Requests` failures.
  - 823 market-scanner phase failures from Hyperliquid shared rate-limit backoff.
  - 9,071 memory drift warnings.
- `.squidrun/logs/app.log` grouped counts:
  - 146 bridge replacement-conflict disconnect/reconnect cycles.
  - 155 Hyperliquid pool-change watcher events.
  - no-client warnings: architect 10, builder 4, oracle 5, telegram 1.
  - recent bridge replacement-conflict samples still appeared around lines `4783` and `4819` during this sweep.
- `.squidrun/runtime/daemon.log`: large file size but few obvious error hits; likely heavy info volume rather than meaningful error density.

(c) Why it matters: The system can look alive while continuously retrying degraded paths. Operators stop reading logs because repeated warnings do not carry ownership or next action.

(d) Fix proposal: Rate-limit identical warnings, log state transitions plus counters, and promote repeated 429/bridge/memory/watch failures into one owner-labeled health card with last-seen and next-action.

7. Paper-trading status is read-only/static but still presented like active context.

(a) Finding: Paper automation is deleted/disabled, but startup and paper-competition summaries still show open positions and PnL as if they may be active agents.

(b) Evidence:
- `.squidrun/runtime/supervisor-status.json` lines `1240-1242`: `paperTradingAutomation enabled=false, running=false`.
- `ui/supervisor-daemon.js`:
  - line `79`: forces `SQUIDRUN_PAPER_TRADING_AUTOMATION=0`.
  - lines `3865-3869`: paper-trading automation removed per James directive, returns `paper_trading_automation_deleted`.
- `.squidrun/runtime/trade-journal.db`:
  - positions row `id=47`, open `ETH/USD`, dated `2026-04-15`.
  - repeated `ETH/USD SELL` dry-run entries on `2026-04-22`.

(c) Why it matters: Handoffs can make people think paper bots or regimes are live when they are archival/static. That pollutes trading consultations and makes agents reason from dead state.

(d) Fix proposal: Label paper competition as archive/readout unless automation is actually enabled, and quarantine stale paper/live-blurred ledger rows from live position reasoning.

8. Stop/order/attribution state has stale entries beyond current wallet truth.

(a) Finding: Attribution still reports old open positions not in the live Hyperliquid snapshot, while current AXS is absent.

(b) Evidence:
- `.squidrun/runtime/agent-position-attribution.json`:
  - lines `4-5`: `AVAX/USD` open.
  - lines `26-27`: `RESOLV/USD` open.
  - lines `202-203`: `ETH/USD` open.
  - lines `224-225`: `SOL/USD` open.
- Current live AXS short from supervisor/request is not represented.
- Startup handoff already flagged AVAX/RESOLV as stale; audit found broader stale-open pattern.

(c) Why it matters: Any stop reconciliation, accountability, or agent-position-management logic built on this file is unsafe until it is reconciled.

(d) Fix proposal: Snapshot the file, reconcile against the Hyperliquid live snapshot, move non-live opens to `closed` or `stale_quarantined`, and create an AXS attribution or explicit `manual/unattributed` record.

9. Prior "fixed" claims were broker-verified but not behavior-verified.

(a) Finding: The system has rows claiming hm-send/profile routing was fixed, yet later rows prove wrong-profile content continued. The same pattern appears in truncation/restart work: a code or broker ack is treated as done before semantic end-to-end checks prove the user-visible behavior.

(b) Evidence:
- `.squidrun/runtime-eunbyeol/evidence-ledger.db` rows `1097` and `1098`: claim hardcoded port `9900` was fixed to profile-aware `9901`, and that the case-only window was re-sent correctly.
- Later `.squidrun/runtime-eunbyeol/evidence-ledger.db` rows `1159-1173`: trading LIVE SPARK alerts still in Eunbyeol runtime.
- Main `.squidrun/runtime/evidence-ledger.db` rows `39650`, `39672`, and `39856`: Eunbyeol/case/Korean context still in main user lane.
- Main `.squidrun/runtime/evidence-ledger.db` row `44108`: Architect notes conflict between Builder saying source demux was guarded and Oracle's observed log evidence of historical profile leakage.

(c) Why it matters: James hears "fixed" and then sees the same symptom again. The missing layer is semantic verification, not another point patch.

(d) Fix proposal: Require every runtime fix to record `verified_by` with a semantic probe: source profile, target profile, chat/lane, delivered row ID, and a negative control proving the other profile did not receive it.

10. Watch/promoter behavior still conflicts with James's trading preference.

(a) Finding: Current Oracle watch rules and promoted triggers are still generating `$125-$150` command suggestions and repeated spark-style alerts, while James's latest directive was ORDI-pattern-only, `$200+` meaningful size, and quiet zero-trade days.

(b) Evidence:
- `.squidrun/runtime/oracle-watch-rules.json`, generated `2026-04-25T23:03:14.529Z`, had promoted mover rules such as LINEA, MEGA, APE, BLAST, APEX, and YGG, with suggested margins often `125` or `150`.
- During the sweep, Oracle watch sent MEGA executable short commands at `$125` margin.
- Historical `.squidrun/runtime-eunbyeol/evidence-ledger.db` rows `1159-1173` show hourly BLAST LIVE SPARK repetition.

(c) Why it matters: Even if execution is manual, the system keeps pushing marginal small-trade prompts into James's attention during a regime where silence is explicitly desired.

(d) Fix proposal: Promote only if dump-history, multi-day pump, and 5m/15m entry structure all pass. Suppress suggested commands below James's meaningful-size floor unless explicitly marked watch-only/no-trade.

## Open Questions For Architect/Builder

1. Which launch path created PID 13632 after PID 30572 was already live: Eunbyeol desktop shortcut, runtime autospawn, profile-main fallback, or a bridge/restart path?
2. Should the immediate trading safety cleanup treat the live AXS short as `manual/unattributed`, or assign it to the agent that last advised position management?
3. Which file should be the single source of truth for case operations: `workspace/knowledge/case-operations.md`, a generated dashboard, or per-case confirmed-facts files?
4. Is `cognitive-memory.db` supposed to be active? If yes, why is it 0 bytes; if no, remove it from startup health and supervisor checks.
5. Should paper-competition readouts remain visible in startup handoffs, or be moved behind an explicit "archive/static" label?
6. For watch rules, should `$200+` meaningful margin be enforced as a hard generation gate, or as a display/alert suppression gate?

## Recommended Next-Action Priority Order

1. Builder: prevent the Eunbyeol ghost launch path from recurring. Current duplicate is closed, so this is now recurrence prevention, not live-window cleanup.
2. Trading safety: reconcile live Hyperliquid state against trade journal, attribution, stop state, and peak-PnL tracking. The AXS stop above liquidation should be treated as urgent.
3. Runtime health: resolve Oracle watch ownership and reduce stale/recovered spam to state transitions with counters.
4. Memory: choose/rebuild the active cognitive memory store and stop repeating module-missing drift warnings.
5. Case state: rebuild the case dashboard from verified files and fix NurseCura artifact status before the `2026-04-30 16:00 KST` deadline.
6. Logs: add rate limits and health-card ownership for repeated bridge, 429, memory, and watch failures.
7. Paper state: relabel paper competition and stale dry-run positions as archive/static.
8. Trading preference alignment: adjust watch/promoter gates so small marginal commands do not keep resurfacing after James's ORDI-pattern-only directive.
