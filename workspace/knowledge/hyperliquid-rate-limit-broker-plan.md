# Hyperliquid Rate Limit Broker Plan

(Re-homed S398 from cognitive memory after the source file was deleted. "Official Limits" is a
durable API reference fact. "Bottom Line" is a plan recommendation — the shared-proxy fix was
NOT found in live source as of S398; treat as pending until confirmed built.)

## Official Hyperliquid Limits
Source: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits

Per-IP REST budget:
- Aggregated weight limit: `1200 per minute`
- Equivalent average budget: `20 weight per second`

Derived practical ceilings:
- `exchange` unbatched action, weight `1`: up to `20 req/s` average if nothing else is consuming the IP budget
- `exchange` batched action, weight `1 + floor(batch_length / 40)`: example batch weight `2` means `10 req/s` average
- `info` weight-2 requests (`l2Book`, `allMids`, `clearinghouseState`, `orderStatus`, `spotClearinghouseState`, `exchangeStatus`): up to `10 req/s` average if only those are running
- Other `info` requests, weight `20`: about `1 req/s` average
- `userRole`, weight `60`: about `0.33 req/s`

Important caveats:
- `candleSnapshot` adds extra weight per 60 items returned
- several historical/info endpoints add extra weight per 20 items returned
- address-based limits apply separately to `exchange` actions, but not to `info` requests

## Bottom Line
The correct fix is a shared proxy. Staggered schedules help, but only as a temporary pressure reducer. Per-process retries alone are not enough because the Hyperliquid limit is per IP, not per process.
