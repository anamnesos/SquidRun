# Trading Operations — Read on EVERY startup
# This file is the single source of truth for how SquidRun should trade.
# Updated: 2026-04-16 session 273

## Immediate Session Note
- Before acting in the current live Hyperliquid lane, also read `workspace/knowledge/session-285-trading-runtime-handoff.md`.
- That file captures the current execution/runtime failure modes, the confirmed clog points, the active `XAI`/queue truth, and the plain-English operating standard James expects.
- Current public-core startup caveat (verified 2026-05-21 session 378): `ui/scripts/hm-defi-status.js` is absent after live-ops extraction. Do not claim live wallet/position status from that dead path. First inspect `.squidrun/runtime/supervisor-status.json`; if `LiveOpsExecution`, `LiveOpsPositionMonitor`, `oracleWatch`, and position attribution are disabled with `live_ops_removed_from_public_core` / `manual_only`, report that no SquidRun live trade lane is running. A real wallet/position check requires the private live-ops overlay or another current read-only Hyperliquid status path.

## Core Truth
- Hyperliquid is the only real-money trading lane that matters.
- The legacy Alpaca/paper lanes are gone. Ignore old paper signals, paper P&L, and paper automation references in historical notes.
- Fewer names, cleaner entries, bigger meaningful size, faster profit-taking.

## Focus Universe
- Default watchlist: `BTC`, `ETH`, `SOL`.
- Add at most `1-2` hot alts when they have real volume, real liquidity, and a cleaner setup than the majors.
- If a wider consultation basket still exists in code, treat the extra names as scan noise, not permission to trade them.
- Do not spray `20`-coin baskets.

## Trading Routine
1. Verify live-ops availability before doing anything else. Prefer the current read-only Hyperliquid status path if present; if `ui/scripts/hm-defi-status.js` is absent, inspect `.squidrun/runtime/supervisor-status.json` and report live-ops disabled/manual-only instead of pretending wallet state was checked.
2. If live position data is missing or contradictory, stop. Missing live state is a blocker.
3. Check whether there is a real market-breaking event in the next hour. If yes, stand down or cut size hard.
4. Check Tokenomist unlocks for the next `48` hours `4x` daily. Use Tokenomist for scheduled supply events, not as a magic scalp signal.
5. Watch `BTC` and `ETH` first. Only rotate to `SOL` or hot alts if they are clearly cleaner.
6. Build one plain-English trade ticket: symbol, side, why now, entry, stop, first take profit, second take profit, and what proves the idea is wrong.

## Entry Rules
- No trade without an exchange-native stop placed at entry.
- If scalp mode is armed with `SQUIDRUN_HYPERLIQUID_SCALP_MODE=1`, the normal trading stack may route live Hyperliquid entries.
- If scalp mode is not armed, Hyperliquid stays manual and the system should monitor and alert only.
- A trade is not real just because the chart looks good. It needs a clean entry, a stop, and a reason now.
- Use honest market structure, venue-native data, and current macro context to decide whether a setup is real. Do not reject a trade just because it fails a memorized pattern checklist.

## Optional Context
- James pattern notes are context, not hard pre-trade gates. They can improve framing, but they do not override live price, current liquidity, venue-native tape, or direct market evidence.
- The `1-2h` price band split can help with entry geometry. Shorts often improve when entered higher in the band and longs often improve when entered lower in the band, but this is a location aid, not a universal rule.
- Post-dump structure can be useful context. A sequence like `parabolic recovery -> secondary drop -> chop -> rebuild` may help explain price action, but it is not a mandatory script the market must follow.
- `bullish_pullback`, retracement-low progression, and `4+` green `5m` candles can be useful warning signs that the move is noisy or rebuilding, but they are not automatic vetoes.
- Chop discipline remains good practice for management and caution, but it should not be treated as a universal blocker on every coin or every board state.
- Catalyst plus tape agreement is usually stronger than catalyst alone, but it is a quality preference, not a hard law that automatically invalidates every trade.

