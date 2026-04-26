# Trading Module

Autonomous multi-model swing trading system.

## Architecture

See `workspace/specs/trading-system-design.md` for full spec.

## Modules

- `data-ingestion.js` — Broker-routed market data + news feeds (Alpaca equities, Alpaca crypto, IBKR)
- `watchlist.js` — Backward-compatible watchlist facade for the live trading pipeline
- `dynamic-watchlist.js` — Persistent static + dynamic watchlist with source tagging and expiry pruning
- `agent-attribution.js` — Persistent per-agent prediction/outcome tracking with asset-class-specific stats and leaderboards
- `wallet-tracker.js` — Smart-money wallet registry with mockable move ingestion and convergence detection
- `smart-money-scanner.js` — Continuous smart-money polling loop with persisted transfer state, convergence detection, and trigger events for immediate consensus wakes
- `consultation-store.js` — Runtime request/response store for real pane-agent market consultations via `hm-send`
- `consensus.js` — 2-of-3 multi-model voting engine
- `risk-engine.js` — Hard limits, stop losses, kill switch
- `executor.js` — Broker-routed order placement (Alpaca + IBKR)
- `broker-adapter.js` — Unified broker interface for Alpaca and IBKR
- `ibkr-client.js` — Interactive Brokers client wrapper for account, positions, orders, and snapshots
- `portfolio-tracker.js` — Unified capital snapshot across Alpaca, IBKR, DeFi yield, and future token positions
- `journal.js` — SQLite trade journal
- `scheduler.js` — Market-hours wake/sleep scheduling plus 24/7 crypto automation cadences
- `telegram-summary.js` — Daily trading summary via Telegram

## Setup

1. Sign up at https://alpaca.markets and/or configure Interactive Brokers TWS or IB Gateway
2. Get API keys / connection settings from the broker dashboard or gateway
3. Add to `.env`:
   ```
   ALPACA_API_KEY=your_key
   ALPACA_API_SECRET=your_secret
   IBKR_HOST=127.0.0.1
   IBKR_PORT=4002
   IBKR_CLIENT_ID=17
   HYPERLIQUID_PRIVATE_KEY=your_hyperliquid_private_key
   HYPERLIQUID_WALLET_ADDRESS=your_hyperliquid_wallet_address
   ```
4. Crypto is tracked separately from the default equity watchlist.
   Default crypto pairs: `BTC/USD`, `ETH/USD`, `SOL/USD`, `AVAX/USD`, `LINK/USD`, `DOGE/USD`
