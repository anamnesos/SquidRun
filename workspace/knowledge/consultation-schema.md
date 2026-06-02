# Consultation Request Schema

## Overview
This document outlines the JSON schema used by the `crypto_trading_supervisor` for agent consultation requests, typically located in `.squidrun/runtime/consultation-requests/*.json`.

## `cryptoMechBoard` Structure

The mechanical crypto scorecard is attached to the request under the `cryptoMechBoard` key. This object contains the venue metadata, the computation timestamp, and the detailed breakdown per asset.

**Crucially, the per-asset data is nested inside a `symbols` dictionary.**

### JSON Path (Example)
To read the mechanical board metrics for a specific asset (e.g., `XPL/USD`), you must access the `symbols` key first:

```json
{
  "cryptoMechBoard": {
    "venue": "hyperliquid",
    "asOf": "2026-04-25T11:00:32.574Z",
    "symbols": {
      "XPL/USD": {
        "ticker": "XPL/USD",
        "tradeFlag": "watch",
        "mechanicalDirectionBias": "bearish",
        "mechanicalBiasScore": -0.2154,
        "squeezeRiskScore": 36,
        "overcrowdingScore": 43,
        "cascadeRiskScore": 55,
        "fundingRateBps": 0.125
        // ...
      }
    }
  }
}
```

### Common Read Errors
- ❌ **Incorrect Path:** `request.cryptoMechBoard['XPL/USD']` (Returns `undefined` or empty)
- ✅ **Correct Path:** `request.cryptoMechBoard.symbols['XPL/USD']`

**PowerShell Warning:** When parsing deeply nested consultation request files via PowerShell (`ConvertFrom-Json | ... | ConvertTo-Json`), ensure you specify a high `-Depth` (e.g., `-Depth 10`). PowerShell's default depth limit is 2, which will silently truncate the `cryptoMechBoard` object, making it appear empty (`{}`) in terminal reads even when the data exists perfectly on disk.