# Backlog Execution Plan — #6 / #7 / front-door promotion (Oracle, S446)

Code-verified plan for the rest of the converged backlog, drafted in parallel with #5. Every item cites the actual code I read. Right-sized per M1: concrete enough to execute, not a re-architecture. Where an item's real work is an *audit*, I say so rather than pretend I've finished it.

---

## #6a — FENCE THE LAB (stop curiosity bursts pinging the shop floor mid-incident)

**Code state (verified):** the burst is a scheduled job in `ui/modules/scheduler.js` — `QUIET_CURIOSITY_SCHEDULE_ID = 'mira-quiet-curiosity-burst-v1'` (L26), running `node ui/scripts/hm-mira-self-direction.js curiosity-burst --source <...> --route-interesting --json` (L347), taskType `mira-curiosity-burst`. The `--route-interesting` flag is the leak: it hm-sends "interesting" findings to working panes (this is the `MIRA CURIOSITY BURST` that hit Builder mid-incident).

**The fence (the door that closes):** curiosity bursts may WRITE to the lab (the curiosity jsonl) but must NOT unsolicited-hm-send to a working pane. Two options, recommend (a):
- (a) Drop `--route-interesting` from the scheduled command → bursts write to the lab only; agents read the lab when idle. Smallest change, fully closes the shop-floor ping. One-line scheduler edit.
- (b) Keep routing but gate it: only route to a pane whose state is IDLE (the watcher state machine in `watcher.js` tracks pane states — `States.IDLE`), and suppress entirely during an active incident. More code, softer fence.
**Acceptance:** after the change, a forced curiosity burst produces a lab write and ZERO pane hm-send. **Effort:** ~30 min (a). **Risk:** low. **Owner:** Builder (scheduler is app code); I gate the no-pane-send.

## #6b — FINISH codex/gemini RECEIPT ADAPTERS

**Code state (verified):** design + Claude side DONE and live-proven THIS session (my sends ack `prompt_submitted.in_band`). The per-arm prototype exists: `.squidrun/runtime/model-prompt-receipt-probes/review-packet-2026-06-12T23-37Z/per-arm-config-distribution.prototype.json`. Mapping (from the probe packet, version floors recorded): codex arms → `.codex/hooks.json` event `UserPromptSubmit`; gemini arms → `.gemini/settings.json` event `BeforeAgent` (NOT UserPromptSubmit — gemini 0.46.0 rejects it); claude → `UserPromptSubmit` (live). paneCommands: 1=claude, 2=codex, 3=claude, trustquote-app=codex, trustquote-lead=claude.

**The work:** an idempotent install step that writes the correct adapter config into each arm's cwd per paneCommands, + the 3 step-zero verifications I specced: (1) PTY-injection probe per CLI confirms the hook fires on injected text, (2) version-floor check (codex 0.139.0 / gemini 0.46.0), (3) per-arm config lands. **Acceptance:** a send to pane-2 (codex) acks `prompt_submitted.in_band` like pane-1 does now — the ack-tier asymmetry I keep flagging closes. **Effort:** ~half-day. **Risk:** medium (per-arm trust/config). **Owner:** Builder builds, I verify the cross-pane receipt fires.

## #6c — HOT-WATCHER AUDIT (this is genuinely an audit, not a fix yet)

**Code state (verified):** `ui/modules/watcher-worker.js` uses chokidar; `WORKSPACE_WATCH_POLL_INTERVAL_MS = 5000` (L33) — a 5-second poll. It watches coord roots + triggers + workspace. The ~2,984 CPU-s / ~859MB cost = chokidar stat-polling a large tree every 5s, per instance (cross-window confirmed: every install runs one).

