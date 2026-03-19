# Unified Trading Architecture — v2

## Problem

The current system has 3 isolated trading subsystems (stocks, crypto, Polymarket) that don't share portfolio state, risk views, or learning. Adding smart money tracking, launch radar, and yield routing as more silos will make this worse. We need a unified architecture before building more.

## Design Principles

1. **One portfolio, one risk view** — All markets feed into a single portfolio tracker. Kill switch sees everything.
2. **Dynamic watchlist** — Smart money engine and launch radar can ADD tickers dynamically. No hardcoding.
3. **Agent attribution** — Track which agent is right most often. Weight their votes accordingly over time.
4. **Signal pipeline** — All signal sources (momentum, news, smart money, launch radar) feed into the same consensus engine.
5. **Capital allocation** — Yield router manages idle capital. Trading engine requests capital when needed.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    SUPERVISOR DAEMON                         │
│  (orchestrates all subsystems on schedule)                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ SIGNAL       │  │ SMART MONEY  │  │ LAUNCH RADAR      │  │
│  │ SOURCES      │  │ ENGINE       │  │ (new tokens)      │  │
│  │              │  │              │  │                   │  │
│  │ • momentum   │  │ • whale track│  │ • pump.fun watch  │  │
│  │ • news/sent. │  │ • wallet PnL │  │ • rug audit       │  │
│  │ • volume     │  │ • flow diverg│  │ • viral detection  │  │
│  │ • governance │  │ • convergence│  │ • security check   │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬──────────┘  │
│         │                 │                    │             │
│         └────────┬────────┴────────────────────┘             │
│                  ▼                                           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │            UNIFIED SIGNAL AGGREGATOR                 │    │
│  │  Merges all signal sources per ticker/market         │    │
│  │  Feeds enriched context to 3-agent consensus         │    │
│  └──────────────────────┬──────────────────────────────┘    │
│                         ▼                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │         3-AGENT ADVERSARIAL CONSENSUS                │    │
│  │  Claude (skeptic) + GPT (speed) + Gemini (breadth)  │    │
│  │  2-of-3 required. Agent attribution tracked.         │    │
│  └──────────────────────┬──────────────────────────────┘    │
│                         ▼                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           UNIFIED RISK ENGINE                        │    │
│  │  Single portfolio view across ALL markets            │    │
│  │  • Total equity = stocks + crypto + Polymarket + DeFi│    │
│  │  • Kill switch sees everything                       │    │
│  │  • Per-market allocation limits                      │    │
│  └──────────────────────┬──────────────────────────────┘    │
│                         ▼                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │          CAPITAL ALLOCATOR                           │    │
│  │  • Requests capital from yield router when trading   │    │
│  │  • Returns idle capital to yield after trades close  │    │
│  │  • Allocation: 40% active trading, 30% yield,       │    │
│  │    20% reserve, 10% launch radar (high risk)         │    │
│  └──────────────────────┬──────────────────────────────┘    │
│                         ▼                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │          MULTI-BROKER EXECUTOR                       │    │
│  │  Routes to correct broker per asset:                 │    │
│  │  • Alpaca → US stocks, crypto                       │    │
│  │  • IBKR → Asian/global stocks (when approved)       │    │
│  │  • Polymarket CLOB → prediction markets             │    │
│  │  • DEX (Jupiter/Raydium) → Solana tokens (new)      │    │
│  │  • DeFi (Aave/Morpho) → yield deposits              │    │
│  └──────────────────────┬──────────────────────────────┘    │
│                         ▼                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │          UNIFIED JOURNAL + ATTRIBUTION               │    │
│  │  • All trades logged to single SQLite DB             │    │
│  │  • Per-agent win/loss tracking                       │    │
│  │  • Cross-market P&L                                  │    │
│  │  • Dissent analysis (who was right when they disagreed)│  │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │          YIELD ROUTER (idle capital)                  │    │
│  │  • Parks unused USDC in Aave/Morpho vaults           │    │
│  │  • Auto-withdraws when trading engine needs capital   │    │
│  │  • 3-agent debate on protocol risk before depositing  │    │
│  │  • Keep 30-40% instantly deployable                   │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## New Modules to Build

### 1. portfolio-tracker.js (CRITICAL — build first)
Unified view of ALL capital across all markets.
```
getPortfolioSnapshot() → {
  totalEquity: 662,        // sum of everything
  markets: {
    alpaca_stocks: { equity: 100000, positions: [...], pnl: 0 },
    alpaca_crypto: { equity: 0, positions: [], pnl: 0 },
    polymarket: { equity: 162, positions: [], pnl: 0 },
    defi_yield: { equity: 0, deposits: [], apy: 0 },
    solana_tokens: { equity: 0, positions: [], pnl: 0 },
  },
  risk: {
    totalDrawdownPct: 0,
    killSwitchTriggered: false,
    dailyLossPct: 0,
  }
}
```

### 2. dynamic-watchlist.js (replaces hardcoded watchlist)
Allows smart money engine and launch radar to add/remove tickers.
```
addTicker(ticker, { source, assetClass, broker, reason, expiry })
removeTicker(ticker)
getTickers({ assetClass, source })
getActiveTickers()  // includes both static + dynamic entries
```
Tickers added by smart money or launch radar have an expiry (auto-remove after N days if no trades).

