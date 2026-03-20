# Daily Trading Report Spec (Telegram)

## Objective
Provide James with a concise, scannable daily summary on Telegram answering the core question: "Did we make money today?" The report must avoid walls of text and use visual indicators (emojis) for quick reading on mobile.

## Delivery Timing
**Recommendation:** Send at **5:00 PM Local Time** (or immediately following the US equity market close at 4:15 PM EST if heavily weighted toward traditional markets). If purely crypto, **00:00 UTC** is the standard daily close. Given James's multi-market approach, 5:00 PM local time ensures he reviews it at the end of his workday.

## Message Format Mockup

```text
📊 SquidRun Daily Report
📅 2026-03-20

💰 Portfolio: $102,450.00
📈 Daily P&L: +$2,450.00 (+2.4%)

🎯 Executed Trades: 12 (8W / 4L)
💵 Net Trade P&L: +$2,100.00

🤖 Agent Accuracy (Attribution):
- Oracle: 80% (4/5)
- Builder: 75% (3/4)
- Architect: 66% (2/3)

💼 Open Positions:
- BTC/USD: +$350.00 (+0.5%)
- SOL/USD: -$120.00 (-1.2%)
- AVAX/USD: +$50.00 (+0.8%)

⚠️ Risk & Notable Events:
- Max Drawdown: 1.2% from peak
- Daily Loss: 0% (in profit)
- Events: Smart Money BUY signal on SOL/USD ignored due to Architect consensus override. Kill switch inactive.
```

## Data Requirements per Section
1. **Portfolio Snapshot:** Total equity combining cash and open position values. Delta from the previous day's report.
2. **Trades Executed:** Count of closed trades. Win/loss ratio. Realized net P&L.
3. **Agent Accuracy:** Requires querying the `evidence-ledger.db` for consultation signals vs. actual trade outcomes to grade each agent's predictive accuracy for the day.
4. **Open Positions:** Ticker, unrealized P&L in dollars, and unrealized P&L in percentage. If >5 positions, truncate to top 3 and bottom 2.
5. **Notable Events:** NLP summary of critical log events (e.g., circuit breakers, macro gate closures, intra-agent consensus disagreements).
6. **Risk Status:** Current drawdown percentage from all-time high. Warning flags if approaching daily loss limits.