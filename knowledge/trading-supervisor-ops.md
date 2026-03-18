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

Runtime state is persisted at:

`workspace/.squidrun/runtime/trading-supervisor-state.json`

This keeps the daemon from re-running already completed trading phases after a restart.
