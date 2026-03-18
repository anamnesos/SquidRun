# Trading Module

Autonomous multi-model swing trading system.

## Architecture

See `workspace/specs/trading-system-design.md` for full spec.

## Modules

- `data-ingestion.js` — Alpaca market data + news feeds
- `watchlist.js` — Managed watchlist with screening criteria
- `consensus.js` — 2-of-3 multi-model voting engine
- `risk-engine.js` — Hard limits, stop losses, kill switch
- `executor.js` — Alpaca order placement (paper + live)
- `journal.js` — SQLite trade journal
- `scheduler.js` — Market-hours wake/sleep scheduling
- `telegram-summary.js` — Daily trading summary via Telegram

## Setup

1. Sign up at https://alpaca.markets (free paper trading account)
2. Get API keys from the dashboard
3. Add to `.env`:
   ```
   ALPACA_API_KEY=your_key
   ALPACA_API_SECRET=your_secret
   ALPACA_PAPER=true
   ```
