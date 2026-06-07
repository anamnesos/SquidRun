# Squid Room — Canonical Spec (James's definition, source of truth)

> This is the TEAM-CANONICAL Squid Room spec, in the repo so Architect, Builder, Oracle, and Codex all read the SAME thing. Build to THIS, not to `docs/trustquote-arm-set-proposal.md` (that doc is the thing that DRIFTED). Do not re-derive from code. Do not make James re-explain it — he has defined it 3+ times across restarts.

## James's definition (verbatim anchors, S406 / 2026-06-06, comms_journal rows 67994 / 68001)
- "make a UI FIRST.. a mental map for a user and me" — UI-first, not infra-first.
- **MIRA/Architect = a separate pane.** The user talks ONLY to Mira.
- **SQUID ROOM = a separate window** containing: Builder + Oracle at the top (the squidrun-working arms), then an **ARMS** section with expandable per-app sections (TrustQuote, "whatever app they use"), each section with a **Lead**.
- **Arms are LIVING CLI agents.** On start, arms report to their **Lead**, not Mira; the Lead checks in with Mira after all arms report. Missing-arm protocol: wait 2 real-world min, message again, wait 2 more, then report to Mira.
- "Mira always knows how many arms she has and what they do" WITHOUT holding every app detail — the Lead holds workflow knowledge/notes, verifies/reviews.
- Sketch: `.squidrun/screenshots/screenshot-1780781734126.png` (left MIRA/Architect, right SQUID ROOM, Builder/Oracle top, ARMS band, TrustQuote expanded with Lead + schedule-dispatch + trustquote-app + invoice arm, "arms count 4", user↔Mira).

## S408 clarifications (2026-06-07 — do NOT make him say these again)
1. **ONE Builder + ONE Oracle.** NOT replicated. The Squid Room is NOT a copy of the main window. The same Builder/Oracle just RENDER in the Squid Room window. He does not want them duplicated on the main side.
2. **No "alive" status light.** You cannot tell a CLI agent is alive from a dot. Aliveness is known two ways only: he SEES the pane rendered, and the LEAD reports in. A status light is scoreboard bullshit — scrap it.
3. **Expand = the CONTAINER holding Builder+Oracle expands/collapses as ONE unit**, not per-pane. Current per-pane expand is BROKEN (expand one pane, the other disappears). Kill the bug.
4. **Arms = REAL CLI panes/terminals** (spawn 3 for TrustQuote, like Builder/Oracle, with roles), grouped in **expandable per-app sections** so 5 apps ≠ 20 visible panes.
5. **The desired/ready/missing 3-column counter is WRONG** — jargon in the UI he banned. His sketch said "arms count 4" — ONE number. The 3-way counter only exists because the arms are placeholders (scoreboard-not-players); real arms collapse it to a single count.
6. Deliverable bar: **real CLI agent panes rendering live in the Squid Room window, NO app restart.** Stop showing UI with no agents in it.

## Drift trace (Architect + Oracle independently agreed, S408)
- Team built the registry/projection/DISPLAY slice — a scoreboard — not the living room. `arm_checkin_proofs` / `arm_missing_watchdogs` tables exist with 0 rows; nothing ever spawned or checked in.
- His 4 concrete arms got abstracted+shrunk to 3 fuzzy "domains" (Lead / Work+Schedule / Money+Documents) via `docs/trustquote-arm-set-proposal.md`. Team vocabulary replaced his.
- **Lock-in moment = comms_journal row 68024:** a prior-session Architect greenlit building "the FOUNDATION — durable ARM REGISTRY / lead manifest" first. That inverted his explicit "make a UI first" into "build infra first."

## Honest verdict
The 408 SEALED-LIVE gate is valid ONLY for the narrow registry/projection display slice. It is NOT "the Squid Room James asked for." The registry is usable plumbing but upside-down in priority vs his UI-first / living-arms intent. Claiming his original intent is satisfied = soft-pass.
