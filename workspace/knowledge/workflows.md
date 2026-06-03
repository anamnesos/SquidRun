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

# Image / Visual Analysis Actor Boundary

Image and visual analysis — screenshots, plain visual description of the SquidRun UI, the live-task-audit sidecar panel, any "tell me what you see" request — is **Codex Desktop's job**, not Oracle's and not Architect's (James, repeatedly; restated emphatically 2026-06-02 / S400). Codex Desktop is the computer-use app with real desktop/browser vision; it can look at the live app window or browser-proof a surface (e.g. the task-audit sidecar at `http://127.0.0.1:8787/task-audit-preview`).

Dispatch path: **Architect** creates the request (cross-device coordination is Architect's lane), e.g. `node ui/scripts/hm-codex-attention.js create --requested-by architect --reason "<what to look at>" --url http://127.0.0.1:8787/task-audit-preview --check "<verbatim ask>"`. Oracle/Builder must not absorb image-analysis work themselves; relay it to Architect → Codex Desktop.

Historical stale hook root cause: `.claude/hooks/pre-tool-image-read-guard.js` (written 2026-04-29) used to force-block every image `Read` and redirect to **Oracle**, from the era when Oracle was the strong-vision model. That redirect was obsolete and circular. Current expected behavior: the hook must route live UI surfaces to Codex Desktop through proven `hm-codex-attention --url/--route/--target-window`; bare local image files must put the absolute file path in `--check`, use a real attention target such as `--target-window main`, and mark that file-read-via-check path unproven until the bridge grows a real image/file target field. Never fall back to Oracle for visual analysis.

# Task Audit Sidecar Discipline

The live-task-audit sidecar is not a loose to-do list and not a place to park uncertainty on James. It is the persistent shared model of what is still broken, disabled, half-wired, or easy for a cold session to misinterpret.

An entry leaves the sidecar only when the thing is genuinely resolved: deleted, finished with proof, or deliberately retained with current evidence. Getting bored, losing context, or not recognizing an artifact is not resolution.

For agent-created artifacts, "ask James" is banned as a disposition. The default workflow is: investigate provenance ourselves with grep, git log/blame, session/comms history, and runtime evidence; then choose delete, to-finish, or honest broken-state entry. Escalate to James only for money, credentials/auth, irreversible data state, external-facing behavior, or a product choice that cannot be inferred from evidence.

Every sidecar entry should use the existing `status`, `rationale`, and `nextAction` fields honestly. The state must say whether the thing is live, disabled, unproven, stale, to-finish, or blocked, and `nextAction` must name the agent-owned evidence step. Vague user-escalation parking is itself a defect to fix.

# Agent Pane Injection Invariant

Claude panes and Codex panes do not fail the same way. James's S400 differential clue was decisive: Codex panes were not truncating, only Claude panes were. That ruled out a universal PTY byte limit.

Root cause found in `ui/modules/main/squidrun-app.js`: `deliverPaneMessageReliably()` tried the direct daemon PTY route first. That route already skipped large Codex payloads (`skipped.codex_chunked_payload`) so Codex fell through to the packetized/chunked inject path, but Claude payloads above the same threshold still went through one direct daemon PTY write plus Enter. That one-shot Claude write is the front-clip/tail-retain failure path.

Current rule: payloads at or above `DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES` must skip direct daemon PTY for every pane runtime and use the verified packetized/chunked inject path. Short direct daemon writes may remain. The full-message pointer file is only a silent-clip safety net; it is not the root fix.

# Telegram reply-guard: external-process replies vs in-memory state

Load-bearing constraint (S396). `hm-send.js telegram` runs in a SEPARATE process from the Electron main app, so a Telegram reply it sends CANNOT directly clear the app's in-memory `pendingTelegramReplyGuards` map. That gap is what produced the recurring `(SYSTEM RESPONSE-DEBT) pane_output_without_telegram_egress` loop: the only clear path was a fragile lazy journal reconcile at pane-output time, so a reply that was actually sent kept getting flagged as unanswered.

Fix (commits 0668dd12 / 45508bf5, `ui/modules/main/squidrun-app.js`): a proactive `setInterval` (default 5s, `SQUIDRUN_TELEGRAM_REPLY_GUARD_JOURNAL_RECONCILE_INTERVAL_MS`, floor 1s) reconciles pending guards against the evidence-ledger journal independent of pane output; chat-equality is enforced only when both guard and row carry a chatId, with a 5s journal grace; terminal guards (expired_unresolved / phone_escalated) stay in the map for bookkeeping but are skipped, and the interval self-clears once the non-terminal count hits 0. Reconcile is READ-ONLY journal queries (no new ledger writes); the timer is `unref()`'d and cleared in the destroy/cleanup paths.

S399 row-field triage: a delivered `hm-send telegram` row can already be matchable with `channel=telegram`, `direction=outbound`, `status=acked`, `ack_status=telegram_delivered`, `target=user`, and matching metadata `chatId` even when `replyToMessageId` is absent. Missing `replyToMessageId` should be fixed for future precision, but it is not by itself proof that the reconciler rejected the row; if the raw row is matchable and the guard still nags, check whether the running main process can query the journal at all (for example native SQLite/`better-sqlite3` ABI health) before sending a duplicate Telegram reply.

S400 false-fire fix: ABI/journal queryability was ruled out in app-session-400. The live rows were readable and delivered, but rapid Telegram bursts can produce a real same-chat delivered reply whose `replyToMessageId` points to an adjacent inbound. The guard is an egress proof, not semantic coverage. Same-session, same-chat, `telegram_delivered` outbound egress inside the journal grace window must satisfy the pending guard even when the reply-to id is adjacent; different-chat and pre-window rows still do not satisfy it.

Native DB guard: `ui/package.json` postinstall runs `ui/scripts/postinstall-electron-rebuild.js`, which probes `better-sqlite3` through Electron (`ELECTRON_RUN_AS_NODE=1`) before rebuilding. If the probe succeeds at Electron ABI 119, it skips; if a Node install leaves the native module at the wrong ABI, it runs the targeted `electron-rebuild -f -o better-sqlite3` path and re-probes.

Do NOT "simplify" this back to pane-output-only reconcile — the external-process/in-memory gap will return. Known accepted limitation: `pendingTelegramReplyGuards` is in-memory only, so an inbound that arrived pre-restart and was unanswered is dropped on restart (it will not nag post-restart). The inbound row still exists in the evidence-ledger for manual recovery; auto-nagging across a restart is intentionally not provided.

## Release Process

(Re-homed S398 from cognitive memory — lost when workflows.md was rewritten; not preserved in infrastructure.md or elsewhere, so this is the only copy.)

- Version bump in `ui/package.json`
- Build with `npx electron-builder` (`--win` from Windows, `--mac` from Mac). Note: Windows may require `--config.npmRebuild=false` if Spectre-mitigated libs are missing.
- Create GitHub release: `gh release create vX.Y.Z ui/dist/SquidRun-Setup-X.Y.Z.exe`
- Update site: bump `RELEASE_VERSION` in `squidrun-site/platform-download-button.tsx`, push to `master`, wait for Vercel deploy.

## CLI Gotchas

- **`hm-restart-request.js` has NO `--help`.** Invoking it with any args (including `--help`) immediately *captures a real restart request* — it writes `.squidrun/coord/restart-request.json` + `restart-handoff.md`. There is no read-only/inspect mode. To inspect safely, `Read` the script or pass `--dry-run` (skips the file writes). Discovered S401 when an exploratory `--help` wrote a spurious `restart-401` record. NOTE: writing the request file alone does NOT trigger a restart — the trigger is a queued item in the Codex Desktop attention inbox (`hm-codex-attention.js create`). A stray request file is harmless-but-confusing cruft; hard-delete it (it's only written, never required-present, by `hm-restart-request.js`).

## Task Delegation Template (Architect -> Builder)

(Re-homed S398 from cognitive memory — lost in the workflows.md rewrite.)

Structured envelopes for Builder delegation:
```
OBJECTIVE: <one-line goal>
SCOPE IN: <what to touch>
SCOPE OUT: <what NOT to touch>
REQUIRED EDITS: <file list>
VALIDATION: <commands to run>
ACCEPTANCE: <how to know it's done>
DELIVERABLE: <commit, PR, staged changes, etc.>
PRIORITY: <now / next / backlog>
```
Comms cadence: Builder sends initial ACK + plan, then delta updates only on state change. No noise.
