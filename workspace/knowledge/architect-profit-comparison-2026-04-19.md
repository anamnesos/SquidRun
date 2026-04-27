# Architect Profit Comparison - 2026-04-19

Scope:
- Window: yesterday through now
- Focus: the trades James explicitly asked to compare
- Goal: compare `full close at peak open profit` versus `what actually happened`

## Per-Trade Comparison

| Trade | Peak Unrealized PnL | Actual Realized PnL | Delta vs Peak | Notes |
| --- | ---: | ---: | ---: | --- |
| SUI SHORT | +18.34 | unresolved | unresolved | Peak is documented; actual exit not preserved cleanly in saved logs. |
| APT SHORT | +11.73 | -29.42 | +41.15 | Exchange stop fired at 0.9376. |
| ETH SHORT | +21.00 | +5.82 | +15.18 | Actual realized value is preserved in pace messages. |
| ORDI SHORT | +24.00 | unresolved | unresolved | `+24` is the conservative saved-record peak; James may have seen closer to `+30`. |
| XPL LONG | +67.00 minimum proxy | +67.00 | +0.00 | Durable attribution was broken; James explicitly corrected this trade as `+$67 realized`. |
| SOL SHORT | unresolved | -6.50 | unresolved | No trustworthy positive peak recovered; actual cut is pinned. |
| BTC LONG | +124.00 | -10.73 | +134.73 | Post-cut review said the trade later would have been about `+$124` unrealized. |
| BLUR SHORT | +25.47 | -1.11 | +26.58 | BE stop saved it from turning into a larger loser after full round-trip. |
| AAVE LONG #1 (freelance) | no positive peak documented | -12.52 | unresolved | Washout-bounce long that was cut on failure. |
| AAVE LONG #2 (late chase) | no positive peak documented | process-error loser, small | unresolved | Late-chase entry above approved zone; cut quickly. Saved logs do not pin the exact net cleanly enough for hard audit math. |

## Hard-Number Totals

### All documented peak-close opportunity

Across every requested trade where I have a trustworthy peak number, the saved record supports at least:

- `FULL CLOSE AT PEAK`: `+291.54`

That number includes:

- `SUI +18.34`
- `APT +11.73`
- `ETH +21.00`
- `ORDI +24.00` conservative
- `XPL +67.00` minimum proxy from James correction
- `BTC +124.00`
- `BLUR +25.47`

### Apples-to-apples subset with both sides pinned

For the subset where I have both a trustworthy peak number and a trustworthy realized number:

- `PEAK-CLOSE TOTAL`: `+249.20`
- `WHAT ACTUALLY HAPPENED`: `+31.56`
- `DELTA`: `+217.64`

That apples-to-apples subset is:

- `APT`
- `ETH`
- `XPL`
- `BTC`
- `BLUR`

## Extended Actual-Loss View

If you also fold in the clearly documented extra losers that did not have a pinned positive peak:

- add `SOL = -6.50`
- add `AAVE #1 = -12.52`

Then the booked-result side drops from:

- `+31.56` down to `+12.54`

That pushes the gap versus the apples-to-apples realized base wider still, but it is no longer a perfectly apples-to-apples comparison because those trades do not have pinned positive-peak numbers.

## Plain-English Read

The cleanest hard-number answer is:

- the saved record supports at least about `+$291.54` of peak-close opportunity across the named trades with documented peaks
- on the strict apples-to-apples subset, peak-close would have been about `+$249.20`
- what actually got booked on that same pinned subset was about `+$31.56`
- so the proven captured-vs-available gap on the clean subset is about `+$217.64`

And if you fold in the clearly documented extra realized losers from `SOL` and `AAVE #1`, the booked side drops to about `+$12.54`, which makes the practical gap even uglier.

## Gaps Still Not Fully Reconstructed

- `SUI` actual realized exit
- `ORDI` actual realized exit
- `AAVE #2` exact net after fees

So the true final delta is not smaller than the hard-number minimum above unless one of the unresolved actual exits was materially positive. The hard record here points strongly in the other direction: the management layer captured far less than the available open profit.
