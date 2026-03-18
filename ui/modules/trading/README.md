# Trading Module

Autonomous multi-model swing trading system.

## Architecture

See `workspace/specs/trading-system-design.md` for full spec.

## Modules

- `data-ingestion.js` — Broker-routed market data + news feeds (Alpaca equities, Alpaca crypto, IBKR)
- `watchlist.js` — Managed watchlist with broker/exchange/asset-class-aware screening criteria
- `consensus.js` — 2-of-3 multi-model voting engine
- `risk-engine.js` — Hard limits, stop losses, kill switch
- `executor.js` — Broker-routed order placement (Alpaca + IBKR)
- `broker-adapter.js` — Unified broker interface for Alpaca and IBKR
- `ibkr-client.js` — Interactive Brokers client wrapper for account, positions, orders, and snapshots
- `portfolio-tracker.js` — Unified capital snapshot across Alpaca, IBKR, Polymarket, DeFi yield, and future token positions
- `polymarket-client.js` — Polymarket CLOB client wrapper for auth, markets, order books, balances, and dry-run order flow
- `polymarket-scanner.js` — Polymarket market discovery and filtering for liquid, short-horizon binary markets with edge ranking support
- `polymarket-signals.js` — Deterministic per-agent Polymarket probability assessment and consensus aggregation
- `polymarket-sizer.js` — Half-Kelly Polymarket position sizing with bankroll, exposure, and stop-loss constraints
- `journal.js` — SQLite trade journal
- `scheduler.js` — Market-hours wake/sleep scheduling plus 24/7 crypto and Polymarket automation cadences
- `telegram-summary.js` — Daily trading summary via Telegram

## Setup

1. Sign up at https://alpaca.markets (free paper trading account) and/or configure Interactive Brokers TWS or IB Gateway
2. Get API keys / connection settings from the broker dashboard or gateway
3. Add to `.env`:
   ```
   ALPACA_API_KEY=your_key
   ALPACA_API_SECRET=your_secret
   ALPACA_PAPER=true
   IBKR_HOST=127.0.0.1
   IBKR_PORT=4002
   IBKR_CLIENT_ID=17
   IBKR_PAPER=true
   POLYMARKET_PRIVATE_KEY=your_exported_rabby_private_key
   POLYMARKET_FUNDER_ADDRESS=your_polygon_profile_address
   POLYMARKET_DRY_RUN=true
   ```
4. Crypto is tracked separately from the default equity watchlist.
   Default crypto pairs: `BTC/USD`, `ETH/USD`, `SOL/USD`, `AVAX/USD`, `LINK/USD`, `DOGE/USD`
5. Polymarket starts in dry-run mode by default so new market modules can log intended orders before any live execution is enabled.
