# Polymarket Trading Module — Design Spec

## Overview

Prediction market trading via Polymarket CLOB API. Uses the same adversarial 3-model consensus pattern as stock/crypto trading. USDC.e on Polygon is the settlement currency. James has $162 USDC in a Rabby wallet (Chrome extension on VIGIL).

## Architecture

```
polymarket-client.js    — API wrapper (auth, markets, orders, positions)
polymarket-scanner.js   — Market discovery + filtering (find high-edge markets)
polymarket-signals.js   — Signal producer (probability assessment per agent)
polymarket-sizer.js     — Kelly criterion position sizing
```

All modules live in `ui/modules/trading/`.

## Module 1: polymarket-client.js

Wraps `@polymarket/clob-client` (v5.8.0). Handles:

- **Authentication**: L1 wallet signing → L2 API key derivation (HMAC-SHA256)
- **Market data**: Fetch active markets, order books, prices
- **Order management**: Create/cancel GTC orders
- **Positions**: Get open positions, P&L tracking
- **Balance**: USDC.e balance on Polygon

### Config (from .env)
```
POLYMARKET_PRIVATE_KEY=    # Rabby wallet private key (exported from Chrome extension)
POLYMARKET_FUNDER_ADDRESS= # Wallet address on Polygon
```

### Signature Type
Use `SignatureType.EOA` (type 0) since James uses Rabby (standard EOA wallet).

### Key Methods
```js
connect()                          // Initialize client, derive API key
disconnect()                       // Cleanup
getBalance()                       // USDC.e balance
getMarkets(filters)                // Active markets with volume/liquidity filters
getMarketBook(tokenId)             // Order book for a specific outcome
getPrice(tokenId)                  // Current best price
createOrder(tokenId, side, price, size)  // Place GTC order
cancelOrder(orderId)               // Cancel open order
getOpenOrders()                    // List open orders
getPositions()                     // Current positions with P&L
```

### Dependencies
```
@polymarket/clob-client@^5.8.0
ethers@^5  (peer dep of clob-client)
```

## Module 2: polymarket-scanner.js

Scans active markets and identifies high-edge opportunities. This is the prediction market equivalent of the stock watchlist.

### Filtering Criteria
- **Liquidity**: Min $10K volume, reasonable spread
- **Time horizon**: Resolution within 1-90 days (swing trading, not long-dated)
- **Category**: Politics, crypto, finance, sports, world events
- **Edge detection**: Markets where our consensus probability diverges >10% from market price

### Key Methods
```js
scanMarkets(options)               // Fetch + filter active markets
rankByEdge(markets, agentProbabilities)  // Sort by expected value
getMarketContext(market)           // Summary for agent consumption (question, current price, volume, resolution date)
```

### Output Format
```js
{
  conditionId: "0x...",
  question: "Will X happen by Y?",
  outcomes: ["Yes", "No"],
  tokens: { yes: "0x...", no: "0x..." },
  currentPrices: { yes: 0.62, no: 0.38 },
  volume24h: 45000,
  liquidity: 120000,
  resolutionDate: "2026-04-15T00:00:00Z",
  category: "politics",
}
```

## Module 3: polymarket-signals.js

Each agent independently assesses probability for scanned markets. Same pattern as stock signal producer but output is a probability estimate instead of BUY/SELL/HOLD.

### Agent Assessment Flow
1. Scanner provides market context (question, current price, resolution date)
2. Each agent produces: `{ marketId, probability, confidence, reasoning }`
3. Consensus: average probabilities, check divergence from market price
4. If consensus probability > market price + edge threshold → BUY YES
5. If consensus probability < market price - edge threshold → BUY NO (equivalent to selling YES)

### Key Methods
```js
assessMarket(agentId, marketContext)     // Single agent probability assessment
produceSignals(markets, options)         // Batch assessment across all agents
buildConsensus(agentSignals)             // Aggregate 3-agent probabilities
```

### Edge Threshold
- Minimum edge: 10% (consensus prob must diverge from market by ≥0.10)
- Confidence-weighted: higher agent confidence → lower edge threshold allowed

## Module 4: polymarket-sizer.js

Kelly criterion position sizing. Critical for bankroll management with $162 starting capital.

### Kelly Formula
```
f* = (bp - q) / b
where:
  b = net odds (payout ratio)
  p = estimated probability of winning
  q = 1 - p (probability of losing)
  f* = fraction of bankroll to wager
```

### Constraints
- **Half-Kelly**: Use f*/2 for conservative sizing (reduces variance)
- **Max position**: 15% of bankroll per market
- **Min bet**: $1 (Polymarket minimum)
- **Max concurrent positions**: 5
- **Stop loss**: Exit if market moves >20% against position

### Key Methods
```js
kellyFraction(probability, marketPrice)  // Raw Kelly sizing
positionSize(bankroll, probability, marketPrice, options)  // Constrained sizing
shouldExit(position, currentPrice)       // Stop loss check
```

## Supervisor Integration

Add to `supervisor-daemon.js`:

### Schedule
- **Scan interval**: Every 4 hours (markets move slowly)
- **Position check**: Every 30 minutes (monitor open positions for stop-loss)

### Phases
```js
const POLYMARKET_PHASES = [
  { key: 'polymarket_scan', label: 'Polymarket market scan' },
  { key: 'polymarket_consensus', label: 'Polymarket consensus round' },
  { key: 'polymarket_execute', label: 'Polymarket order execution' },
  { key: 'polymarket_monitor', label: 'Polymarket position monitor' },
];
```

### State File
`runtime/polymarket-trading-state.json` — same pattern as crypto trading state.

## Risk Controls

- **Max total exposure**: 80% of bankroll (keep 20% reserve)
- **Max single market**: 15% of bankroll
- **Correlation check**: Don't bet both sides of correlated markets
- **Resolution tracking**: Auto-close positions approaching resolution with poor odds
- **Daily loss limit**: 25% of bankroll → pause trading

## Implementation Order

1. `polymarket-client.js` — API wrapper + auth (needs POLYMARKET_PRIVATE_KEY in .env)
2. `polymarket-scanner.js` — Market discovery
3. `polymarket-signals.js` — Agent probability assessment
4. `polymarket-sizer.js` — Kelly criterion sizing
5. Supervisor integration — 4-hour scan cycle
6. Wire into orchestrator consensus flow

## Notes

- Start in **dry-run mode** (log orders but don't execute) until we verify signal quality
- Polymarket uses USDC.e on Polygon — James's Rabby wallet already has $162 USDC
- Tick sizes vary by market (0.01 most common) — must fetch per-market
- Rate limits are generous (500 orders/10s) — not a concern
- `negRisk: true` required for multi-outcome markets (most political markets)
