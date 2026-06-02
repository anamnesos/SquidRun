# Token Unlock Trading Routine
# Created: 2026-04-09 session 268
# Cross-checked by: Architect, Builder, Oracle

## Daily Scans
- **Morning (9 AM PDT)**: Check Tokenomist for unlocks in 14-day window
- **Evening (9 PM PDT)**: Same check, catch new additions
- Cross-reference with Hyperliquid tradeable list (Builder maintains overlap table)

## Filters (must pass ALL to be flagged)
1. % of circulating/released supply unlocked > meaningful (context-dependent, not fixed 5%)
2. Unlock value vs Hyperliquid average daily volume — must be significant
3. Recipient type: Team/Advisors/Investors = strong short. Ecosystem/Incentives = weak.
4. Liquidity floor: if Hyperliquid volume is too thin or spread too wide = watch-only
5. NOT already priced in: if price already crashed and funding is heavily positive, late entry = squeeze trap

## Pre-Trade (5-7 days before for big unlocks, 48h minimum)
- Monitor price action for pre-event weakness
- Check funding rate — positive = shorts paying = stronger short thesis
- Build trade ticket: token, unlock time (exact with timezone), % circulating supply, unlock value, recipient, HL volume/OI/funding, entry trigger, stop, TP, "why not already priced in"

## Execution (2-3 hours before unlock)
- Enter short IF: price hasn't already crashed, liquidity sufficient, funding supports it
- Size by max dollar loss first, then derive notional from stop distance
- Exchange-native stop BEFORE entry or no trade
- Max 1 unlock trade at a time until routine is proven

## During Event
- Do NOT blindly hold through unlock
- If price already dropped hard before unlock, consider taking profit — unlock itself can bounce
- Reassess at the event, not just after

## Cancel Checklist (abort trade if)
- Unlock delayed or rescheduled
- Unlock reclassified to ecosystem/non-sellers
- Price already crashed hard pre-event
- Funding flipped against thesis (heavily positive = crowded short)
- Liquidity disappeared

## Post-Trade Journal (MANDATORY for every unlock play)
- Entry timing vs unlock timestamp
- Return at 24h / 72h / 7d after unlock
- Whether drop started before event
- Whether funding improved or hurt the trade
- Recipient type
- Liquidity quality during trade
- Lessons

## Roles
- Architect: checks Tokenomist dashboard via browser, evaluates setups, executes manually
- Builder: maintains Hyperliquid tradeable overlap table, technical execution support
- Oracle: evaluates setup quality, cross-checks thesis, pushback on weak setups
