# Crypto Trading Research Memo

Checked/researched on **April 5, 2026**.

## Scope

This memo answers four live questions:

1. What the better crypto trading systems actually use now.
2. What edge is specific to Hyperliquid.
3. How SquidRun should validate whether its signals predict anything real.
4. What leading open-source bots/frameworks do that SquidRun still lacks.

This is written to drive immediate implementation, not to sound sophisticated.

## 1. What Better Crypto Systems Actually Use

The pattern is not "one magic model." The better systems stack three layers:

### A. Broad candidate discovery

- full-universe scanning, not a tiny fixed basket,
- fast price/OI/funding filters,
- event and narrative tagging,
- dynamic promotion into a smaller decision set.

This is exactly where SquidRun used to fail. The crisis study already proved the promise gap: the best missed Hyperliquid crisis shorts were outside the old six-name basket.

### B. Microstructure confirmation

The stronger systems use some combination of:

- order book imbalance,
- trade-flow imbalance / public trades,
- funding dislocations,
- OI expansion or collapse,
- liquidation risk / squeeze risk,
- regime-aware sizing instead of raw signal flipping.

Evidence from current open-source tooling:

- Freqtrade now documents official orderflow support using public trades, footprint-style data, imbalances, bid/ask delta, and lookahead-analysis to catch fake backtests.
- Hummingbot’s current v2 architecture explicitly separates controllers from executors and feeds them market data such as candles, order books, and trades.

That is a useful benchmark. Serious systems are pulling richer market structure than plain candles.

### C. Deterministic execution and post-trade attribution

The better systems do not stop at "we got a signal."

They track:

- what feature state existed at entry,
- whether the trade was blocked or downsized by risk rules,
- what the market did after the signal,
- what fees/slippage/funding did to expectancy,
- which signals should be trusted less over time.

This is where SquidRun is improving now with candidate snapshot logging and execution reporting, but it is still early.

## 2. Hyperliquid-Specific Edge

Hyperliquid is useful because it exposes a cleaner native surface than many venues for:

- full perp-universe metadata via `metaAndAssetCtxs`,
- current funding and open interest context,
- predicted funding,
- L2 snapshots,
- vault data,
- strong real-time API / websocket usage patterns.

### Best venue-specific opportunities

#### Predicted funding drift

This is one of the more useful native edges because it helps identify:

- crowding that is still building,
- one-sided positioning before the next funding print,
- cases where current funding understates where the book is leaning.

Recommendation:

- track `current funding`, `predicted funding`, and `drift = predicted - current`.
- alert when drift is large *and* OI is expanding in the same direction.

#### OI spike plus price weakness

This is already part of SquidRun’s improved crisis analysis and should remain core.

Recommendation:

- treat OI expansion into a down move as a continuation candidate,
- but require either L2 weakness or funding/crowding confirmation before auto-execution.

#### L2 imbalance for top candidates

Hyperliquid’s L2 snapshot is not a full tape replacement, but it is enough for:

- spread quality,
- near-touch depth imbalance,
- whether the move is being absorbed,
- whether a weak continuation setup is already turning into a squeeze trap.

Recommendation:

- only fetch L2 for top candidates and open positions,
- compute top-5 and top-10 depth imbalance and near-touch skew,
- use it as a final confirmer/downgrader, not the first-stage scanner.

#### Tracked vault behavior

Vault data is interesting, but only if handled honestly.

The edge is not "vaults predict everything." The edge is:

- track a small allowlist of serious vaults,
- detect meaningful equity/flow changes,
- use them as conviction overlays or caution flags,
- never pretend we have perfect per-symbol attribution when we do not.

## 3. Signal Validation Framework

SquidRun should stop asking only "did we make money?" and ask:

1. Did the signal predict the right direction better than chance?
2. Did it predict enough edge to survive costs?
3. Did the execution layer keep the realized result close enough to the gross forecast?

### A. Record the right unit of analysis

Every candidate, not just every executed trade.

For each candidate snapshot:

