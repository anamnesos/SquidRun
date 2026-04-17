# Trading Intelligence Layer Spec

## 1. Goal
Upgrade the current crypto consultation flow from "price snapshots + light news context" into a real trading intelligence system that:

- ingests fast news, on-chain flow, social sentiment, and macro events,
- scans the full Hyperliquid tradeable universe instead of only the current 6-symbol consultation basket,
- surfaces asymmetric breakout setups with concrete catalysts,
- packages conviction, sizing, leverage, stop, and trailing logic into the consultation payload so Builder can wire it into execution.

This spec is intentionally aggressive. The objective is not just to avoid bad trades. The objective is to find the few moments where multiple independent signals align and press those setups harder.

Checked/researched on **March 26, 2026**.

## 2. Current State
The repo already has the right seams:

- `ui/modules/trading/orchestrator.js` already sends `snapshots`, `bars`, `news`, `accountSnapshot`, `whaleData`, `macroRisk`, and `brokerCapabilities` into consultation requests.
- `ui/modules/trading/signal-producer.js` already scores momentum, volume, and simple news terms.
- `.squidrun/runtime/consultation-requests/consultation-1774522827601-q7soqr.json` shows the current live consultation payload shape.
- `.squidrun/runtime/crypto-trading-supervisor-state.json` already has a `hyperliquidExecution` block with `accountValue`, `action`, `signal`, and `approvedTrade`.

The intelligence layer should extend this path, not replace it.

## 3. Design Principles

1. Keep the current consultation loop for requested symbols.
2. Add a separate **discovery loop** that continuously scans all Hyperliquid pairs.
3. Normalize every feed into a single `intelligence` object so the consultation agents are not asked to reason over raw vendor payloads.
4. Separate:
   - `discovery` = find candidates
   - `conviction` = decide if the candidate is special
   - `execution package` = leverage, stop, trailing, and R/R requirements
5. Spend money where signal density is highest:
   - on-chain / flow / unlock / whale data first
   - curated crypto news second
   - direct X firehose last

## 4. Recommended v1 Stack

### Primary recommendation

- **News + catalysts:** internal curated RSS/news ingestion plus optional CryptoPanic
- **On-chain + exchange flow:** Whale Alert first, CoinGlass second
- **Social sentiment:** Reddit + CoinGecko community metadata + optional Santiment
- **Macro events:** Federal Reserve calendar + existing macro layer + optional CoinGlass economic calendar
- **Universe scanner:** Hyperliquid universe metadata already used in `ui/scripts/hm-defi-execute.js`

### Why this stack

- It gives immediate coverage for headlines, listings/upgrades/unlocks, whale accumulation, and exchange flow.
- It keeps the first build practical instead of waiting on expensive or operationally messy social-firehose integrations.
- It maps cleanly onto the current repo structure.

## 5. Source Matrix

| Category | Source | What it gives us | Cost / status | Recommendation |
| --- | --- | --- | --- | --- |
| Crypto news | CryptoPanic developers page | Crypto-native headline aggregation API | Public API exists, but public pricing was not clearly exposed on the developer page during research | Investigate procurement if we want a dedicated crypto headline vendor |
| Market metadata / community | CoinGecko API | Coin metadata, community stats, trending context, socials fields | Public/demo API available for light usage; no clear official general news endpoint found | Use for metadata and community context, not as the main newswire |
| Whale / transfer alerts | Whale Alert Custom Alerts API | WebSocket alerts, exchange attribution, stablecoin mints/burns, 11 blockchains, 100+ assets | **$29.95/month** personal-use plan, 7-day trial, up to 100 alerts/hour | Strong v1 buy |
| On-chain + social analytics | Santiment | Social trends, on-chain metrics, richer sentiment layer | **Free:** $0 with 30-day lag and 1K API calls/month. **Pro:** $49/month or $529/year | Best optional upgrade if we want one vendor for social + on-chain scoring |
| Exchange flow / unlocks / market events | CoinGlass API | Exchange netflows, liquidation data, whale/institutional intelligence, token unlocks, economic calendar | Paid; pricing page is public, but exact API tier mapping was not reliably extractable from HTML during this pass | Strong v1.5 or paid v1 if budget allows |
| Social firehose | X API | Direct access to curated Crypto Twitter lists and account posts | Officially **pay-per-usage**; higher-volume access pushes toward enterprise, and public docs note a monthly cap on pay-per-usage plans | Do not make this the first paid purchase |
| Social discussion | Reddit official/public feeds | Subreddit activity, title/body sentiment, retail chatter | Cheap/free for targeted polling | Strong v1 baseline social feed |
| Macro calendar | Federal Reserve FOMC calendar | Official FOMC meeting dates and event timing | Free | Required |
| Macro / event enrichment | Existing macro layer + GDELT + optional CoinGlass economic calendar | Geopolitical tone + macro event context | Free + optional paid enrichment | Required |