## Sizing Rules
- Size by max dollar risk first, not by excitement.
- On majors, `20-25x` is allowed only when the stop is tight and the setup is clean.
- On alts, respect venue leverage caps and lower liquidity. Do not force major-style leverage onto weak names.
- The size must match the strength of the setup. If the setup is strong enough to trade, it should be large enough to matter.
- Default notional should be meaningful relative to the account and the daily target, not token-sized filler.
- Thin-book capped-leverage alt EV rule (session 289): do not hide behind pretty paper R:R when the venue leverage cap, wick-hit probability, and time-to-target turn the trade into filler. If the expected dollars for the capital locked are materially worse than a cleaner higher-liquidity setup, close or skip it even if the structure is technically valid.

## Management Rules
- Take profit fast. Pay yourself on the first push.
- After the first partial, move the stop on the remainder to breakeven or better.
- A winner must not turn into a loser because nobody acted.
- If the setup degrades, close it. Do not turn every trade into a debate while profit disappears.
- In chop, treat any green P&L as a gift and exit rather than sitting on catalyst hope. Chop is management mode, not conviction mode.
- Opportunity-cost close rule (session 289): if a thin alt short is near flat, the stop still has high wick-risk, and the remaining path to target offers low expected dollars for the capital and time locked, closing for a scratch/small win is acceptable. Capital belongs in real edge, not in a technically alive but economically weak hold.

## What Is Real Right Now
- `node ui/scripts/hm-defi-execute.js` can place live Hyperliquid entries through the normal path when scalp mode is armed.
- `node ui/scripts/hm-defi-close.js` can close or reduce live positions through the normal path.
- The journal now records real trade directions and execution deltas instead of only fake end-state stories.
- The bracket slice is real in a narrow, testable path:
  - entry script places the exchange stop plus a real TP1 partial
  - `node ui/scripts/hm-hyperliquid-bracket-manager.js` can move the runner stop to breakeven after TP1 fills

## What Is NOT Fully Proven Yet
- Full unattended end-to-end live automation through the whole supervisor/orchestrator stack is not fully proven.
- The final live proof still needed is the complete snap-back path:
  - entry
  - TP1 partial
  - stop moved
  - remainder later exits cleanly
  - journal records every leg as explicit deltas
- Rate-limit noise still exists on some live Hyperliquid reads. Do not fake precision when the live feed is noisy.

## Position Monitoring
- Supervisor still tracks open Hyperliquid positions and peak P&L.
- Giveback alerts matter. Protecting open profit is a real action, not weakness.
- Do not assume the account is flat or funded from this file. Always verify live.
- If `hm-defi-status` and consultation payloads disagree about balance or exposure, stop and verify before trading.
- If scanner state files are stale or contradictory, bypass them and pull live `getHistoricalBars`, `getL2Book`, and `getUniverseMarketData` from `ui/modules/trading/hyperliquid-client.js` before calling the board dead.