- timestamp
- symbol
- decision
- confidence
- consulted vs ignored vs executed
- 4h / 24h / 72h forward returns
- max adverse excursion
- max favorable excursion
- fees/slippage/funding assumptions
- macro regime
- event-veto state
- MTF status
- native feature state

If ignored names are not stored, selection bias will keep flattering the system.

### B. Minimum tests

#### Directional hit rate

- `BUY`: percentage of forward returns above zero
- `SELL`: percentage of forward short returns above zero
- compare against naive baselines:
  - always hold,
  - always short flagged movers,
  - top-N pure price-move ranker

#### Expectancy

- gross expectancy per signal
- net expectancy after estimated fees, slippage, and funding
- headline metric should be net, not gross

#### Calibration

- bin signals by confidence: `0.50-0.59`, `0.60-0.69`, etc.
- check whether higher confidence actually maps to higher realized hit rate / expectancy

#### Regime segmentation

Evaluate separately by:

- macro regime color,
- event-veto state,
- majors vs non-majors,
- immediate mini-consults vs slower 24h promotions.

#### Bias checks

Borrow the Freqtrade lesson here:

- run explicit lookahead checks,
- never merge higher-timeframe data in a way that leaks future closes,
- keep live and replay feature availability honest.

### C. Statistical thresholds

Recommended early thresholds:

- exploratory read: `n >= 100` candidates per slice
- stronger directional read: `n >= 300`
- stronger net-expectancy read: `n >= 500`

Do not trust tiny-sample hero runs.

### D. Practical viability after costs

Exact thresholds vary by holding time and turnover, but a reasonable live floor is:

- directional hit rate alone is not enough,
- a high-turnover futures strategy usually needs clearly positive **net** expectancy after:
  - entry/exit fees,
  - slippage,
  - funding costs when held across funding windows,
  - a bad-run buffer.

Practical rule:

- if net expectancy is not still positive under a pessimistic cost band, it is not live-grade.

## 4. Competitive Analysis

## Freqtrade

What it does well:

- informative pairs / multi-timeframe merges with explicit anti-lookahead guidance,
- official orderflow analysis with public trades, imbalances, delta,
- lookahead-analysis tooling,
- pairlist / dynamic universe tooling,
- ML/FreqAI lane, with its own caveats.

What SquidRun should learn:

- make multi-timeframe logic explicit and auditable,
- add bias-detection habits,
- treat orderflow as a first-class feature where available,
- keep candidate-universe handling visible, not hidden.

## Hummingbot

What it does well:

- clear separation between controllers and executors,
- controllers consume structured market data,
- executors manage lifecycle deterministically,
- good architecture for directional, DCA, arbitrage, TWAP, and LP execution flows.

What SquidRun should learn:

- preserve the agent/reasoning layer, but keep execution deterministic,
- split "generate idea" from "manage trade lifecycle",
- make single-trade execution modules self-contained and inspectable.

## Jesse

Jesse remains more of a strategy-development framework than a live multi-agent decision system. The relevant lesson is not a specific indicator. It is that traders value:

- strict route definitions,
- repeatable backtesting,
- clear strategy boundaries,
- and fast iteration on a defined strategy instead of one giant mixed logic pile.

What SquidRun should learn:

- define the live trading routes more explicitly:
  - scanner,
  - consultation,
  - sizing,
  - execution,
  - settlement,
  - attribution.

## Biggest Gaps vs Better Systems

1. SquidRun only recently fixed the hidden consultation-breadth gap.
2. It still lacks native L2 and vault features as first-class persisted signals.
3. Its MTF logic is real but not visible enough.
4. Replay evidence is improving, but execution-cost realism is still catching up.
5. There is still more feature logging than true feature pruning / calibration.

## Immediate Recommendations For Builder

### Ship now

- add a Hyperliquid-native bundle with:
  - predicted funding drift,
  - L2 depth imbalance,
  - tracked vault overlays.