### 3. wallet-tracker.js (Smart Money Engine — part 1)
Monitors profitable wallets on Solana and Ethereum.
```
trackWallet(address, { chain, label, pnlScore })
getTrackedWallets()
getRecentMoves({ chain, minValue })  // returns recent buys/sells by tracked wallets
getConvergenceSignals()  // multiple wallets buying same token
```
Data sources: Helius webhooks (Solana), Birdeye Smart Money API, Etherscan/Alchemy (Ethereum).

### 4. smart-money-scorer.js (Smart Money Engine — part 2)
Scores wallet quality and signal strength.
```
scoreWallet(address) → { pnl30d, winRate, avgHoldTime, riskScore }
scoreConvergence(token, wallets) → { strength, walletCount, avgPnl, confidence }
```

### 5. launch-radar.js (New Token Detection)
Monitors new token launches on Solana (pump.fun, Raydium) and Base.
```
scanNewLaunches({ chain })  // returns tokens launched in last N minutes
evaluateToken(token) → { viralScore, rugRisk, liquidityDepth, holderConcentration }
```
Data sources: Birdeye new listing API, GoPlus security API.

### 6. token-risk-audit.js (Anti-Rug Filter)
Security analysis before touching any new token.
```
auditToken(address, chain) → {
  safe: boolean,
  risks: ['honeypot', 'concentrated_holders', 'no_liquidity_lock', ...],
  goplus: { ... },  // raw GoPlus security data
  recommendation: 'proceed' | 'caution' | 'avoid'
}
```

### 7. yield-router.js (Idle Capital Management)
Parks unused USDC in safe yield venues.
```
getAvailableVenues() → [{ protocol, apy, tvl, riskScore }, ...]
deposit(venue, amount)
withdraw(venue, amount)
getDeposits() → [{ venue, amount, apy, depositedAt }, ...]
requestCapital(amount) → withdraws from lowest-yield venue first
returnCapital(amount) → deposits to highest-yield venue
```

### 8. agent-attribution.js (Performance Tracking)
Tracks per-agent accuracy over time.
```
recordPrediction(agentId, ticker, direction, confidence, timestamp)
recordOutcome(ticker, direction, actualReturn, timestamp)
getAgentStats(agentId) → { winRate, avgReturn, calledCorrectly, totalPredictions }
getLeaderboard() → ranked agents by performance
```
Future: dynamically weight agent votes based on track record.

## Refactoring Required

### risk-engine.js updates
- Accept portfolio-tracker snapshot instead of just Alpaca account
- Kill switch checks total equity across all markets
- Per-market allocation limits (e.g., max 20% in launch radar tokens)

### executor.js updates
- Add DEX execution path (Jupiter SDK for Solana)
- Route new-launch tokens to DEX executor
- Route yield deposits to DeFi protocols

### consensus.js updates
- Accept enriched signal context (smart money data, launch radar scores)
- Log agent attribution data after trade outcomes known

### journal.js updates
- Add market_type column to trades table
- Add agent_attribution table
- Cross-market daily summary

## Build Order

1. **portfolio-tracker.js** — unified portfolio view (everything else depends on this)
2. **dynamic-watchlist.js** — replace hardcoded watchlist
3. **agent-attribution.js** — start tracking agent performance immediately
4. **wallet-tracker.js + smart-money-scorer.js** — smart money engine
5. **launch-radar.js + token-risk-audit.js** — new token detection
6. **yield-router.js** — idle capital management
7. Risk engine + executor + consensus refactoring to tie it all together

## Oracle Review Feedback (Incorporated)

### Capital Allocation (revised)
- 40% active trading
- 35% yield router (was 30%)
- 20% reserve
- 5% launch radar (was 10% — Oracle flagged rug rate too high for 10%)

### Agent Vote Weighting
- MUST be asset-class specific, not global
- If Oracle is 70% accurate on US stocks but Builder is better on Solana launches, weights differ per market
- Prevents diluting specialized alpha

### Additional Data Sources Needed
- **Snapshot API / Boardroom** — governance voting + execution payloads (governance arbitrage)
- **LunarCrush / DexScreener social metrics** — social sentiment velocity for launch radar
- **MEV protection data** — avoid sandwich attacks on DEX trades (Jupiter already has Jito bundle support)

### Portfolio Tracker Requirements (Oracle additions)
- Must distinguish **liquid capital** vs **locked capital** (DeFi vaults with lockups)
- Locked capital CANNOT count as available for kill switch or active trading
- Gas/slippage accounting for yield↔active capital transitions
- Round-trip cost must be less than expected yield

## API Keys Needed

- **Helius** (Solana RPC + webhooks) — free tier: 100K credits/day
- **Birdeye** (Smart Money API) — free tier: 50 requests/min
- **GoPlus** (Token security) — free tier: 30 calls/min
- **Jupiter** (Solana DEX routing) — free, no key needed
- **Alchemy or Infura** (Ethereum RPC) — free tier: 300M compute units
- **Snapshot** (Governance) — free GraphQL API
- **LunarCrush** (Social sentiment) — free tier available

James already has: Alpaca, IBKR (pending), Polymarket, Rabby wallet.