## Attribution Discipline
- The AI startup briefing is transcript-derived context, not a live wallet oracle. It can be useful, but it is not allowed to override `hm-defi-status` or fresh consultation snapshots.
- Managed-book boundary rule (session 289): a James/manual trade is not part of the SquidRun managed book unless it is explicitly registered into the app's attribution/runtime state for management. Do not curate, explain, or risk-manage it as if it were an Oracle/Architect position just because it shares the same wallet.
- Shared-wallet nuance (session 289): a manual user-book position can still matter for wallet-capacity awareness if it is consuming real margin in the same account, but that does not make it part of the managed book or give SquidRun ownership over entry/exit decisions.
- Known external-closer signature: exact-size full flatten, `reduceOnly=true`, `cloid=null`, aggressive IOC-style limit, with no matching SquidRun `execution_reports` row in the same window.
- If that signature appears again, treat SquidRun as innocent until proven otherwise and inspect Hyperliquid wallet approvals first.
- Session 274 named suspects were `rabby-mobile` and `rabby-agent`. Until attribution is definitively closed, keep separating "wallet-side writer" from "checked-in SquidRun writer" in all incident notes.
- SquidRun-side Hyperliquid writes now leave a local audit trail in `.squidrun/runtime/trading-writes.log` (commit `9313812`). Use that before claiming the app did or did not fire a live order.
- Hyperliquid trigger-order cancel/replace caveat: `openOrders` can surface trigger stops/TPs without an `orderType` field that cleanly distinguishes them from plain resting orders. For stop replacement, do not rely on filtering `openOrders` by inferred order type.
- Verified recovery pattern (session 289): read the latest non-canceled SL `oid` from `.squidrun/runtime/trading-writes.log`, cancel that exact `oid` first, then place the replacement stop. If the audit trail is missing, fallback classification should use live stop price geometry rather than `orderType`. Builder hardened this path and covered it with `ui/modules/trading/__tests__/hm-defi-execute.test.js` and `ui/__tests__/arch-ordi-stop-move.test.js`.
- Manual wick-clearance stop widen rule: once a manual stop override is placed, it keeps ownership until the replacement stop is break-even-or-better, TP1/breakeven takeover has happened, or an explicit handoff clears it. Oracle trailing logic must not silently tighten that stop back inside the invalidation zone first. Runtime marker path: `.squidrun/runtime/manual-stop-overrides.json`.
- Manual stop-override ownership rule (session 289): if a human/operator widens a stop for wick-clearance or invalidation-structure reasons, automatic Oracle trailing logic must not immediately tighten that stop back inside the invalidation/retest zone before the trade has earned real cushion. The handoff back to automatic tightening should happen only after break-even-or-better conditions, TP progression, or another explicit management threshold. Otherwise the runtime silently reverses the manual risk correction.
- Verification rule (session 289): do not treat the attribution stopgap as retired just because the code change shipped or `agentId` moved back to `oracle`. Before handing a still-risky manual widen back to Oracle, verify that the active coord-root state at `.squidrun/runtime/manual-stop-overrides.json` actually contains the override record for that ticker. An empty or missing override file means the new guard has no persisted state to enforce.
- Stale shared-regime rule doctrine (session 289): if a lose/retest trigger drifts materially offside and the runtime proposes a manual reset to brand-new levels, do not quietly re-anchor the old rule and call it maintenance. That is a different trade at a different price. Kill the stale rule from `oracle-watch-rules.json` and let a fresh structural read seed a new rule instead.
- Temporary containment workaround (session 289): if the proper manual-override guard is not shipped yet and Oracle trailing logic keeps re-tightening a manually widened stop, transfer the position out of Oracle ownership in `agent-position-attribution.json` so `maybeManageOracleOwnedPositions` will not touch it on the next watch tick. Restore ownership only after the runtime guard lands.

## Tokenomist Routine
- Run the Tokenomist unlock check every `6` hours.
- Output should stay simple:
  - token
  - unlock time
  - unlock size
  - recipient type
  - Hyperliquid volume
- Tokenomist is for scheduled unlock pressure and supply events. It is not the main engine for all-day scalping.

## Daily Reporting
- Send a daily P&L report every day.
- Include:
  - total P&L versus the daily target
  - every real trade with entry, exit, size, leverage, P&L, and peak P&L
  - missed opportunities with actual math
  - infrastructure failures that hurt trading
  - clear action items for the next session

## What To Throw Away
- Giant consultation baskets full of weak opinions
- Permanent blanket vetoes that block everything for stale or low-quality reasons
- Paper-trading logic pretending to matter
- Any flow that explains trades better than it executes them

## Hard Lessons
- The system used to observe, summarize, and apologize instead of owning outcomes.
- Missing live position awareness already cost real money. Never proceed blind again.
- The edge is not the wording. The edge is live price, real size, real stops, and getting paid before a winner turns into a lecture.
- Pattern observations are useful, but codifying casual teaching notes into universal hard rules can degrade trade quality just as badly as ignoring context.
