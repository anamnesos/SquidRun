# Hyperliquid-Native Data Layer Spec

Checked/researched on **April 5, 2026**.

## Goal
Close the gap between "we scan Hyperliquid" and "we actually use Hyperliquid-native edge." The live system already uses `metaAndAssetCtxs`, current funding, predicted funding inside the mech board, and 4h/24h mover logic. It still does **not** have a first-class native layer for:

- tracked vault behavior,
- persistent predicted-funding dislocations,
- top-candidate L2 book state,
- multi-timeframe confirmation that is explicit and reusable.

This spec is designed for Builder to wire in immediately without waiting for another architecture pass.

## What Exists Already

### Real

- `ui/modules/trading/hyperliquid-client.js`
  - wraps `allMids`, `metaAndAssetCtxs`, account state, candles, and positions.
- `ui/modules/trading/crypto-mech-board.js`
  - already calls `client.predictedFundings()` directly and uses current funding + predicted funding + local OI history.
- `ui/modules/trading/market-scanner.js`
  - keeps a local rolling history of price / OI / funding and flags 4h and 24h movers.
- `ui/modules/trading/orchestrator.js`
  - already has a natural insertion point inside `runConsensusRound()` for extra per-symbol feature blocks and candidate snapshot logging.

### Missing

- No reusable wrapper in `hyperliquid-client.js` for predicted funding.
- No reusable wrapper for `l2Book`.
- No vault-tracking module or state file.
- No native feature bundle that can be passed through scanner -> mech board -> consultation -> execution report.
- Current 1h/4h/daily alignment lives mostly inside `signal-producer.js` as a scoring heuristic, not as a transparent confirmation object with veto / downgrade semantics.

## Hyperliquid-Native Edge We Should Use

The official Hyperliquid docs expose the pieces we need:

- `predictedFundings`
  - useful for funding drift and crowding inflection before the current funding print fully catches up.
- `l2Book`
  - returns up to 20 levels per side, enough for top-candidate imbalance, spread, and near-touch depth analysis.
- vault info endpoints
  - the info endpoint exposes vault details and user vault equity flows.
- `metaAndAssetCtxs`
  - still the backbone for mark, open interest, premium, impact prices, and 24h volume.

The edge is not "predict the whole market from one feed." It is:

1. Use the full universe scanner to find candidate names.
2. Use predicted funding + OI expansion to identify crowding stress.
3. Use L2 state to decide whether the move is still structurally weak/strong or already exhausted.
4. Use tracked vault behavior as a higher-conviction overlay for a small allowlist of serious vaults, not as a universal signal.

## Implementation Shape

### 1. Extend `hyperliquid-client.js`

Add reusable wrappers:

- `getPredictedFundings(options = {})`
- `getL2Book({ coin, nSigFigs = null, mantissa = null, ...options })`
- `getVaultDetails({ address, ...options })`
- `getUserVaultEquities({ user, ...options })`

Reason:

- `crypto-mech-board.js` is already using predicted funding, but via direct raw client calls.
- Builder needs these as stable shared helpers so scanner, mech board, validation, and reporting all read the same shape.

Recommended return normalization:

```js
{
  asOf: "2026-04-05T21:30:00.000Z",
  byCoin: {
    BTC: {
      venue: "HlPerp",
      fundingRate: -0.000041,
      nextFundingTime: "2026-04-05T22:00:00.000Z"
    }
  }
}
```

For L2:

```js
{
  coin: "BTC",
  asOf: "2026-04-05T21:30:00.000Z",
  spreadPct: 0.00018,
  bestBid: 83124.5,
  bestAsk: 83139.5,
  top5BidUsd: 1845220,
  top5AskUsd: 2610040,
  top10BidUsd: 3911032,
  top10AskUsd: 5222091,
  depthImbalanceTop5: -0.171,
  depthImbalanceTop10: -0.144,
  nearTouchSkew: "ask_heavy",
  raw: { levels: [...] }
}
```

### 2. Add `ui/modules/trading/hyperliquid-native-layer.js`

This should be the composable feature layer, not another monolith in `orchestrator.js`.

Responsibilities:

- consume ranked candidate symbols,
- fetch predicted funding snapshots,
- fetch L2 snapshots only for top candidates,
- enrich from tracked vaults,
- emit a normalized `nativeSignals` block by symbol.

Recommended public functions:

- `buildNativeFeatureBundle({ symbols, candidateRank, trackedVaults, snapshots, marketData, now, ...options })`
- `recordNativeFeatureSnapshot(bundle, options = {})`
- `loadNativeFeatureState(options = {})`

Recommended runtime state:

- `.squidrun/runtime/hyperliquid-native-state.json`

Fields:

- recent per-symbol predicted-funding drift history,
- recent L2 imbalance snapshots for consulted names,
- vault activity summaries,
- last successful fetch timestamps,
- degraded-source flags.

### 3. Add `ui/modules/trading/hyperliquid-vault-tracker.js`

Do **not** track every vault on day one. That is fake breadth.

Start with a configured allowlist:

- `SQUIDRUN_HYPERLIQUID_TRACKED_VAULTS`
- or `workspace/knowledge/tracked-hyperliquid-vaults.json`

Per tracked vault, persist:

- vault address
- leader address
- last account value
- last 24h/7d equity delta
- last flow direction
- touched symbols if inferable from fills / public behavior
- confidence grade

Signal design:

