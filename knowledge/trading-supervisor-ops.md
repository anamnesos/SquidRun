# Trading Supervisor Ops

## Orchestrator Dry Run

Use the standalone dry-run harness to validate signal registration, consensus, and risk filtering without placing orders:

```powershell
node ui/modules/trading/__tests__/orchestrator-dry-run.js
```

What it does:

- registers canned Oracle / Architect / Builder signals for the default watchlist
- runs `runConsensusRound()` only
- prints approved vs rejected trades with risk-engine reasons
- does **not** execute Alpaca orders

## Supervisor Trading Automation

`ui/supervisor-daemon.js` now drives the trading day from the market-calendar scheduler in `ui/modules/trading/scheduler.js`.

Daily market-day phases (Pacific Time):

1. `5:30 AM` — `premarket_wake`
2. `6:25 AM` — `pre_open_consensus`
3. `6:30 AM` — `market_open_execute`
4. `12:30 PM` — `close_wake` / midday review
5. `1:00 PM` — `market_close_review`
6. `1:30 PM` — `end_of_day`

## Signal Production

The pre-market signal generator lives at:

`ui/modules/trading/signal-producer.js`

Primary entrypoints:

- `produceSignals(agentId, alpacaClient)` — fetches live watchlist snapshots, 5-day daily bars, and news, then returns agent-specific BUY/SELL/HOLD signals
- `registerAllSignals(orchestrator, agentId, signals)` — writes those signals into the orchestrator for the consensus round

Runtime wiring:

- `runPreMarket()` now auto-generates and registers any missing Architect / Builder / Oracle signals inside the live orchestrator process
- `runConsensusRound()` backfills any remaining missing signals before consensus so the supervisor can recover after a restart or partial signal state
- `data-ingestion.getNews()` now sends Alpaca news requests with a symbol array instead of a comma-joined string, matching the current SDK contract

Runtime state is persisted at:

`workspace/.squidrun/runtime/trading-supervisor-state.json`

This keeps the daemon from re-running already completed trading phases after a restart.

## Supervisor Health Checks

The `startup-health` checks monitor lane staleness based on fixed time thresholds, which currently conflict with phase-based scheduling:
- `crypto_trading_supervisor`: Idles for 4 hours between `crypto_consensus` phases, but triggers a staleness warning after 45 minutes.
- `paper_trading_automation`: Idles for 6 hours intraday and 16 hours overnight between market phases, but triggers a staleness warning after 60 minutes.

**Recommendation:** The staleness thresholds in `ui/scripts/hm-startup-health.js` should be made phase-aware or raised above the maximum natural idle gap for these lanes to prevent false alarms.
