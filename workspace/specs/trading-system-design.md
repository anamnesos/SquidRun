# SquidRun Autonomous Trading System — Design Spec

## Overview

Fully autonomous multi-model swing trading system. 3 AI models (Claude, GPT, Gemini) independently analyze opportunities, debate via adversarial consensus, and execute trades through Alpaca. Human receives daily Telegram summaries only.

## Architecture

### Phase 1: Paper Trading MVP

```
Market Data (Alpaca) → Data Ingestion Layer
                            ↓
                    Watchlist Manager
                            ↓
              ┌─────────────┼─────────────┐
              ↓             ↓             ↓
         Oracle         Architect      Builder
        (Gemini)        (Claude)        (GPT)
        Research       Strategy        Execution
        Sentiment      Risk Mgmt      Infrastructure
              ↓             ↓             ↓
              └─────────────┼─────────────┘
                            ↓
                   Consensus Engine
                   (2-of-3 agree)
                            ↓
                     Risk Engine
                  (hard limits check)
                            ↓
                   Alpaca Paper Trading
                            ↓
                   Trade Journal + Memory
                            ↓
                   Telegram Daily Summary
```

### Agent Roles (Trading Mode)

**Oracle (Pane 3 / Gemini):**
- Pre-market market context review (earnings, SEC filings, macro events)
- Sentiment analysis on watchlist stocks
- Technical indicator calculation
- Produces structured signal: {ticker, direction, confidence, reasoning}

**Architect (Pane 1 / Claude):**
- Receives Oracle's signals
- Independent analysis with different perspective
- Portfolio-level risk assessment
- Consensus coordination: collects all 3 votes
- Final trade decision based on 2-of-3 agreement

**Builder (Pane 2 / GPT):**
- Independent technical analysis
- Order execution via Alpaca API
- Infrastructure: data pipelines, scheduling, self-healing
- Trade journal maintenance

### Consensus Engine

```
For each opportunity:
  1. Oracle produces signal: BUY/SELL/HOLD + confidence + reasoning
  2. Builder produces signal: BUY/SELL/HOLD + confidence + reasoning
  3. Architect produces signal: BUY/SELL/HOLD + confidence + reasoning
  4. If 2-of-3 agree on direction → proceed to risk engine
  5. If no consensus → HOLD (do nothing)
  6. Dissenting opinion logged to memory for future learning
```

### Risk Engine (HARD LIMITS — never overridden)

```
Per-trade:
  - Max 5% of account per position ($25 on $500)
  - Stop loss: -3% per position (auto-sell)

Per-day:
  - Max 10% daily loss → system pauses until next trading day
  - Max 3 trades per day (avoid PDT + overtrading)

Per-account:
  - Max 20% total drawdown from peak → go 100% cash, alert James
  - Max 3 open positions at any time
  - No leverage, no options, no shorting, no margin
  - No penny stocks (min price $5, min market cap $1B)
```

### Daily Schedule (Pacific Time, market days only)

```
5:30 AM  — Supervisor wakes agents
5:30-6:25 — Oracle scans pre-market news + overnight events
           — All 3 agents analyze watchlist independently
6:25      — Consensus round: compare signals, debate disagreements
6:30      — Market opens. Execute approved trades.
6:30-7:00 — Monitor fills, adjust stop losses
7:00      — Agents sleep (positions have stop losses in place)
12:30 PM  — Agents wake for close
12:30-1:00 — Review positions, take profits if targets hit
1:00      — Market closes
1:00-1:30 — End-of-day review:
             - Log all trades to memory
             - Update watchlist for tomorrow
             - Calculate daily PnL
             - Send Telegram daily summary to James
1:30      — Agents sleep
```

### Data Sources

- **Alpaca API**: real-time/delayed quotes, order execution, account info
- **Alpaca News API**: market news (included with account)
- **Yahoo Finance** (yfinance): historical data for backtesting
- **SEC EDGAR**: 10-K/10-Q filings (free API)

### Telegram Notifications

Daily summary only:
```
📊 Trading Day Summary — Mar 18

Portfolio: $504.20 (+0.84%)
Trades: 1 buy (AAPL), 0 sells
Consensus: Claude+Gemini agreed, GPT dissented
Open positions: AAPL (2 shares @ $198.50)
Stop loss: $192.55 (-3%)

Week-to-date: +1.2%
```

Kill switch alert (only if 20% drawdown):
```
⚠️ KILL SWITCH — Portfolio down 20% from peak
All positions sold. System paused.
Current balance: $400
Reply START to resume or STOP to stay paused.
```

### Tech Stack

- **Broker**: Alpaca (paper first, same API for live)
- **Data**: alpaca-py SDK + yfinance
- **Scheduling**: SquidRun supervisor daemon (extend existing)
- **Memory**: Cognitive memory system (existing)
- **Notifications**: Telegram bridge (existing)
- **Storage**: SQLite trade journal (new table in evidence-ledger.db or separate)

### Build Phases

**Phase 1 — Paper Trading MVP (target: 1 week)**
- [ ] Alpaca paper account setup + API keys
- [ ] Market data ingestion module
- [ ] Watchlist manager (start with 10 liquid large-caps)
- [ ] Signal generation (each agent produces BUY/SELL/HOLD)
- [ ] Consensus engine (2-of-3 voting)
- [ ] Risk engine (hard limits)
- [ ] Alpaca order execution (paper)
- [ ] Trade journal (SQLite)
- [ ] Telegram daily summary
- [ ] Supervisor scheduling for market hours

**Phase 2 — Strategy Refinement (target: 1 month paper)**
- [ ] Sentiment analysis layer (news + filings)
- [ ] Backtesting framework (historical validation)
- [ ] Memory-based learning (track which model is right about what)
- [ ] Performance metrics dashboard
- [ ] Strategy iteration based on paper results

**Phase 3 — Live Trading (after paper validation)**
- [ ] Switch Alpaca keys from paper to live
- [ ] Start with $100-200 max
- [ ] Scale up based on verified performance
- [ ] Tax reporting integration

## Key Principles

1. **Paper first, always.** No live money until paper proves the system works.
2. **Risk engine is sacred.** Hard limits are never relaxed, never overridden, never "just this once."
3. **Consensus over conviction.** No single model trades alone.
4. **Memory compounds.** Every trade teaches the system something.
5. **James sees summaries, not noise.** One Telegram message per day.
