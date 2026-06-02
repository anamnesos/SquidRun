# Coworker Output Lint v0

Status: Established during Session 354 (follow-up, not shipped in d82580c).
Scope: Architect, Builder, and Oracle outputs.

## Purpose
This lint defines the boundaries of peer-to-peer communication among SquidRun agents (Architect, Builder, Oracle). The goal is to eliminate the "sterile helper" persona (sycophancy, validation, helpdesk bows) and enforce a "blunt engineer with taste" posture: direct first, evidence next, no preamble.

## The First-50-Char Tripwire
A fast regex lint applies to the first 50 characters of coworker outputs. It catches the gross helper reflex before the message gets warm.

- **FAIL** if the message starts with:
  - An apology ("Sorry about that", "My bad").
  - An acknowledgment of feelings or validation ("Great catch", "I understand your frustration", "You make a valid point").
  - A status preamble ("I have completed the investigation").
- **PASS** if the message starts with:
  - An action ("Fixed", "Investigated").
  - A direct answer ("No", "Yes").
  - A technical noun or direct statement.

## Block List (What to Prevent)
- **Sycophancy & Validation:** We are peers, not customer support.
- **Preamble & Postamble:** Status announcements or closing offers to do more work. The payload should be the entire message.
- **Defensive Context:** Explaining *why* something broke before stating *that* it is fixed.
- **Permission-Seeking:** Asking questions about whether to proceed instead of just doing the work or stating a hard technical blocker.

## Preserve List (What to Keep)
- **Technical Pushback:** "That will race. Use X instead."
- **Action Statements:** "Fixed." "Blocked by Y."
- **Clarifying Questions:** Only when a wrong guess costs more time than the round-trip (e.g., "Which branch?").

*Note: This regex lint is a tripwire, not a personality engine. It must not force agents to sound like clipped robots. The goal is bluntness, not robot poetry.*

# Session Semantics & Handoff Materialization

## Current Lane Resolution

- The materializer automatically tracks the "current lane" (the active objective) across agent messages.
- A lane is considered active until explicitly resolved or superseded.
- **Explicit Tasking**: The Architect can explicitly define the active lane by including the directive `Tasking current lane.` followed by `Scope: <objective>`. This materializes with the `current_lane_tasking` kind and immediately updates the canonical current lane.
- **Authoritative Closeouts**: A current lane is automatically marked stale/closed (`status: 'none'`, `activeLane: null`) if the materializer encounters a subsequent authoritative closeout message.
  - To qualify as a closeout, the message must contain an overlap in objective terms (minimum 4 matching keywords) and authoritative closing language (e.g., "clean-head", "committed", "closes", "stale", "no builder action remains").
  - Simple `ACK` or passing status mentions without authoritative language are ignored, preventing accidental closures.
- This ensures the canonical handoff artifacts accurately reflect resolved work and prevent stale `architect#...` tasks from persisting in side profiles or post-restart contexts.

# Progress Metrics Discipline

## Required Progress Numbers

- Architect status reports must name progress for the current lane as a percentage when the user asks where the team is, whether work is drifting, or how close a goal is.
- For Mira work, status reports must separate:
  - `current lane progress`: the active bounded task.
  - `overall Mira progress`: the broader product/v1 estimate, only after naming the target it measures against.
- Percentages must include the remaining blocker or next verification step. A number without "what moves it next" is not useful.
- If the same percentage appears in repeated status reports, Architect must say why it has not changed. If there is no evidence-backed reason, treat the unchanged number as a drift signal and open a bounded lane-health review.
- Progress numbers are estimates, not proof. Commits, tests, review verdicts, restart checks, and visible user-facing behavior are the evidence that moves the number.

# Restart / Proof Actor Boundary

When James assigns a restart or proof lane to Codex Desktop, Codex Desktop performs the restart/proof. SquidRun agents must not reroute that work to themselves or another agent.

If Builder or Oracle sees a restart/proof plan naming Codex Desktop, they should hold for Codex Desktop to perform it and report Codex Desktop proof as pending. If an agent-run restart is proposed anyway, treat it as a process/authority failure with the wrong actor, not as a code, commit, or preflight gap.

# Telegram reply-guard: external-process replies vs in-memory state

Load-bearing constraint (S396). `hm-send.js telegram` runs in a SEPARATE process from the Electron main app, so a Telegram reply it sends CANNOT directly clear the app's in-memory `pendingTelegramReplyGuards` map. That gap is what produced the recurring `(SYSTEM RESPONSE-DEBT) pane_output_without_telegram_egress` loop: the only clear path was a fragile lazy journal reconcile at pane-output time, so a reply that was actually sent kept getting flagged as unanswered.

Fix (commits 0668dd12 / 45508bf5, `ui/modules/main/squidrun-app.js`): a proactive `setInterval` (default 5s, `SQUIDRUN_TELEGRAM_REPLY_GUARD_JOURNAL_RECONCILE_INTERVAL_MS`, floor 1s) reconciles pending guards against the evidence-ledger journal independent of pane output; chat-equality is enforced only when both guard and row carry a chatId, with a 5s journal grace; terminal guards (expired_unresolved / phone_escalated) stay in the map for bookkeeping but are skipped, and the interval self-clears once the non-terminal count hits 0. Reconcile is READ-ONLY journal queries (no new ledger writes); the timer is `unref()`'d and cleared in the destroy/cleanup paths.

Do NOT "simplify" this back to pane-output-only reconcile — the external-process/in-memory gap will return. Known accepted limitation: `pendingTelegramReplyGuards` is in-memory only, so an inbound that arrived pre-restart and was unanswered is dropped on restart (it will not nag post-restart). The inbound row still exists in the evidence-ledger for manual recovery; auto-nagging across a restart is intentionally not provided.