**The audit (the actual work):** TRIGGERS need fast watching (delivery fallback latency). The WORKSPACE watch at 5s is the suspect — **the open question is what CONSUMES workspace-file-change events, and whether anything needs 5s latency.** If nothing time-critical consumes them: slow the workspace poll to 30-60s OR make it event-based (not polling), keeping triggers on the fast small-path watch. That likely cuts the cost by ~5-10x. **Do NOT slow it before finding the consumer** (M1 — don't fix before confirming the problem). **Acceptance:** workspace-watch consumer identified; if slow-able, CPU-s/instance drops measurably with no delivery-latency regression. **Effort:** audit ~1h, fix ~1h. **Risk:** low if triggers stay fast. **Owner:** Oracle audits (my lane), Builder applies any cadence change.

---

## #7 — GOD-OBJECT (governance + carve the delivery corner ONLY)

**Code state (verified):** `ui/modules/main/squidrun-app.js` = 13,642 lines. The C4 delivery family lived at L~2073 (telegram drain), L~8460 (pending-pane-deliveries flush), L~10901 (scoped telegram inbound), L~14068 (inbound routing) — one cluster, the proven-hot corner. (Also the window-open logic, e.g. the human-timeline branch at L~6484.)

**Two cheap moves, NOT a big split (all three agents converged on this):**
1. **GOVERNANCE (freeze growth):** a pre-commit guard that fails if `squidrun-app.js` grows beyond its current line count (or a small ceiling above it). Forces every new feature to justify a module instead of bloating the god object. Mirrors the existing gate pattern (the pre-commit already has 8 gates; add a line-ceiling gate). **Effort:** ~1h. **Risk:** none. This is the "authority to tell squidrun-app.js no" made mechanical.
2. **CARVE the delivery corner:** extract the delivery/injection cluster (drain + pending-flush + scoped-telegram + inbound-routing) into `modules/main/delivery-coordinator.js` with a hard interface. This is the corner with the documented bug history (C4) and the one that most needs an owner-can-say-no boundary. The other ~12k lines stay — ugly, not on fire. **Effort:** ~1 day (careful, test-covered). **Risk:** medium (touches the delivery path — gate hard with the existing delivery tests + my arrival eval). **Owner:** Builder; I gate against C4 non-regression.

---

## FRONT-DOOR PROMOTION (sidecar → main window, "re-mount not rewrite")

**Code state (verified):** the renderer is already portable — `ui/human-timeline-sidecar-renderer.js` + `human-timeline-sidecar.html` depend ONLY on the `human-timeline:snapshot` invoke channel (in `channel-policy.js` INVOKE_CHANNELS; window opened via the `human-timeline-sidecar` branch at squidrun-app.js:6484). Builder built it portable per Mira's #5 scope. The main window (`ui/index.html`) already has a `Today` button (L~148) that opens the separate sidecar window.

**The promotion (UX decision needed):** because the renderer's only dependency is the snapshot channel, this is a re-mount, not a rewrite — embed the same renderer in a container inside `index.html`, pointed at the same channel. The UX fork (this is the decision for James):
- (A) Today as a PANEL always visible in the main window (e.g. left rail or top strip) — the fresh-eyes "feed-first main surface" convergence points here.
- (B) Today as a TAB alongside the panes.
- (C) Today as the DEFAULT landing view, panes one tap away (the most aggressive "human's door first" reading).
**Recommendation:** (A) always-visible panel first — lowest-risk, gets the human surface in front of James without hiding the panes he also needs; promote to (C) default-view later if he wants it. **Effort:** ~half-day for the re-mount (A). **Risk:** low (no new data path; same snapshot channel). **Owner:** Builder re-mounts; I verify the embedded surface passes the same gate (no jargon, no stale, needs-you accurate) as the standalone.

---

## Sequencing recommendation

After #5 lands (filter ✓, rolling-window ✓, headlines #5.3, obligation-guard #5.4): the cheapest high-value next is **#6a fence-lab** (30 min, stops a real irritant) + **#7 governance freeze** (1h, prevents the god-object getting worse while we do everything else). Then **front-door promotion (A)** — it's the payoff of #5, putting the now-clean Today in front of James in the main window. **#6b receipt adapters** and **#6c hot-watcher** are real but lower-urgency (the Claude receipt path already works; the watcher cost is chronic-not-acute). **#7 delivery-carve** is the biggest single item — schedule it deliberately, gated hard, not squeezed in.

*Plan by Oracle, S446. Verified against code at HEAD ~38462a6d. The hot-watcher item is honestly an audit-not-a-fix; the front-door UX fork (A/B/C) is James's call.*
