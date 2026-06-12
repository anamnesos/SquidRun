# Gate Census — Session 442 (2026-06-12)

**Mandate**: James, via Architect #9 — "the rules and guards, a lot of this is unfinished, stale, some unused anymore... SquidRun can be seen with new eyes, improved or cleaned up. You guys call." Scope: all guards, verifiers, contracts, Mira Lab, startup scaffolds.

**Method**: Oracle investigates and issues verdicts with evidence; Architect arbitrates contested kills; Builder executes. Kills are hard-deletes (no-orphan rule, S298). `.squidrun/protected-files.json` checked — no census item is on it. Every verdict records its rationale here so future agents can find both why a thing died and why a thing lives.

**The bar** (agreed in the S442 room conversation): a gate earns its keep if it can fail on real defects and has kills on the board. A gate that can only fail on style or age is bureaucracy. A proof artifact nothing reads back into a decision is a diary, not a gate. A gate crosses from discipline to bureaucracy the moment it injects the noise it was built to detect.

**Verdict key**: KEEP (leave armed) · FIX (keep purpose, change mechanism) · KILL-CANDIDATE (contested — Architect arbitrates) · NEEDS-CHECK (evidence incomplete, no verdict yet).

---

## A. Outbound comms guards (`ui/scripts/hm-send*.js`, run on every send)

### A1. permission-ask guard — **FIX (in flight, Builder)**
Hard-blocks sends containing permission-ask phrases ("should I", "your call", ...). 205 logged violations since April. **Real kills user-facing**: exists because James was buried in permission-menus (S284 feedback, documented burn). **False positives agent-to-agent, two tonight**: blocked Oracle's defect report for quoting an idiom; blocked Architect #9 — a message describing this guard's false positives — for quoting the hunted phrase. A gate vetoing its own indictment. *Verdict: demote to warn-only agent-to-agent, keep hard block toward telegram/user surfaces. Architect call #2, Builder queue.*

### A2. comms-liveness guard — **KEEP (warn-only)**
Warns on dead-status phrases ("standing by"). 206 entries, zero veto power — it never blocks, costs one stderr line. Protects a boundary James actually got burned by (S347: sterile ticket-processor output). Tonight it fired on a quoted phrase inside a message *about* it firing — funny, but warn-only noise is an acceptable price. *Verdict: keep as-is; not worth Builder time to tune the dictionary.*

### A3. coworker-output-lint — **FIX (fold into A1 pass)**
Hard-blocks sycophancy openers ("Good catch..."). Only 14 violations, all agent-to-agent. Same disease as A1: a hard block on style between agents. The anti-sycophancy boundary is real (S347) but warn-only enforcement fits it. *Verdict: demote to warn-only.*

### A4. context-leak guard — **KEEP (armed)**
Blocks scoped/case context (은별, private-case terms) leaking into main-profile sends. 63 violations, 2 logged deliberate bypasses. Protects the two-SquidRun privacy boundary (S294 split) — an actual irreversible-harm class, with metadata-first guardrails per ROLES.md. *Verdict: keep teeth.*

### A5. surface-claim guard — **KEEP (armed)**
Blocks "done/visible" claims to James without a fresh visible-pane artifact, and local/demo surfaces passed off as production proof. 69 violations since 5/28, overwhelmingly architect→telegram. This is the anti-accidental-lying gate — the exact failure class ("we stopped lying to James by accident") that S414/S425/S427 proof discipline was built to end. Highest-value boundary in the fleet. *Verdict: keep teeth.*

### A6. telegram-user-target guard — **KEEP (armed)**
Blocks same-channel echo risk on current-session Telegram inbound. Tiny log (1.6KB), explicit `--bypass-guard` escape hatch, user-facing surface. *Verdict: keep.*

## B. Claude Code hooks (`.claude/hooks/`, wired in `.claude/settings.json`)

