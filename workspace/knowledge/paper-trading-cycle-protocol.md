# Paper Trading Cycle Protocol

(Re-homed S398 from cognitive memory after the source file was deleted; preserved per Architect
ruling — paper money, no live-capital risk. NOTE: `paper-trading-automation.js` currently exists
only as a packaged dist artifact, not in live source — confirm with James whether paper-trading
is active before relying on this operationally.)

## When to OPEN
- Clean 5m structure (trend confirmed, not midrange chop)
- Macro gate clear OR macro red but the trade explicitly fades the macro driver
- News VETO not scoping the ticker
- Sizing per `trading-operations.md`: $200+ margin on 0.65+ conviction, no $60 probes
- Stop must be declared at entry, exchange-native if going live

## Validation rules (paper-trading-automation.js)
- `rationale` is required
- Exactly one of `stopDeclaration` or `noStopDeclaration` (not both, not neither)
- For `noStopDeclaration`, the `reason` (or `note`) field is required
- For `stopDeclaration`, `type` and `price` are required
- Malformed replies are rejected and you wait until the next cycle

## Response format
Reply via `node ui/scripts/hm-send.js builder --stdin` (or --file for long) with valid JSON only. Required fields:
- `requestId` (echo from context)
- `agentId` (echo from context)
- `action.type`: `hold` | `open` | `close` | `scale` | `hourly_mark`
- `rationale`: plain English, required
- exactly one of `stopDeclaration` or `noStopDeclaration`

Action field guidance:
- `hold` / `hourly_mark` need no mutation fields
- `open` needs `ticker`, `side`, `marginUsd`, `leverage`
- `close` needs `ticker` and optional `closePct`
- `scale` needs `ticker` plus `direction` (add|reduce) and size fields