## 6. Investigated But Not Chosen As Primary

### CryptoPanic
Worth keeping on the list because it is crypto-native. It did not make the primary v1 recommendation only because public pricing was not clearly visible during research, and we already have a cheaper path to v1 via curated RSS plus Whale Alert/CoinGlass enrichment.

### CoinGecko "news"
The official docs clearly expose coin metadata and community fields, but I did **not** find a clear official general-purpose news endpoint suitable for a primary headline pipeline. Use CoinGecko for metadata and community context instead.

### Direct X ingestion
This can absolutely produce alpha, but the cost model is less friendly for a first pass than whale/on-chain/catalyst feeds. The aggressive move is to buy the highest-signal data first, not the noisiest data first.

## 7. Architecture

### 7.1 Two loops

#### A. Consultation loop
Runs on the existing cadence for requested symbols.

Inputs:

- `snapshots`
- `bars`
- `news`
- `macroRisk`
- `whaleData`
- new `intelligence.byTicker`

Output:

- enhanced consultation request for the current basket

#### B. Opportunity scanner loop
Runs continuously across the full Hyperliquid universe.

Inputs:

- Hyperliquid universe list
- per-market price/volume/open-interest data
- catalyst feed
- whale feed
- social sentiment feed
- macro regime

Output:

- ranked candidate list
- auto-generated "candidate consultations" for top setups
- optional watchlist promotion for the top N symbols

### 7.2 Proposed modules

Add:

- `ui/modules/trading/intelligence-ingestion.js`
- `ui/modules/trading/opportunity-scanner.js`
- `ui/modules/trading/catalyst-engine.js`
- `ui/modules/trading/conviction-engine.js`

Extend:

- `ui/modules/trading/data-ingestion.js`
- `ui/modules/trading/orchestrator.js`
- `ui/modules/trading/signal-producer.js`

## 8. Normalized Data Model

Keep the current payload fields for backward compatibility, and add one new top-level block:

```json
{
  "intelligence": {
    "asOf": "2026-03-26T11:40:00.000Z",
    "regime": {
      "macro": {
        "color": "yellow",
        "score": 46,
        "summary": "Fed tomorrow; oil elevated; no crisis override"
      }
    },
    "scanner": {
      "universeSize": 132,
      "topCandidates": [
        {
          "symbol": "TOKEN/USD",
          "scannerScore": 84,
          "setupType": "momentum_breakout",
          "reasons": [
            "2.8x volume vs 20-bar baseline",
            "range breakout confirmed",
            "token unlock in 3 days",
            "whale accumulation detected"
          ]
        }
      ]
    },
    "byTicker": {
      "BTC/USD": {
        "newsScore": 0.18,
        "socialScore": -0.04,
        "onChainScore": 0.31,
        "catalystScore": 0.12,
        "convictionScore": 0.44,
        "catalysts": [],
        "whaleSignals": [],
        "headlineSummary": "ETF inflow headlines offset by macro caution"
      }
    }
  }
}
```

### 8.1 Required per-ticker fields

- `newsScore`: headline and catalyst sentiment
- `socialScore`: Reddit / optional X / optional Santiment pulse
- `onChainScore`: whale transfers, netflows, exchange balance changes
- `catalystScore`: unlocks, listings, upgrades, partnerships, governance votes
- `convictionScore`: blended final score
- `riskFlags`: `unlock_today`, `exchange_inflow_spike`, `thin_book`, `macro_event_24h`
- `executionPackage`: present only for top candidates

## 9. Opportunity Scanner

### 9.1 Universe

Scan **all Hyperliquid pairs**, not just the current consultation basket.

Source:

- Reuse the same Hyperliquid universe source already referenced by `ui/scripts/hm-defi-execute.js` through `meta.universe`.

Refresh cadence:

- universe metadata: every 15 minutes
- market stats / breakouts: every 1 minute
- catalyst feeds: every 5 minutes
- whale / on-chain alerts: realtime if possible, otherwise every 1-2 minutes

### 9.2 Scanner modes

#### A. Momentum breakout scanner
Find:

- price breaking a 1h / 4h range
- volume spike vs 20-bar average
- open interest expansion
- positive headline or catalyst confirmation

Core trigger:

- `breakout = close > prior_range_high`
- `volume_ratio >= 2.0`
- `oi_delta > 0`

#### B. Catalyst scanner
Find:

- exchange listings
- token unlocks
- protocol upgrades / mainnet launches
- partnerships / integrations
- governance votes
- ETF / institutional catalysts for majors

This scanner should not only store a headline. It should store:

- catalyst type
- scheduled time
- confidence
- source
- whether it is bullish, bearish, or two-sided

#### C. Low-cap accumulation scanner
Find:

- small / mid-cap Hyperliquid names
- quiet price compression
- rising spot/perp volume
- repeated positive netflow / wallet accumulation
- social chatter rising from low base

This is where early trend capture should come from.

#### D. Whale movement scanner
Find:

- large wallet accumulation into non-exchange wallets
- repeated transfers off exchanges
- stablecoin mint + deployment patterns
- large inflow to exchanges before breakdown risk

## 10. Conviction Engine

### 10.1 Score model

Proposed weights:

- price structure / breakout quality: **25%**
- volume / participation: **15%**
- catalyst quality and proximity: **20%**
- on-chain / whale flow: **20%**
- social acceleration: **10%**
- macro compatibility: **10%**

Output:

- `0-59`: noise / watch only
- `60-74`: candidate
- `75-84`: actionable
- `85+`: high conviction

### 10.2 High-conviction definition

High conviction requires all of:

1. `convictionScore >= 85`
2. `rewardRisk >= 3.0`
3. one of:
   - major catalyst confirmed
   - whale accumulation confirmed
   - multi-timeframe breakout confirmed
4. no hard block:
   - severe macro lockout
   - extremely thin book
   - imminent adverse unlock

This is the moment where the system should stop acting like a watcher and start acting like a hunter.

## 11. High Conviction Mode

### 11.1 Purpose
When all signals align, the system should generate a complete Hyperliquid-ready trade package instead of a vague "BUY with confidence 0.86".

### 11.2 Execution package

```json
{
  "executionPackage": {
    "mode": "high_conviction",
    "side": "long",
    "entryType": "breakout_retest_or_market_if_running",
    "leverage": 7,
    "riskPercent": 0.02,
    "invalidatedBelow": 1.24,
    "initialStop": 1.24,
    "target1": 1.38,
    "target2": 1.44,
    "target3": 1.52,
    "rewardRisk": 3.6,
    "trailingPolicy": "atr_plus_structure",
    "notes": [
      "whale accumulation confirmed",
      "exchange outflow spike",
      "listing rumor from credible source"
    ]
  }
}
```

### 11.3 Leverage sizing

Use leverage only in **High Conviction Mode**:

- score `85-89`: up to **5x**
- score `90-94`: up to **7x**
- score `95+`: up to **10x**, only if:
  - liquidity is strong,
  - slippage is acceptable,
  - the setup is catalyst-backed,
  - the market is not in macro hard-red/stay-cash mode

This keeps leverage tied to setup quality instead of emotion.

### 11.4 Trailing stop strategy

Use a three-step trail:

1. Place initial hard stop at the structural invalidation level.
2. At `+1R`, move stop to breakeven.
3. At `+2R`, begin trailing by:
   - `max(previous_stop, swing_low, ATR trail)`

Recommended logic:

- breakout trades: trail under higher lows on the execution timeframe
- trend continuation trades: trail on `1.5 x ATR`
- parabolic moves: take partials at `2R` and `3R`, trail the runner aggressively

### 11.5 Asymmetric setup rule

Do not allow High Conviction Mode unless:

- projected reward/risk is **3:1 or better**
- slippage-adjusted reward/risk remains above **2.5:1**

This prevents high leverage on mediocre setups.

## 12. Bankroll Growth Strategy

### 12.1 Objective
Grow a small account aggressively by pressing only A and A+ setups, not by trading constantly.

Current anchor from runtime state:

- current Hyperliquid account value seen in `.squidrun/runtime/crypto-trading-supervisor-state.json`: about **$637.63**

Target:

- **$20K+**

### 12.2 Growth framework

This should be encoded as a **bankroll mode**, not left to manual judgment.

| Equity band | Goal | Allowed mode | Risk per trade | Leverage ceiling |
| --- | --- | --- | --- | --- |
| `$500-$1,500` | Survive and find first inflection | Only A+ setups | `1.5%-2.0%` | `5x` |
| `$1,500-$5,000` | Press winners harder | A / A+ setups | `2.0%` | `7x` |
| `$5,000-$10,000` | Accelerate compounding | A / A+ setups, more size on liquid names | `2.0%-2.25%` | `7x`, `10x` exceptional |
| `$10,000-$20,000+` | Keep compounding without round-tripping | A setups only, reduce low-cap exposure | `1.5%-2.0%` | `5x-7x`, `10x` rare |

### 12.3 Rules for compounding

- only compound after closed equity highs
- increase size in steps, not continuously
- if account drawdown exceeds:
  - `6%` weekly: drop one bankroll tier
  - `10%` rolling: disable High Conviction Mode until recovery

### 12.4 System behavior

The engine should derive:

- `bankrollTier`
- `riskBudget`
- `maxAllowedLeverage`
- `dailyLossLimit`
- `weeklyDrawdownLock`

from live account value, automatically.

## 13. Concrete Feed Plan

### 13.1 News / catalyst ingestion