- Vault increase + same-symbol crowding/funding stress + weak L2 -> bearish continuation candidate.
- Vault increase + improving L2 + positive drift in a strong name -> supportive long context.
- No symbol inference -> informational only, not directional.

Important honesty rule:

- If symbol attribution is indirect, mark it `informational`.
- Do not fabricate vault-to-symbol precision we do not have.

## Multi-Timeframe Confirmation

### The current problem

`signal-producer.js` already computes 1h/4h/daily trend alignment, but it is still mostly a score contribution. That is too opaque for live execution review.

We need a reusable object that says:

- what each timeframe is doing,
- whether the setup is aligned,
- whether the lower timeframe is fighting the higher timeframe,
- whether the system should allow, downsize, or block the trade.

### Add `ui/modules/trading/multi-timeframe-confirmation.js`

Recommended output:

```js
{
  ticker: "AVAX/USD",
  asOf: "2026-04-05T21:30:00.000Z",
  bias1h: -1,
  bias4h: -1,
  bias1d: -1,
  strength1h: 0.62,
  strength4h: 0.71,
  strength1d: 0.58,
  aligned: true,
  regime: "full_bear_alignment",
  status: "confirm",
  sizeMultiplier: 1,
  reasons: [
    "1h, 4h, and 1d all slope lower",
    "4h move is confirmed by daily trend",
    "lower timeframe is not squeezing against higher timeframe"
  ]
}
```

Statuses:

- `confirm`
- `downgrade`
- `block`

Rules:

### Longs

- `confirm`
  - 4h and 1d both positive, 1h not strongly negative.
- `downgrade`
  - 4h positive but 1d flat, or 1h is fading against 4h.
- `block`
  - 1d negative and 4h only weakly positive, or L2 is strongly ask-heavy into a proposed long.

### Shorts

- `confirm`
  - 4h and 1d both negative, 1h not strongly positive.
- `downgrade`
  - 4h negative but 1d flat, or 1h is rebounding sharply against the move.
- `block`
  - 1d positive and 4h only weakly negative, or L2 is strongly bid-heavy into a proposed short.

### Additional native overlays

Let native overlays modify but not fully replace MTF:

- predicted funding diverging further in direction of trade: `+0.10` confidence cap boost
- crowding / cascade stress high but L2 absorption against trade: force `downgrade`
- vault flow against trade: cap status at `downgrade`

## Exact Builder Hooks

### `ui/modules/trading/hyperliquid-client.js`

Add wrappers and exports:

- `getPredictedFundings`
- `getL2Book`
- `getVaultDetails`
- `getUserVaultEquities`

### `ui/modules/trading/orchestrator.js`

Inside `runConsensusRound()`:

1. After `mechanicalBoard` is built, compute candidate ranking from:
   - selected trades,
   - flagged movers,
   - consulted symbols.
2. Call `buildNativeFeatureBundle()` for the top candidates only.
3. Call `buildMultiTimeframeConfirmation()` per consulted crypto symbol.
4. Attach both outputs to:
   - consultation payload,
   - candidate feature snapshots,
   - durable execution report payloads.

Add fields to `candidateFeatureRecords`:

- `native.predictedFundingRate`
- `native.predictedFundingDriftBps`
- `native.l2SpreadPct`
- `native.depthImbalanceTop5`
- `native.depthImbalanceTop10`
- `native.vaultSignal`
- `mtf.status`
- `mtf.regime`
- `mtf.sizeMultiplier`

### `ui/modules/trading/market-scanner.js`

Keep it cheap:

- continue scanning the full universe with price/OI/funding.
- only trigger native deep fetches for:
  - top `N` flagged movers,
  - executable candidates,
  - open-position symbols.

Recommended `N`: `8` to `15`.

### `ui/modules/trading/crypto-mech-board.js`

Do not delete the current mech board. Extend it.

Add optional merge-in fields from native layer:

- `predictedFundingDriftBps`
- `l2DepthImbalance`
- `l2SpreadPct`
- `vaultSignal`
- `mtfStatus`

Then tighten `tradeFlag`:

- `trade`
  - requires directional stress plus `mtf.status !== "block"`
- `watch`
  - when stress is high but L2/MTF contradicts

## Minimum Viable Rollout

### Phase 1

- wrap predicted funding and L2 in `hyperliquid-client.js`
- create `multi-timeframe-confirmation.js`
- enrich candidate snapshots and supervisor status

### Phase 2

- add tracked vault allowlist
- persist vault state and L2 history
- feed native bundle into execution reports

### Phase 3

- websocket L2 streaming for only active candidates / open positions
- decay-aware native feature scoring

## Promise Gap To Avoid

Do not say "Hyperliquid-native intelligence" if all we really mean is:

- one predicted funding snapshot,
- no L2,
- no vault tracking,
- and hidden 1h/4h/daily heuristics.

The honest threshold for claiming Hyperliquid-native edge is:

1. predicted funding is explicit and persisted,
2. L2 is captured for actual candidates,
3. multi-timeframe confirmation is visible in reports,
4. vault tracking exists for a real allowlist,
5. execution reports show which of those features were present at decision time.

## Sources

- Hyperliquid official docs: info endpoint, L2 book snapshot, vault endpoints, predicted funding support
- Repo code:
  - `ui/modules/trading/hyperliquid-client.js`
  - `ui/modules/trading/crypto-mech-board.js`
  - `ui/modules/trading/market-scanner.js`
  - `ui/modules/trading/orchestrator.js`
  - `ui/modules/trading/signal-producer.js`
