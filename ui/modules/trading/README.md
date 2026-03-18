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
- `journal.js` — SQLite trade journal
- `scheduler.js` — Market-hours wake/sleep scheduling
- `scheduler.js` — Market-hours wake/sleep scheduling plus 24/7 crypto consensus cadence
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
   ```
4. Crypto is tracked separately from the default equity watchlist.
   Default crypto pairs: `BTC/USD`, `ETH/USD`, `SOL/USD`, `AVAX/USD`, `LINK/USD`, `DOGE/USD`
