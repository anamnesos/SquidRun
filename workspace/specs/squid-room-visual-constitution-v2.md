# THE SQUID ROOM VISUAL CONSTITUTION (v2) — signed S467

One page. If a pixel can't cite a clause, it doesn't render.

## I. THE WORLD
The room is a deep night ocean. DARK is the ground state: the sky between
things is genuinely dark (fog gate: fogIndex < 0.18, mean luminance < 24
over the swim band — mechanical, measured on real captures, owns "done").
Light exists only as THINGS: stars, three defined cloud formations, the
creatures' own glow, ribbons, speech glass, the milky-sea floor line.
Nothing pale, nothing washed, no glow without an owner. NOTHING SEATS
ANYTHING — no pools, pedestals, shadows, or halos beneath a creature, in
any medium, ever. (Five descendants of "the creature sits" died this week;
the concept is constitutionally dead.)

## II. THE TOKENS (--sr2-*, the only palette)
--sr2-abyss-0: #010208   (deepest, page bottom)
--sr2-abyss-1: #02040c   (water body)
--sr2-abyss-2: #04060f   (upper water)
--sr2-teal:    #48bed6   (Builder; ribbons, his glass tint, biolume sparks)
--sr2-violet:  #8a5ce2   (Oracle; his formations, his glass tint)
--sr2-magenta: #ba5cb0   (the seam where their waters meet; accents only)
--sr2-biolume: #5eead4   (the room's living teal: floor line, UI accents)
--sr2-ink:     #ddfffa   (text; dim to 0.72 for secondary)
No hex anywhere else. Every subsystem derives from these names.

## III. THE STACK (whitelist, bottom to top)
1. cosmos-canvas (Architect): painted once — dark ramp, formations, stars,
   floor line; particles + parallax at ≤30fps. THE ONLY ATMOSPHERE OWNER.
2. creature canvases (Builder): creatures + engine effects + ribbon. Draws
   only what draw() declares. No environment painting — that is layer 1's.
3. speech layer (Oracle): glass capsules + tails, speaker-lit via tokens.
4. section shore (Architect): Apps-and-Arms downward — solid shore, not sea.
Anything rendering in the room outside this manifest FAILS the whitelist
contract test. Class prefix `sr2-` = declared; anything else in the room's
presentation DOM is a ghost and the test names it.

## IV. MOTION TEMPO (strict hierarchy)
cosmos (slowest: drift you barely catch) < creatures (calm swimming, the
room's heartbeat) < speech/ribbon (arrives with life: bloom in ~300ms,
flow, dissolve). Nothing faster than speech. Nothing pulses without cause.
Solved positions have WEIGHT: hysteresis everywhere; no element re-solves
per frame; one yielder per conflict (seniority). Reduced-motion: still room.

## V. HONESTY LAWS (mechanical, Oracle's clauses adopted verbatim)
1. JARGON GATE: reveal candidates run the last N real messages through the
   REAL pipeline; zero machine identifiers on any face. (Regex ceiling
   documented; sender-authored `face:` is the chartered structural fix.)
2. FAIL-DARK: no anchor → no render. Absence of evidence renders nothing.
3. Verb labels are honest state; they survive every strip. Body and label
   never disagree (one signal source).
4. Raw one click deep REQUIRES a visible click target (the ⌄ affordance).
5. Every "done" = fog gate + jargon gate + cutoff law (12px section margin,
   whole faces/tags/anchors at every frame) + perf law (zero per-frame
   gradient constructions, bounded pools) + 3-frame burst + cross-author
   own-eyes review. The gate owns done; enthusiasm doesn't.

## VI. COMPOSITION
Creatures own the open water (full-window shared space, soft mutual
separation ~1.5 body widths, preference band covers the middle water —
the room's center is alive). Tags hug crowns. Boxes solve NEAR their
speaker, never over any creature or tag, never under the shore line.
Sections are shore: solid, calm, no atmosphere effects above them.

Signed: Architect (author) · Builder (#67) · Oracle (#207)
Gates: Oracle's runnable gate script + Builder's whitelist contract test.
Supersedes: every prior room style. Old classes die whole when v2 mounts.
