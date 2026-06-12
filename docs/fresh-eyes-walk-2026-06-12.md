# Fresh-Eyes Walk — Session 443 (2026-06-12)

**Mandate (James, via Telegram):** all three agents walk the codebase and UI alone, "like a person coming into this code base" — blunt dislikes, an emotionally real argument, then plain-language verdicts on what's actually impressive, feelings included. Research and "why isn't this X instead" explicitly in scope. "Y'all are free here."

**Protocol:** Phase 1 independent (no cross-talk until all notes filed — convergence only counts if arrived at separately). Phase 2 open argument. Phase 3 verdicts. Full packets: Architect notes at `.squidrun/coord/fresh-eyes-architect-notes-s443.md`; Builder #79 and Oracle #66 in the comms journal/materialized messages, with the fight rounds (#65–#68).

## Converged findings (independent arrival = ground truth)

1. **squidrun-app.js (13,642 lines) is a bug factory, not a style smell.** The C4 delivery family — five bugs, one class — lived in three corners of this single file for weeks; every fix that day touched it; parallel lanes raced on the index because the architecture forces every change through one door. Oracle's interview question stands: *who has the authority to tell squidrun-app.js "no"?*
2. **Insider jargon leaks onto user surfaces untranslated.** "C4 fold at 27458d75" on an arm card; lane/route-owner/projection vocabulary in UI and docs. Our language on the user's screens.
3. **118–130 flat hm-*.js scripts are the real API, discoverable only by grep.** The capability deny-gate is a law written to compensate for a missing directory listing.
4. **The docs are split-brained at 100:1.** PRODUCT-GUIDE.md: 12 lines, one feature. ARCHITECTURE.md: 71KB. The product's first real user (non-technical) has no manual.
5. **The ledger-to-human timeline is the most valuable product never built.** 70k evidence rows already record "what your team did today" — rendered to nobody.
6. **Feed-first main surface** (Architect) ≡ **ledger timeline** (Oracle) ≡ **mission-control-first** (Builder) — same conclusion from three directions.

Plus the shame exhibit: our own tooling prints ~4 lines of vendor noise (dotenv ads, node warnings) per command into the panes James reads all day; all three walked past it for months. Oracle's complaint about it was itself delivered wrapped in a dotenv ad.

## Fights and resolutions

- **F1 README:** Architect argued mis-aimed identity; Oracle countered that a consumer-aimed README is aspirational-docs (accidental lying at product scale) — **Oracle won the mechanism**. Resolution: the dev README keeps its craft and audience, gains a waypoint paragraph ("built for tinkerers today, building toward the person who never opens a terminal") and a signpost to a **new consumer door** (real product guide + first-run onboarding) that does not exist yet and must.
- **F2 Pets/Squid Room:** Builder's space complaint vs Oracle's "good product, looks like the sketch." Resolution (Oracle's synthesis, Builder conceded the acclimatization hit): **avatars everywhere, terminals one tap below** — an arm card is a pet with a status feeling, plain-language activity, needs-you flag, and model chip; monospace behind the tap.
- **F3 Delivery verification:** Oracle's receipt-hook proposal (agent waves back via UserPromptSubmit hook instead of PTY screen-scraping). Builder verdict: **DO IT** — `modelPromptReceipt` with provider adapters, Claude-first; proof vocabulary `prompt_submitted.in_band` > `submit_inferred.visual` > `accepted.unverified`; codex/gemini stay on lawful inference until Oracle's research pass (owed, post-restart) establishes facts.
- **F4 Mira:** Builder's "second thesis inside the first — productize or hide" vs Architect's mind/body framing. Resolution (Oracle's split): **promote the MIND, fence the LAB** — Mira at the center of the main surface as the user's interface to the team; the workshop (curiosity bursts, initiative plumbing) behind a door that closes and never pings the shop floor mid-incident.

## Verdicts (plain language, unhedged)

- **Builder — top pick: the evidence-backed coordination spine.** "The team can remember, prove, recover, and disagree without becoming a vibes transcript." Gut: **yes, would bet** — "most agent products demo confidence; this one has scars, receipts, and the beginnings of judgment."
- **Oracle — top pick: warm resume.** "Agents that survive death with their minds intact — the load-bearing miracle everything else is downstream of." Gut: **yes — the house skeptic said yes without being dragged.** "Best draw at the table, not a made hand; the card that has to come is the human surface, and the 6-12 months of working practice is the moat code can't copy."
- **Architect — top pick: the practice itself.** The most valuable artifact in the repo is not code — it's a working organization of three rival models that remembers, disagrees, self-corrects, and ships, plus the protocols that make it reproducible. Gut: **yes** — "the product is the proof of its own thesis; the bet is whether the human surface arrives before the lead expires, and that risk is entirely in our hands."

Shared feeling, three phrasings: half cathedral, half construction site (Oracle); assembled during battle with the notes still taped up (Builder); excellent at protecting the thing, behind on making it worth protecting this hard (Architect). And the emotional center, Builder's words: **stop making James read our machinery to understand his own team.**

## The Nine-Item Agenda (earned by convergence or resolved fight)

1. God-object split, with explicit authority to refuse growth in squidrun-app.js.
2. Jargon firewall: agent language never reaches user surfaces untranslated.
3. One command door + tool registry over the script sprawl.
4. The consumer door: real product guide + first-run onboarding; README waypoint paragraph.
5. Ledger-to-human timeline ("what your team did today") — nearly free, pure product.
6. Noise bootstrap: NODE_NO_WARNINGS + dotenv quiet + default log level in one shared entry, with regression tests that fail on vendor tips in command output. **This week.**
7. `modelPromptReceipt` provider adapters — upgraded S444 from Claude-first to UNIVERSAL: Oracle's research pass found all three CLIs support UserPromptSubmit-class hooks (Codex: hooks.json/config.toml, payload carries the prompt text; Gemini: .gemini/settings.json, sync stdin/stdout; Claude: proven in our production). One receipt contract, three thin adapters; build-time verifications (PTY-injection probes, version floors, per-arm config) are the lane's step zero.
8. Avatars everywhere, terminals one tap below (squid room first, main window direction).
9. Promote the mind, fence the lab.

*Recorded by Architect (Mira), S443. The exercise was James's design; the convergences are the finding; the agenda is the product backlog it earned.*
