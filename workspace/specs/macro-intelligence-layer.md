# Macro Intelligence Layer Spec

## 1. Goal
Augment the existing `macro-risk-gate` (which relies on lagging indicators like VIX, Fear & Greed, and Oil) with real-time geopolitical awareness, news sentiment, and central bank event tracking. This provides a leading indicator edge, ensuring we don't buy into a technical breakout right before a macro collapse.

## 2. Data Sources (Free & Practical)

### A. Conflict & Sanctions Detection
- **Source:** **GDELT Project** (Global Database of Events, Language, and Tone).
- **Cost:** 100% Free / Open Source.
- **Integration:** Query the GDELT DOC API 2.0. We can filter for specific CAMEO event codes (e.g., military action, diplomatic expulsions) targeting high-risk keywords ("Strait of Hormuz", "Iran", "Taiwan").
- **Metric Extract:** The "Goldstein Scale" (ranges from -10 extreme conflict to +10 cooperation) and average Tone.

### B. Financial News Sentiment
- **Source:** **GDELT Tone Scores** (Primary) / **Alpha Vantage** (Optional Enrichment).
- **Cost:** Free. Alpha Vantage has a tight free tier (25 requests/day).
- **Integration:** Rely primarily on the average Tone and Goldstein Scale from the GDELT DOC API 2.0 to cover broad sentiment. Use Alpha Vantage `NEWS_SENTIMENT` selectively or optionally when deeper financial-specific sentiment is required.
- **Metric Extract:** Average sentiment/tone score.

### C. Fed Calendar & Rate Decisions
- **Source:** Local static calendar + **Trading Economics API** (Free tier) or Financial Modeling Prep.
- **Integration:** The 2026 FOMC meeting dates are known (Jan 27-28, Mar 17-18, Apr 28-29, Jun 16-17, Jul 28-29, Sep 15-16, Oct 27-28, Dec 8-9). 
- **Metric Extract:** Boolean `isFedDay`. If true, we expect extreme volatility at 14:00 EST (decision) and 14:30 EST (press conference).

## 3. Signal Output

The intelligence layer will export a normalized object for `macro-risk-gate.js` to consume alongside VIX/Oil:

```json
{
  "geopolitics": {
    "riskScore": 85,          // 0-100 derived from GDELT conflict intensity
    "sentiment": -0.65        // -1.0 to 1.0 from Alpha Vantage
  },
  "fed": {
    "isEventDay": false,
    "hoursUntilDecision": null
  }
}
```

## 4. Confidence Model & Weighting Rules

How macro context overrides or scales technical indicators:

### Rule 1: The "STAY CASH" Mode (Total Block)
If the situation reaches critical systemic risk (e.g., active kinetic conflict at a global shipping chokepoint like the Strait of Hormuz), the regime forces a **STAY CASH** override.
- **Trigger:** `geopolitics.riskScore` > 90 AND specific kinetic conflict keywords detected.
- **Effect:** `buyConfidenceMultiplier = 0.0`. ALL new positions are categorically blocked. Mandatory cash preservation. No exceptions for technical setups.

### Rule 2: The "Hard RED" Overrides
If either of the following conditions is met (but falls short of a STAY CASH scenario), the regime is forced to **RED**, bypassing standard technical scoring:
1. **Elevated Conflict/Sanctions:** `geopolitics.riskScore` > 80.
2. **Fed Danger Zone:** `fed.isEventDay` is true AND time is between 12:00 EST and 15:00 EST.

*Effect:* `buyConfidenceMultiplier = 0.6` (or lower). Standard technical longs are heavily penalized.

### Rule 3: The Blended "YELLOW" Zone
When not in a STAY CASH or Hard RED state, geopolitical and sentiment data are blended into the existing 0-100 risk score to detect rising tension before the VIX spikes.

**Proposed New Risk Weighting:**
- VIX Score: **35%**
- Geopolitical Risk Score: **30%**
- News Sentiment (Inverted for risk): **15%**
- Fear & Greed: **10%**
- Oil Price Shock: **10%**

*Effect:* If the blended score > 60, regime becomes **YELLOW**. `buyConfidenceMultiplier = 0.8`. Technical setups must be exceptionally strong (e.g., base confidence > 0.90) to execute, and position sizing is halved.

### Rule 4: The "GREEN" Baseline
Risk score < 40. VIX is stable, no major conflicts detected, sentiment is neutral/positive. 
*Effect:* `buyConfidenceMultiplier = 1.0`. Technical agents have full autonomy to execute standard setups.