- add cross-venue funding spread using Hyperliquid's official `predictedFundings` payload, which already includes `HlPerp`, `BinPerp`, and `BybitPerp` for the same coin.
- make MTF confirmation produce `confirm`, `downgrade`, `block`.
- persist candidate outcomes for ignored names as well as executed ones.
- show gross and net expectancy separately in every replay artifact.

### Next

- add feature calibration reports by regime and by symbol bucket,
- measure whether predicted funding drift actually adds incremental edge beyond price/OI/funding,
- prune dead features instead of accumulating impressive-looking dashboards.

## Hard Truth

The trading system gets better when it becomes more honest, not more ornate.

The right direction is:

- wider real breadth,
- richer native market structure on the shortlisted names,
- explicit MTF confirmation,
- net-cost validation,
- and continuous pruning of features that do not improve predictive power.

Anything else is decorative complexity.

## Addendum: Official Hyperliquid Findings From April 5, 2026

These were checked directly against the official `https://api.hyperliquid.xyz/info` surface and current normalized client wrappers.

### Strongest live ship-first edge

Cross-venue funding divergence is stronger than raw Hyperliquid funding alone because the official `predictedFundings` response already exposes Hyperliquid, Binance, and Bybit predictions for the same coin.

Examples from the live pull:

- `ZETA`: `HlPerp -15.8bps` vs `Bybit -89.0bps` and `Binance -52.0bps`
- `MOODENG`: `HlPerp -4.7bps` vs `Bybit -31.4bps` and `Binance -19.5bps`
- `ALT`: `HlPerp -3.0bps` vs `Bybit -20.2bps`
- `TURBO`: `HlPerp -1.27bps` vs `Binance -9.61bps`
- `FTT`: `HlPerp -12.7bps` while Binance and Bybit were effectively `0bps`

This should be promoted into the native bundle as `crossVenueFundingSpreadBps`, not left as a side note.

### Crowding is real, but timing still needs L2

Current crowding extremes from the live universe snapshot included:

- `TURBO` `OI/24h volume ~3227x`
- `GRIFFAIN` `~2078x`
- `ALT` `~1407x`
- `XAI` `~2578x`

That is useful, but it is not enough by itself because the order book changes execution quality:

- `ALT` and `WLD` were ask-heavy near the touch
- `GRIFFAIN`, `ZETA`, and `MOODENG` were bid-heavy near the touch

That means some bearish-looking names are still poor late shorts and should be downgraded or timed, not mechanically sold.

### Open-interest-cap is not ready as a first production feature

The official `perpsAtOpenInterestCap` endpoint currently returned:

- `CANTO`
- `FTM`
- `JELLY`
- `LOOM`
- `RLB`

But those names did not map cleanly into the current normalized main-universe market data and came back with zero-liquidity / empty-L2 on our side. This looks more like a mapping or alternate-dex problem than a ready-to-trade ranker input.

### Vault-copy remains unresolved

Official docs clearly expose `vaultDetails` and `userVaultEquities`, and the app bundle references `perpDexStates[0].leadingVaults`, but direct `vaultSummaries` queries currently return an empty array. Until a stable official leaderboard source is confirmed, vault-copy should stay behind funding/L2 work in the build order.

### Liquidation-cascade edge should be built as inference, not fiction

Official docs make two things clear:

- liquidations use the mark price, which combines external CEX prices with Hyperliquid book state,
- the public websocket surface gives us `WsBook`, `WsTrade`, and `allDexsAssetCtxs`, while explicit liquidation details are primarily user-scoped in `WsUserEvent` / `WsFill`.

That means the public production lane should infer cascades from:

- sudden open-interest drops,
- widening spread or thinning top-of-book depth,
- persistent ask-heavy order book imbalance,
- aggressive sell-trade bursts,
- and mark/oracle stress.

It should not pretend we have a venue-wide public liquidation tape when we do not.

## Sources

- Hyperliquid official docs: info endpoint, L2 book snapshot, vault endpoints
- Freqtrade official docs:
  - orderflow
  - strategy customization / informative pairs
  - lookahead-analysis
- Hummingbot official docs:
  - controllers
  - executors
  - Hummingbot API / Condor architecture
