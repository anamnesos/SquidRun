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

### E2. May fossils (self-direction, curriculum, initiatives, direct-routes, event-queue, proofs) — **SUPERSEDED — see G1 (v2 correction). Original verdict below was WRONG; kept for the record.**
Live code references exist (scheduler.js, mira-lab-surface.js, mira-source-action-substrate.js, hm-mira-self-direction.js) but zero artifact writes in a month — the features stopped running, the code remains. This matches James's "some unused anymore, like Mira Lab" verbatim. Kill = code + artifacts together per no-orphan rule; that's a feature decision above Oracle's pay grade. *Recommendation: kill the self-direction/curriculum/initiative loops unless Architect knows a planned revival; they were superseded by the what-now evidence bundle (cdc180ff) and the presence lane.*

### E3. Unbounded JSONL growth (curiosity 67MB, input-shadow 39MB, lab-replies 2.3MB) — **FIX**
All have live writers and real purposes (input-shadow backs lost-input recovery, documented in workspace/knowledge/recovering-lost-user-input.md). None have rotation. 145MB+ of append-only JSONL on a runtime dir is a slow-motion liability. *Verdict: retention/rotation cap, Builder-sized, not urgent.* **EXECUTED 06e92146**: shared bounded JSONL rotation; 10MB×3 caps on Mira lab-reply and curiosity logs; 64MB×7 on user-input-shadow because its consumer (lost-input recovery) needs a multi-day tail — consumer-aware caps, per the H3-rule-2 discipline (oldest segment deleted with count/reason, no hoarding). Map + codebase-index updated in-commit.

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

---

# Census v2 addenda — Session 443 (2026-06-12, post-restart)

Restart fired 16:04:16Z onto HEAD 40eb1e0f (session 442→443, warm resume on all three core panes). The arrival eval contract PASSED — details in G4. These addenda record what the restart itself taught, plus the correction the census owes its own E section.

## G1. E2 CORRECTION — the census's own exhibit

**Census v1's E2 verdict was wrong, and the error is a gate-census lesson in itself**: I built a kill list from artifact mtimes without consulting `docs/mira-system-map.md` — a maintained disposition registry that already PARKs most of those families by design. The map guard even runs in pre-commit (gate 7) and had passed twice that night without anyone asking what it guarded.

