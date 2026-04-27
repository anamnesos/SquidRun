# Market Scanner To Oracle Watch Conversion Spec

## Problem

`MEGA/USD` and `CHIP/USD` were correctly surfaced by the scanner as urgent promoted movers, but they never became Oracle watch rules.

The current seam is split:

- `spark-capture` writes catalyst fire plans to `.squidrun/runtime/spark-fireplans.json`.
- `market-scanner` writes urgent promoted movers to `.squidrun/runtime/market-scanner-state.json`.
- `oracle-watch-regime` only auto-generates rules for the shared-short regime.
- `oracle-watch-rules.json` can therefore stay empty even when scanner and spark both have actionable names.

That is exactly what happened on April 23, 2026:

- `market-scanner-state.json` promoted `MEGA/USD` and `CHIP/USD` into the urgent set.
- `sharedShortRegime.active` was `false` because only 2 names qualified and the current floor is 4.
- `oracle-watch-rules.json` still had `rules: []`.

Result: the names were visible to consultation/oracle analysis, but had no path to become armed watch rules.

## Goal

Add a direct conversion path from:

- scanner-promoted movers
- spark fireplans
- manually flagged priority names

into `oracle-watch-rules.json`, without depending on shared-short-regime activation.

## Existing Inputs

### 1. Spark fireplans

Source file:

- `ui/modules/trading/spark-capture.js`

Relevant output:

- `.squidrun/runtime/spark-fireplans.json`

Relevant fields already present:

- `ticker`
- `source`
- `catalystType`
- `direction`
- `confidence`
- `ready`
- `entryZone.lower`
- `entryZone.upper`
- `stopPrice`
- `takeProfit1`
- `takeProfit2`
- `maxMarginUsd`
- `maxLeverage`

### 2. Market scanner promoted movers

Source file:

- `ui/modules/trading/market-scanner.js`

Runtime state:

- `.squidrun/runtime/market-scanner-state.json`

Relevant fields already present:

- `lastResult.flaggedMovers[]`
- `lastResult.promotedSymbols[]`
- `lastResult.urgentPromotedSymbols[]`
- `lastResult.sharedShortRegime`

Relevant per-symbol fields:

- `ticker`
- `direction`
- `change4hPct`
- `change24hPct`
- `volumeUsd24h`
- `fundingRate`
- `openInterestChange24hPct`
- `score`

### 3. Current watch-rule builder

Source file:

- `ui/modules/trading/oracle-watch-regime.js`

Current limitation:

- it only promotes short names when `sharedShortRegime.active === true`
- it requires `DEFAULT_MIN_SHARED_SHORT_CANDIDATES = 4`

## Required Change

Add a new promotion layer that runs before or alongside `applySharedShortRegime()`:

- name suggestion: `applyPromotedMoverWatchRules()`
- source suggestion: new module `ui/modules/trading/oracle-watch-promotions.js`

This layer should:

1. Read `market-scanner-state.json`
2. Read `spark-fireplans.json`
3. Read optional manual-priority overrides
4. Generate non-regime auto rules into `oracle-watch-rules.json`
5. Seed/update matching entries in `oracle-watch-state.json`
6. Retire stale auto-promoted rules when the source signal expires

## Promotion Sources

### A. Urgent promoted scanner movers

Use:

- `lastResult.urgentPromotedSymbols`
- join back to `lastResult.flaggedMovers`

This path is for the exact `CHIP/MEGA` class of miss.

### B. Ready spark fireplans

Use:

- `firePlans[]` where `ready === true` and `tradeableOnHyperliquid === true`

This path is for catalyst names like:

- `CHIP` Upbit listing
- `ANIME/MET/INIT` unlocks

### C. Manual priority overrides

Add a small config file for James/Architect flagged names.

Suggested path:

- `.squidrun/runtime/oracle-watch-priority-overrides.json`

Suggested shape:

```json
{
  "version": 1,
  "updatedAt": "2026-04-23T17:00:00.000Z",
  "entries": [
    {
      "ticker": "CHIP/USD",
      "preferredDirection": "SELL",
      "reason": "James flagged as excellent short",
      "expiresAt": "2026-04-24T00:00:00.000Z"
    }
  ]
}
```

Manual priority overrides must win over mechanical long bias.

## Rule Types To Generate

### 1. Bearish dump continuation

Use for promoted short names like `MEGA` and `CHIP`.

Trigger type:

- `lose_fail_retest`

Generation rule:

- build from latest 5m structure
- set `loseLevel` slightly above current price after a breakdown
- set `retestMin/retestMax` inside the failed-reclaim zone
- set stop above local 5m/1h structure

Do not block this rule just because funding is negative.

Negative funding should reduce execution confidence, not suppress watch arming, when all of these are true:

- `direction === DOWN`
- `change4hPct <= -0.08` or `change24hPct <= -0.12`
- `openInterestChange24hPct >= 0` or only mildly negative
- `volumeUsd24h >= 250000`

That condition is the exact "obvious dump setup" class that was missed.

### 2. Bullish continuation / reclaim

Use for strong spark/market long names only when the tape is actually constructive.

Trigger type:

- `reclaim_hold`

Only emit a long rule if:

- current price is not already in a waterfall dump state
- 5m structure is reclaim/hold, not breakdown
- spread/liquidity are usable

This is where `CHIP` should have failed on April 23, 2026.

## Priority Order

When multiple sources exist for one ticker:

1. Manual priority override
2. Ready spark fireplan
3. Urgent promoted scanner mover
4. Shared short regime auto rule

Reason:

- James/Architect flagged names must not be overridden by generic mechanical bias.

## Rule Metadata

All auto-promoted rules should carry explicit source metadata.

Suggested fields:

```json
{
  "sourceTag": "promoted_mover_auto",
  "metadata": {
    "promotionSource": "market_scanner_urgent",
    "scannerDirection": "DOWN",
    "change4hPct": -0.1333,
    "change24hPct": -0.1452,
    "openInterestChange24hPct": 0.2505,
    "fundingRate": -0.00005446,
    "overrideDirection": "SELL",
    "overrideReason": "James flagged as excellent short"
  }
}
```

This makes post-mortem attribution easy.

## Lifecycle Rules

### Create

Create/update a promoted rule when:

- source signal exists
- ticker is tradeable on Hyperliquid
- source is still inside TTL

### Retain

Retain rule if:

- source still active
- rule not invalidated
- rule TTL not expired

### Retire

Retire when:

- source disappears from urgent/promoted set and no manual override remains
- source TTL expires
- rule invalidates and is no longer re-promoted

Suggested TTL:

- market scanner urgent mover: 4h
- spark fireplan: until catalyst time + 2h
- manual override: explicit `expiresAt`

## Arming Behavior

The conversion layer must not only write rules.

It must also seed watch state when price is already through the trigger zone, similar to `seedRuleState()` in `oracle-watch-regime.js`.

This matters for names already mid-dump:

- if the rule is created after price has already lost the level, it should appear as `armed` immediately instead of waiting for another full cycle.

## Acceptance Criteria

### AC1: CHIP/MEGA class

Given:

- `market-scanner-state.json` has `urgentPromotedSymbols = ["MEGA/USD", "CHIP/USD"]`
- both names are `direction = DOWN`
- `sharedShortRegime.active = false`

Then:

- `oracle-watch-rules.json` still receives bearish auto rules for both names
- `oracle-watch-state.json` shows them as `idle` or `armed`, not absent

### AC2: Manual James flag

Given:

- `oracle-watch-priority-overrides.json` contains `CHIP/USD` with `preferredDirection = SELL`

Then:

- no bullish auto rule may replace it
- generated rule direction must remain bearish until override expiry

### AC3: Spark direct path

Given:

- `spark-fireplans.json` contains a ready Hyperliquid-tradeable plan

Then:

- the ticker gets a watch rule even if market scanner and shared-short regime do nothing

### AC4: No silent disappearance

For any ticker in:

- `urgentPromotedSymbols`
- ready `spark-fireplans`
- active manual overrides

one of these must be true:

- watch rule exists
- ticker is explicitly rejected with a machine-readable reason

Silent drop is not allowed.

## Rejection Reasons

If a promoted name is not converted, log a reason such as:

- `insufficient_liquidity`
- `spread_too_wide_for_rule`
- `non_tradeable_on_hyperliquid`
- `source_expired`
- `manual_override_conflict`
- `duplicate_active_rule`

Suggested output file:

- `.squidrun/runtime/oracle-watch-promotion-decisions.jsonl`

## Minimal Builder Plan

1. Add new promotion module
2. Read `market-scanner-state.json`, `spark-fireplans.json`, and manual overrides
3. Build deterministic rule objects
4. Merge into `oracle-watch-rules.json`
5. Seed `oracle-watch-state.json`
6. Log promotion decisions
7. Add tests for:
   - urgent short without shared-short-regime activation
   - spark fireplan conversion
   - manual override beats bullish mechanical read
   - stale source retires rule

## Why The CHIP/MEGA Read Missed

The specific logic error was:

- negative funding and rising OI were treated as squeeze-fuel long inputs
- immediate dump tape was not given higher priority
- the system had no direct auto-short path for urgent promoted names outside the shared short regime

So the analysis mistake and the pipeline mistake reinforced each other:

- the read was too willing to interpret "crowded" as "bullish squeeze setup"
- the automation had no independent way to arm the obvious short even after the tape proved it