#### v1 baseline

- internal curated RSS/news parser for:
  - CoinDesk
  - Cointelegraph
  - The Block
  - Decrypt
  - project blogs / exchange announcement blogs
- normalize to:
  - `headline`
  - `summary`
  - `publishedAt`
  - `symbols`
  - `source`
  - `sentiment`
  - `catalystType`

#### v1 paid upgrade

- add **CryptoPanic** if pricing/terms check out
- add **CoinGlass newsflash + token unlock calendar** if budget allows

### 13.2 On-chain / whale ingestion

#### Must-have

- **Whale Alert Custom Alerts API**
  - large transfers
  - exchange attribution
  - stablecoin mints/burns

#### Strong upgrade

- **CoinGlass**
  - exchange wallet net inflow/outflow
  - liquidation clusters
  - funding/OI anomalies
  - token unlock schedule
  - economic calendar

#### Optional premium

- **Santiment**
  - richer on-chain entity / social overlays

### 13.3 Social sentiment ingestion

#### v1

- Reddit:
  - `r/CryptoCurrency`
  - asset-specific subreddits
  - project-specific communities when active
- CoinGecko community fields:
  - `twitter_followers`
  - `reddit_subscribers`
  - `telegram_channel_user_count`
  - sentiment vote percentages where present

#### v1.5 / optional

- curated X account lists:
  - Hyperliquid ecosystem
  - major exchanges
  - protocol founders
  - on-chain analysts

Do this only if budget is approved for X usage.

### 13.4 Macro event ingestion

Must ingest:

- official **Federal Reserve FOMC calendar**
- existing macro-risk layer
- optional **CoinGlass economic calendar**

Also useful:

- manual cache of official CPI release dates because BLS bot defenses can interfere with automated pulls

## 14. Integration Points

### 14.1 `data-ingestion.js`
Add adapter methods:

- `getIntelligenceNews()`
- `getWhaleAlerts()`
- `getCatalystCalendar()`
- `getSocialSignals()`
- `getHyperliquidUniverse()`

### 14.2 `orchestrator.js`
Before building consultation requests:

- fetch `intelligence.byTicker` for requested symbols
- fetch `scanner.topCandidates`
- attach both to the consultation payload

### 14.3 `signal-producer.js`
Extend scoring beyond simple news term hits:

- add `socialScore`
- add `onChainScore`
- add `catalystScore`
- add `convictionScore`

### 14.4 New scanner service
`opportunity-scanner.js` should:

- refresh the Hyperliquid universe
- score every pair
- publish top candidates into runtime state
- optionally trigger a consultation for the top N candidates

## 15. Runtime Outputs

Add to supervisor/runtime state:

```json
{
  "scanner": {
    "universeSize": 132,
    "topCandidates": [],
    "lastRunAt": "2026-03-26T11:45:00.000Z"
  },
  "bankrollMode": {
    "equity": 637.63,
    "tier": "seed",
    "riskPerTrade": 0.02,
    "maxLeverage": 5,
    "dailyLossLimit": 0.04
  }
}
```

## 16. Rollout Plan

### Phase 1

- build normalized `intelligence` payload
- add Whale Alert
- add curated news / RSS ingestion
- add Hyperliquid universe scanner
- rank top candidates

### Phase 2

- add CoinGlass or Santiment
- enrich catalysts / unlocks / exchange netflows
- add full conviction engine
- add execution package generation

### Phase 3

- optional X integration
- auto-promotion from scanner candidate to executable trade package
- automated daily candidate report and rolling post-trade attribution

## 17. Recommended Build Order For Builder

1. Extend the consultation schema with `intelligence`.
2. Build the Hyperliquid universe scanner.
3. Add Whale Alert ingestion.
4. Add curated catalyst/news normalization.
5. Add conviction scoring.
6. Add High Conviction Mode execution package.
7. Add bankroll mode and compounding tiers.

## 18. Bottom Line

The correct move is not to bolt "sentiment" onto the existing 6-symbol consultation request.

The correct move is to add a **full trading intelligence layer** with:

- a full-pair Hyperliquid discovery engine,
- catalyst-aware ranking,
- whale/on-chain confirmation,
- social acceleration detection,
- a high-conviction execution package,
- and bankroll-aware leverage logic.

That is the path from passive monitoring to aggressive, selective compounding.

## 19. Sources

- Federal Reserve FOMC calendars: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
- CoinGecko API docs: https://docs.coingecko.com/reference/coins-id
- X API pricing: https://docs.x.com/x-api/getting-started/pricing
- Whale Alert API documentation: https://developer.whale-alert.io/documentation/
- Santiment pricing: https://santiment.net/pricing/
- CoinGlass pricing / API overview: https://www.coinglass.com/pricing
- CryptoPanic developers page: https://cryptopanic.com/developers/api/