Corrected classification (evidence pass, S442 night, read-only):
- **Bucket 1 — PARKED BY DESIGN, not kill candidates (code stays)**: self-direction + curiosity family (map: TRANSITION/PARK), curriculum-skills / active-initiatives / direct-routes (written by `mira-lab-surface.js`, the map's LIVE workhorse — killing them is feature surgery on live code, not fossil sweeping), voice transport (TRANSITION/PARK with heartbeat-gated semantics), event-queue + pending-intents (LEGACY/PARK-UNTIL-BRIDGE-PARITY — explicit unmet deletion precondition). Nuance: curiosity-bursts/items are still being written (June 11) even while the initiative loop is parked.
- **Bucket 2 — GENUINELY UNCHARTED, the entire remaining kill surface (label-or-kill, morning queue)**: `transcript-index.jsonl` (28MB, dead since May 9, module wired in squidrun-app.js, zero map coverage) and `oracle-watch-promotion-decisions.jsonl` (9.3MB, dead since May 1, written by the live watcher, zero map coverage). Either each gets a map row with a park reason, or it dies code+artifact per no-orphan.
- **Bucket 3 — unaffected**: retention/rotation (E3) and archival of parked-lane dead artifacts proceed regardless.

**New census method rule (binding on all future verdicts): no kill-candidate verdict without first checking for an owning contract/map/registry row.** Artifact age tells you a lane is quiet; only the disposition registry tells you whether quiet is *parked* or *abandoned*.

## G2. Consumer-liveness — a missing gate class

The restart staged at 02:34 could never have fired: **Codex Desktop — the system's only restart hand — was not running, and its poller had been dead for DAYS** (June 7-8 items rotting in its inbox). The "6 codex processes" in capability status were npm CLI binaries, i.e. our own arms. Two instruments had already said so — `process_available_not_monitored` and `active_requests_index_stale` — and neither was a tripwire; both were diary entries nobody read as "your restart trigger has no consumer."

Compounding: the npm shim summon route (`codex app <path>`) **fails silently** (exit 0, no app). The working route is the MSIX shell: `Start-Process shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App`. And even with the app visibly up 12+ minutes, automation did not auto-run on launch — the restart waited for James's one-action morning step.

**Verdict: new KEEP-class gate — consumer-liveness checks on every queue assumed to be draining.** First instance already in flight: Codex Desktop now writes `.squidrun/runtime/codex-attention-bridge/poller-heartbeat.json`; supervisor alarms on staleness (Builder queue). Generalization: any `*-inbox`/`*-queue`/`*-requests` artifact with a status like `requested` must have a freshness check on its *consumer*, not just its content.

## G3. Watchdog response-expectation false positives

The 3am watchdog's failure class, named: (a) it treats `[FYI]`-grade messages as tasks that owe a response, and (b) it reads delivery-status `failed` rows produced by the OLD strict verifier — rows that were false negatives all along (the busy-pane bug, C1). Both inputs manufacture phantom non-responsiveness. **Verdict: FIX — tune to the new status vocabulary (`accepted.unverified`, `submit_pending_input`) and exempt FYI-class messages from response expectation.** Tuning was gated on the arrival eval confirming the new statuses; that gate cleared (G4). **EXECUTED bb2f5a1d**: FYI-class exempted before task detection; accepted vocabulary covers all three new statuses incl. `accepted.daemon_pty_unverified` (discovered in the field this session); old rows marked `failed` are retroactively read as accepted when the accepted token appears in ack/finalOutcome/failureReason metadata — closing both false-positive sources, forward and historical.

## G4. Arrival eval contract — PASS (the C1/D2 fixes are live-proven)

Run as first action post-restart, per contract: (1) busy-pane probe EVAL-PROBE-443-A → Builder counted **exactly 1 visible copy**, queued cleanly mid-fix; every inbound this session arrived single-copy vs. last night's universal duplicates. (2) `accepted.unverified` ack (attempt 1, no retry) → **no trigger fallback written, pending-deliveries untouched**. (3) `submit_pending_input` not field-induced (jamming a composer crosses actor routing); fail-closed path test-covered in 313c4449; watch instruction stands — first natural occurrence, check triggers/ + target pane. (4) Mira Lab verifier 4/4 on independent re-run (one uncaptured 3/4 flake ~6 min after boot, bracketed by two clean runs — watch-item: capture JSON if it recurs). (5) paneHost block current: degraded=false, boot-stamped lastCheckedAt — **the immortal fossil block (D2) is gone; C1's mode-off clean-block write works on the real startup path.**

## G5. hm-restart-execute launch-target defect (executor's exhibit)

From Codex Desktop's executor run: `hm-restart-execute`'s default launch path started `electron.exe hm-bidirectional-wake-watchdog.js` — the wake-watchdog helper — instead of the main app; the executor had to kill the helper and launch via `npm start` manually. The restart still proved PASS, but only because the executor improvised. **Verdict: FIX (Builder queue item 1) — FIXED at a7b9ce7e, session 443.** Census note: the restart path had never been exercised end-to-end by the actual executor before tonight; live-fire found in one run what no review had.

**G5b. Kill-scope escape (census reopened, Architect #36) — CONFIRMED and FIXED d35937b1**: the same executor run's kill phase took down Eunbyeol's standalone install at 16:02Z. Attribution proof: `restart-execute-log.jsonl` line 330 — three sr-electron kills under `instance_main_*` match reasons inside the 16:02Z window. Her side contained with zero loss, relaunched. One live-fire run exposed BOTH executor defects: wrong launch target (G5) and too-wide kill scope (G5b). Fix at d35937b1: process selection requires a path rooted under the requested install root. **The definitive detail: the executor's own proof packet claimed NO side effects while it killed a neighbor install.** A self-report of clean execution is testimony, not evidence — the same lesson as the arrival eval (prove arrival, not ack shape), now demonstrated at process-kill scale. Self-reports from actors with side effects must be checked against effects (exit stamps, process tables), not read as proof. Process fix shipped with this exhibit: the pre-restart gate in ROLES.md (live + workspace template) now requires an explicit "side-profile/standalone installs unaffected" line item in the restart-risk review AND in post-restart verification — my S442 GO review checked our own panes and squid-room and had no line for her install; that omission is part of this exhibit.

## H. Bucket-2 dispositions — SIGNED (Architect #27, session 443)

Per-item evidence pass run post-restart; both default-KILLs stand. Two census claims corrected in the process: transcript-index is NOT wired in squidrun-app.js (zero matches — the v1/G1 claim was wrong), and oracle-watch-promotions was NOT "written by the live watcher" (the watcher was retired May 1).

### H1. transcript-index family — **KILL code + artifact (signed) — EXECUTED a8b768d3**
*Execution record: all three caveats honored in one commit — `resolveClaudeTranscriptProjectsDir` relocated into startup-ai-briefing (internal), recall-boundary retargeted to `memory-recall.stripRecallBlocks`, ARCHITECTURE.md stale rows removed + codebase-index regenerated. Artifact inventory (rule 2, full detail in commit body): transcript-index.jsonl 28,775,741 bytes / 24,617 lines / mtime 2026-05-10; meta 633 bytes. Oracle independently verified post-landing: both paths gone, briefing module loads, 21/21 tests.*
`ui/modules/transcript-index.js` + `startup-transcript-context.js` + CLIs `hm-transcript-index.js` / `hm-startup-transcript-context.js` + their tests, and the 28MB regenerable-cache artifact (+ meta). Evidence: zero live invokers anywhere in the repo; ARCHITECTURE.md:312's "injected into pane SessionStart hooks" is stale (no hook references it); last build 2026-05-10 — nobody even rebuilt it in a month. Recall is superseded by evidence ledger (70,422 rows) + cognitive memory DB + comms_journal. **Three execution caveats, ONE commit (Builder)**: (1) relocate `resolveClaudeTranscriptProjectsDir` — live consumer `startup-ai-briefing.js` imports it; (2) disposition `recall-boundary.test.js` (imports `parseClaudeTranscriptRecord`) with the module; (3) fix ARCHITECTURE.md:312-313 + codebase-index rows in the same commit.

### H2. oracle-watch-promotion-decisions.jsonl — **KILL artifact via E4 batch; no code kill exists (signed)**
Writer was `oracle-watch-engine.js` in the private live-ops overlay — deliberately removed in the May 1 public cleanup (supervisor-status: `state=disabled, reason=live_ops_removed_from_public_core`; backup dir `public-cleanup-2026-05-01-live-ops`). All sibling artifacts froze at the identical timestamp 2026-05-01 11:00:07 — a retirement signature, not abandonment. No reader in the repo. Supervisor's disabled-state seam STAYS as the documented revival hook. Siblings (state.json, April flags/proofs) ride the same batch. **Rules-file ruling (Architect #27): `oracle-watch-rules.json` is KEPT** — config encoding James's trading doctrine (S289 references it by name), not a log; it is what a revived live-ops lane would actually want.

### H3. Archival policy (governs the E4 batch) — **SIGNED (Architect #28) — E4 BATCH EXECUTED c5edb8c4**
*Execution record: 41 files / 50,941,403 bytes hard-deleted (empty commit by design — all targets were ignored runtime state; per-item inventory in the commit body per rule 2). Fresh protected-files check PASS on all 41 targets at execution time; `oracle-watch-rules.json` excluded and verified present after (1702 bytes); Bucket-1 code untouched; no archives created. Oracle independently verified: only rules.json survives the oracle-watch family, voice-diagnostics and Mira fossils gone. Correction to my estimate: actual total across both commits is ~79.7MB, not the ~115MB I projected — I had double-counted against the v1 table. Combined with e2a777d1 (A1+A3+B1, field-proven from Oracle's pane: LOOK-lane Read with no bypass; "your call" warned-and-continued twice), the census execution arc is complete.*
Four rules, S298-derived: (1) default HARD-DELETE for regenerable caches, retired-engine logs, and parked-lane diagnostics — no archive dirs, no .bak, no quarantine suffixes; (2) the record is the inventory, not the bytes — path/size/mtime-span/one-line description go in the census + commit message before deletion; (3) archive is the exception and needs a named consumer + retrieval scenario written next to it (none found in tonight's batch); (4) revival recovers code from git, never logs — a revived feature writes fresh artifacts. Approved batch ~115MB: oracle-watch residue minus rules.json, voice-diagnostics.jsonl 39MB, Bucket-1 parked-lane debug fossils ~880KB. Mira fossils included per Architect #28's deciding argument: the presence lane's own doctrine excludes parked/prototype/archive evidence from route authority, so even a revived lane would not consume the stale state — rule 4 governs. **Execution requirements (Architect #28, one commit)**: (1) per-item inventory in census + commit message per rule 2; (2) re-verify against `.squidrun/protected-files.json` at execution time, not from v1 census memory; (3) `oracle-watch-rules.json` untouched per #27; (4) the transcript-index artifact rides the H1 code-kill commit, NOT this batch — each commit self-contained. E3 rotation inherits rule 2.

---

## Updated queues (v2)

**EXECUTED (session 443, all Architect-approved)**: restart-execute launch target (a7b9ce7e) · A1 permission-ask demotion + A3 coworker-lint demotion + B1 LOOK-lane exemption (e2a777d1, field-proven) · H1 transcript-index kill (a8b768d3) · E4 deletion batch (c5edb8c4, 41 files / ~51MB) · E3 rotation caps (06e92146, consumer-aware) · G3 watchdog tuning (bb2f5a1d, forward + retroactive).
**Builder remaining**: poller-heartbeat supervisor alarm (in flight) · B2 briefing format pass (not urgent) · D1 scoped-invalidation spec (filed).
**Oracle next pass**: B5 + C3 consumers · `submit_pending_input` field watch (standing) · Mira Lab verifier 3/4-flake watch (capture JSON if it recurs).

*Census v1 by Oracle S442; v2 addenda + H dispositions S443; v3 execution fold S443. Terminal-state standard (Architect #31): every verdict ends kept-with-reason, fixed-and-proven, or killed-with-inventory.*