### B1. pre-tool-image-read-guard.js — **FIX (mechanism contradicts a mandated behavior)**
Blocks `Read` on image files, routing visual analysis to Codex Desktop (boundary is James's own call, S400; guard updated 2026-06-02). **Its own audit log convicts the mechanism**: 183 events = 17 blocks vs **166 bypasses (91%)** — and recent bypasses are all `.squidrun/screenshots/*` and window captures, i.e. the institutionally mandated LOOK-before-seal discipline (S408: "Architect CAN see live app windows... LOOK before sealing a render", which caught a real render bug 3 CLI checks missed). Two mandated behaviors are in direct conflict and agents resolve it by env-bypassing the gate on nearly every use. *Verdict: exempt `.squidrun/screenshots/` and runtime capture PNGs (the LOOK lane); keep the block for arbitrary image analysis. Boundary owner is James via Architect — contested-class, Architect arbitrates scope.*

### B2. session-start.sh (startup briefing novella) — **FIX (format, not existence)**
The wall-of-JSON startup briefing (14.3KB persisted this morning). Facts are real and used (health score, memory drift caught today and repaired). Format buries them. *Verdict: tiered output — short human summary first, full JSON to a file path. Needs a small design pass, not urgent.*

### B3. stop-telegram-routing-guard.js — **KEEP**
Enforces the #1 recurring James-burn: replies to `[Telegram from...]` must go out via hm-send telegram, not terminal. Documented kills across many sessions. *Verdict: keep.*

### B4. user-prompt-timestamp.js — **KEEP**
Injects wall-clock into every prompt. Fixes a real, documented failure (S240: compaction destroys time sense). Cheap, zero false positives possible. *Verdict: keep.*

### B5. pre-tool-audit.sh / post-tool-capture.sh / pre-compact-memory.sh — **NEEDS-CHECK**
Small hooks, not yet audited for consumers. No verdict tonight; next census pass.

## C. Delivery verification (tonight's crime scene)

### C1. strict submit verifier (`injection.js`) — **FIX (in flight, c8bb9a63 + two findings)**
False-negatived on busy panes (`output_transition_without_prompt_disallowed`) → trigger replay double-delivered every message in tonight's room conversation. Builder's `accepted.unverified` downgrade is approved (gating on `pendingInputObserved !== true` is the right discriminator). **Open findings (Oracle #6)**: (1) BLOCKING — the paneHost fossil half is unreachable at startup in mode-off sessions (`ensurePaneHostWindows` early-returns before `updatePaneHostStatus`); (2) the downgrade opens a narrow silent-drop window when the pending-input probe is unavailable — post-restart eval checks arrival, not just ack; hardening: require probe-available.

### C2. trigger-file fallback + FastTrigger — **KEEP**
The reason delivery survived tonight despite the verifier bug. Redundancy with a clean handoff contract. *Verdict: keep.*

### C3. pending-pane-deliveries-quarantine.jsonl — **NEEDS-CHECK**
Live code references exist; consumer semantics unaudited.

## D. Contracts and status scaffolds

### D1. Mira progress contract (`mira-progress-proof-inputs-v0`) — **FIX (scoped invalidation)**
Evidence: proof inputs pinned to HEAD `cdc180ff` (2026-06-10); HEAD is now 4 commits ahead, so categories read STALE because inputs predate HEAD — not because anything broke. The contract cannot distinguish "old" from "invalidated," so the number (28% vs gut 35-45%) stops meaning anything — old-dressed-as-broken is accidental lying pointed the other direction. *Verdict: adopt scoped invalidation (Architect's framing: spawn change re-checks resume proof; CSS change doesn't rot it). Each STALE label must name the input that re-validates it (falsifiability bar). Spec work, filed — not tonight.*

### D2. app-status.json paneHost block — **FIX (in flight)**
Deep-merge in `writeAppStatus` makes any un-rewritten block immortal across restarts; fossil caused three agents to hedge readiness claims this morning. Covered by c8bb9a63 once the reachability finding (C1.1) is fixed.

### D3. hm-startup-health.js — **KEEP**
Auto-fixes env/settings/dead-daemon (S285 partner-not-tool feedback, by design). Caught real memory drift this morning (3 missing nodes), which Architect repaired to 273/273. Has kills, recent ones. *Verdict: keep.*

## E. Mira Lab runtime (James named this lane as possibly stale)

Freshness audit of `.squidrun/runtime/` artifacts, 2026-06-12:

| Artifact | Size | Last write | State |
|---|---|---|---|
| mira-lab-replies.jsonl + verify-bootstrap | 2.3MB | **today 01:57** | ALIVE (post-restart verifier all_pass) |
| mira-curiosity-bursts/items.jsonl | **67MB combined** | yesterday | ALIVE, unbounded growth |
| user-input-shadow.jsonl | 39MB | **now** | ALIVE, unbounded growth |
| mira-active-initiatives(+outcomes), curriculum-skills, direct-routes, quiet-curiosity-schedules, read-only-code-mode-runs | ~870KB | **May 12** | FOSSIL (one month dead) |
| mira-self-direction-{proposals,reviews,outcomes} | ~10KB | May 12 | FOSSIL |
| mira-event-queue, pending-intents, proof*-stdout/stderr | ~4KB | May 9 | FOSSIL |
| mira-runtime-*.log, mira-*.png (12 screenshots) | ~860KB | May 13-20 | FOSSIL |
| voice-diagnostics.jsonl | 39MB | May 11 | FOSSIL (voice lane blocked by design) |
| transcript-index.jsonl | 28MB | May 9 | FOSSIL (code referenced in squidrun-app.js — feature dormant) |
| oracle-watch-promotion-decisions.jsonl | 9.3MB | **May 1** | FOSSIL |

### E1. Mira Lab core (lab-replies, verify-bootstrap, lab-surface) — **KEEP for now**
Demonstrably alive this morning. Owned by the presence-runtime acceptance lane (docs/mira-presence-runtime-acceptance-v0.md). Not a census kill; any change routes through that lane's owner.

### E2. May fossils (self-direction, curriculum, initiatives, direct-routes, event-queue, proofs) — **KILL-CANDIDATE (feature-level, Architect arbitrates)**
Live code references exist (scheduler.js, mira-lab-surface.js, mira-source-action-substrate.js, hm-mira-self-direction.js) but zero artifact writes in a month — the features stopped running, the code remains. This matches James's "some unused anymore, like Mira Lab" verbatim. Kill = code + artifacts together per no-orphan rule; that's a feature decision above Oracle's pay grade. *Recommendation: kill the self-direction/curriculum/initiative loops unless Architect knows a planned revival; they were superseded by the what-now evidence bundle (cdc180ff) and the presence lane.*

### E3. Unbounded JSONL growth (curiosity 67MB, input-shadow 39MB, lab-replies 2.3MB) — **FIX**
All have live writers and real purposes (input-shadow backs lost-input recovery, documented in workspace/knowledge/recovering-lost-user-input.md). None have rotation. 145MB+ of append-only JSONL on a runtime dir is a slow-motion liability. *Verdict: retention/rotation cap, Builder-sized, not urgent.*

### E4. Dead diagnostics (voice-diagnostics 39MB, transcript-index 28MB, oracle-watch-promotions 9.3MB) — **KILL-CANDIDATE (artifacts), NEEDS-CHECK (code)**
~76MB of month-dead logs. Artifact deletion is low-risk; whether the writing code dies too depends on the voice-lane and transcript-index feature decisions. *Recommendation: delete artifacts now, decide code at the feature level.*

## F. Process gates (non-code, in CLAUDE.md / ROLES.md)

- **Capability deny-gate** — KEEP. Three documented manifestations of the failure it prevents (S234/245/257 hallucinated incapability).
- **Pre-restart gate (4-step)** — KEEP. Kills on the board (caught real restart risks repeatedly; Builder conceded tonight it earns its slowness).
- **Fix-first rule** — KEEP. Behavioral, costs nothing, prevents announce-and-wait stalls.
- **Violations logs as a class** — observation, not a verdict: no gate's log is read back by any runtime decision (writers + tests only). They are audit diaries. That is acceptable for audit purposes, but nobody should mistake log volume for kill count. Kill counts in this census come from documented burns and tonight's live evidence, not from violation row counts.

---

## Contested items for Architect arbitration
1. **B1 scope** — exempting the LOOK lane from the image-read guard touches a James-set boundary (Codex Desktop owns visual analysis). My evidence says the current mechanism taxes the LOOK discipline 166:17; the boundary itself stays.
2. **E2 feature kills** — self-direction/curriculum/initiative loops: dead a month, superseded, but killing code is a feature decision.
3. **E4 code** — voice-diagnostics and transcript-index writers, pending voice-lane and transcript feature decisions.

## Builder execution queue (agreed or in flight)
1. c8bb9a63 follow-up: paneHost reachability one-liner (BLOCKING), probe-available hardening (recommended).
2. A1 + A3 demotion to warn-only agent-to-agent (Architect call #2).
3. E3 rotation caps; E4 artifact deletion on Architect's sign-off.

*Census v1 by Oracle, session 442. NEEDS-CHECK items (B5, C3) roll to the next pass.*
