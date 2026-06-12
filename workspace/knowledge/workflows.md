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

Historical stale hook root cause: `.claude/hooks/pre-tool-image-read-guard.js` (written 2026-04-29) used to force-block every image `Read` and redirect to **Oracle**, from the era when Oracle was the strong-vision model. That redirect was obsolete and circular. Current expected behavior: the hook must route live UI surfaces to Codex Desktop through proven `hm-codex-attention --url/--route/--target-window`; bare local image files must put the absolute file path in `--check`, use a real attention target such as `--target-window main`, and mark that file-read-via-check path unproven until the bridge grows a real image/file target field. LOOK-lane captures under `.squidrun/screenshots/` and known runtime proof/capture PNG paths are exempt from the block because they are the mandated visual verification discipline, not arbitrary image analysis. Never fall back to Oracle for visual analysis.

# Task Audit Sidecar Discipline

The live-task-audit sidecar is not a loose to-do list and not a place to park uncertainty on James. It is the persistent shared model of what is still broken, disabled, half-wired, or easy for a cold session to misinterpret.

An entry leaves the sidecar only when the thing is genuinely resolved: deleted, finished with proof, or deliberately retained with current evidence. Getting bored, losing context, or not recognizing an artifact is not resolution.

For agent-created artifacts, "ask James" is banned as a disposition. The default workflow is: investigate provenance ourselves with grep, git log/blame, session/comms history, and runtime evidence; then choose delete, to-finish, or honest broken-state entry. Escalate to James only for money, credentials/auth, irreversible data state, external-facing behavior, or a product choice that cannot be inferred from evidence.

Every sidecar entry should use the existing `status`, `rationale`, and `nextAction` fields honestly. The state must say whether the thing is live, disabled, unproven, stale, to-finish, or blocked, and `nextAction` must name the agent-owned evidence step. Vague user-escalation parking is itself a defect to fix.

# Agent Pane Injection Invariant

Claude panes and Codex panes do not fail the same way. James's S400 differential clue was decisive: Codex panes were not truncating, only Claude panes were. That ruled out a universal PTY byte limit.

Root cause found in `ui/modules/main/squidrun-app.js`: `deliverPaneMessageReliably()` tried the direct daemon PTY route first. That route already skipped large Codex payloads (`skipped.codex_chunked_payload`) so Codex fell through to the packetized/chunked inject path, but Claude payloads above the same threshold still went through one direct daemon PTY write plus Enter. That one-shot Claude write is the front-clip/tail-retain failure path.

Current rule: payloads at or above `DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES` must skip direct daemon PTY for every pane runtime and use the verified packetized/chunked inject path. Short direct daemon writes may remain. The full-message pointer file is only a silent-clip safety net; it is not the root fix.

## Squid Room PTY mirror and delivery-status triage (S416)

Squid Room Builder/Oracle panes are the same live pane sessions rendered in another window. Commit `3e39fff2` fixed the S415 blank-body bug by treating panes `2`/`3` as multi-window PTY owners when Squid Room exists: `pty-data` and `pty-exit` go to both `main` and `squid-room`; TrustQuote arm panes remain `squid-room` only. Static tests alone were not enough proof because the changed path lives in Electron main-process routing. Runtime proof required a restart/code-load, then fresh `hm-screenshot --window-key squid-room` captures showing Builder/Oracle terminal bodies painting live.

Resize ownership is single-owner. Commit `9adb3286` made Squid Room mirrored panes read-only for PTY geometry/backpressure: canonical home remains `main`, and the Squid Room mirror may render terminal data but must not call fit/resize/backpressure as a second owner. Commit `0ae4a99b` then fixed the remaining global ResizeObserver/fit loop by gating PTY resize on last-applied integer dimensions and breaking the observer self-trigger. The proof gate was event-rate based, not visual-only: post-load daemon resize rates for panes `1`/`2`/`3` and TrustQuote arms had to drop from the prior global `~24-26/s` storm to `0/s` steady state.

Do not treat a single `hm-comms` row with `status=failed` as proof that an agent never received the message. In S415/S416, rows `68644`, `68645`, `68646`, and `68648` were marked failed while bus trace showed successful packetized IPC handoff/reassembly before a later `pane_delivery_outcome` of `delivery_failed` caused by `write ack timeout after 2500ms`. The pending queue then retained those messages in `.squidrun/runtime/pending-pane-deliveries.json` with `lastFailureReason=routed_unverified_timeout`, so retry/restart state looked broken even though later pane behavior proved the messages were processed. By 15:33 local in S416 the same stale rows replayed out of order after the blank-body lane had closed, so stale pending replay is part of the same ack/verification bug, not a separate user-routing mystery. Triage order: check `bus-reliability-trace.jsonl` for `pane_ipc_handoff` / `renderer_ipc_reassembled`, check `.squidrun/runtime/pending-pane-deliveries.json` for stale retries, then check recipient follow-up rows before resending or claiming route loss.

Comms false-failed/replay fixes landed in three parts: `191b0976` downgrades delivery write-ack timeout after successful handoff/write to accepted/unverified instead of hard `delivery_failed`; `7d6d1c02` lets later routed/accepted proof supersede a false failed row in evidence ranking; `5072985a` suppresses stale or already-resolved pending pane replays before they are written back into panes. Startup risk rule for `pending-pane-deliveries.json`: the canonical queue is `.squidrun/runtime/pending-pane-deliveries.json`, not stale nested `.squidrun/.squidrun/runtime` artifacts. On startup/renderer post-load and pane-host-ready, `flushPendingPaneDeliveries()` evaluates stale-session, stale-before-current-start, comms-journal proof, materialized/reassembled payload proof, and recipient-follow-up proof before any replay write. No-session legitimate in-flight pending is protected by the 10-minute replay grace around the current app start; older no-session pending is treated as stale.

S443 added the third replay source: scoped Telegram trigger drain. An empty `pending-pane-deliveries.json` does not rule out a live 60s reinjection loop, because `startScopedTelegramTriggerDrainPoller()` can own an in-memory retry cycle over `triggers-<profile>/architect.txt`. Accepted statuses (`accepted.unverified`, `accepted.daemon_pty_unverified`, `submit_pending_input`) are terminal for both `deliverScopedTelegramInboundWithRetry()` and trigger-drain cleanup; hard unavailable results keep bounded backoff and eventually quarantine the trigger payload into `drained/` instead of re-injecting forever.

Restart-survival proof is harness-first. Run `node ui/scripts/hm-squid-room-restart-proof.js baseline` immediately before the restart after all to-be-loaded commits are present, then run `node ui/scripts/hm-squid-room-restart-proof.js verify` post-restart. The verifier writes `.squidrun/runtime/squid-room-restart-survival-proof.json` and asserts session bump, Squid Room auto-restore or on-demand classification, ready panes, renderable Builder/Oracle bodies, all four TrustQuote arms role/env/cwd-bound, arm registry, startup receipts, baseline tail continuity, and trailing resize/event-rate stability. James watching panes is not the proof gate.

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

## Cross-Profile Architect Channel

Use this only for Architect-to-Architect coordination between profile windows. Builders and Oracles do not cross-send into the other profile; they route through their own Architect.

The clean route must pin both sides explicitly. Do not rely on cwd or `SQUIDRUN_PROFILE` inference for cross-profile sends.

Main Architect to Eunbyeol Architect:
```powershell
@'
(ARCHITECT #N): Message body.
'@ | node ui/scripts/hm-send.js architect --role architect --source-profile main --source-window main --target-profile eunbyeol --target-window eunbyeol --stdin
```

Eunbyeol Architect to Main Architect:
```powershell
@'
(ARCHITECT #N): Message body.
'@ | node ui/scripts/hm-send.js architect --role architect --source-profile eunbyeol --source-window eunbyeol --target-profile main --target-window main --stdin
```

Journal rows for this channel must carry unambiguous window attribution in metadata: `sourceAddress`, `targetAddress`, and `routeAttribution` with `sourceProfileName`, `sourceWindowKey`, `targetProfileName`, and `targetWindowKey`.

Activation boundary: `ui/scripts/hm-send.js` is a CLI process and changes take effect on the next invocation. Route acceptance in `ui/modules/websocket-runtime.js` and broker journal metadata in `ui/modules/main/squidrun-app.js` load only after the relevant Electron main process/window is restarted or otherwise reloaded.

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

## Shared Git Index Commit Hygiene (standing rule, S442)

All three panes share ONE working directory and ONE git index. `git add <paths> && git commit` commits **everything already staged**, not just the paths you added — so "docs-only commit" is fiction unless the index is clean. Proven live S442: Oracle's census commit (313c4449) silently swept in Builder's complete staged-but-uncommitted fix pass; content survived (both authors verified) but attribution was wrong and the race could have shipped half-finished work.

Standing rule (Architect-ratified S442, applies to every pane):
1. **Before committing while another pane is active, claim the index**: announce "claiming the git index" via hm-send to the other panes (or in the room).
2. **Check `git status --short` first** — if files you don't own are staged, STOP and coordinate; do not commit over them.
3. **Commit only paths you own.** If you find someone else's staged work, the stager commits it, not you.
4. Corollary from the same night: **never cite the session-start git snapshot as live tree state** — it fossilizes within minutes. Run `git status` fresh before any claim about the tree.

## Memory-Consistency Drift Cleanup (`hm-memory-consistency.js`)

Procedure to clear cognitive-memory drift for good (verified end-to-end S404, missing 10→0 / orphans 18→0). The naive `--dry-run` breakdown is misleading in two places — do NOT hand it out as the recipe without these corrections.

Order of operations:
1. **`missing=*`** → `--repair --repair-scope missing-only`. Pure additive index sync (inserts + same-heading resyncs), `deleteCount:0`, safe. Resyncs here also re-link any orphan that shares a heading, so orphan count can drop in this step too.
2. **`orphans` / `relational_migration_required`** → `--orphan-migration-review` then `--migrate-orphans --mapping-file <path>`. **RECIPE BUG #1:** review does NOT auto-emit a clean mapping when sections were *restructured* (renamed/merged), not merely edited — every orphan comes back `ambiguous_multi_target` with zero same-heading successors, `mappedMigrationCount:0`. You must hand-author the mapping. Before doing so, verify the orphans' edges (`SELECT relation_type ... FROM edges` in `.squidrun/runtime/cognitive-memory.db`): if they're all generic `related_to` similarity links (no curated antibody/contradiction/derived), mapping each orphan to its closest live successor heading is safe — the real knowledge lives in the markdown, edges are just graph connectivity. Mapping-file shape: `{mappings:[{orphanNodeId, targetNodeId}]}` (also accepts oldNodeId/from, target/to). `--orphan-migration-review --mapping-file X` READS X as input (it does not write the proposal to X).
3. **`orphans` / `deleted_source_orphan`** (source file deleted) → `--guarded-delete-review --drop-file <path>` FIRST, then `--guarded-delete-orphans --drop-file <path>`. Drop-file shape keys on **sourcePath::heading**, not bare node IDs: `{targets:[{sourcePath, heading, nodeIds:[...]}]}`. **RECIPE BUG #2 / key finding:** `--guarded-delete-orphans` has **no override** for edge-bearing nodes — any node with `edge_count>0` is ALWAYS escalated (`guarded_delete_escalated`), never auto-deleted. `--allow-orphan-deletes` only affects the `--repair` path, NOT guarded-delete. So the bare flag = **0 deletes** on any orphan that still has edges. To actually purge: confirm no live consumer (generic `related_to` cross-links + routine traces only ≠ a consumer; check the content was relocated, e.g. devices.md → runtime-environment.md), then **zero the stale cross-link edges first** (`DELETE FROM edges WHERE source_node_id=? OR target_node_id=?`) so `edge_count=0`, then `--guarded-delete-orphans` deletes cleanly with an audit event. STOP and escalate to Architect/James instead if the node is James's manual runtime watch-rule state (the autoclean landmine) — device-registry / agent-ingested index nodes are NOT that class.

Steady-state caveat: `duplicateSourceHeadingCount` with `count=1/expectedCount=0` entries are benign **positional stableKey drift** (hash-matched nodes whose stored `section:N|chunk:M` no longer matches the current file) — not orphaned, not missing, not collapsible, so `--repair` emits 0 actions. They keep `synced=false` and cost a flat 10pt `memory_consistency_unsynced` penalty (warning downgrades to `unclassified_drift`). Clearing them needs node-metadata resync or full re-ingest (new node IDs, risks edge/salience loss) = DB surgery for a cosmetic point. S404 decision: accept it; do NOT resync.

## Surface-Claim Guard calibration (hm-send-surface-claim-guard.js, S404 commit ec305005)

The `surface_done_claim_without_artifact` guard blocks user-facing (user/telegram) messages that claim something is DONE and VISIBLE on a surface without attaching a fresh visible-pane-submit artifact. It exists for a real reason — stop false done-claims to James — and must NOT be declawed. S404 it was over-firing: the old detector fired on `(done-term && surface-term)` co-occurrence ANYWHERE in the body, and the surface set included `james|telegram|see`, which are trivially present in every Telegram message → collapsed to "contains any done-word" → blocked 8 legit architect->telegram status messages (S398-S404).

Calibrated detector semantics (so the next agent doesn't relitigate it cold):
- **Per-sentence proximity, not whole-body co-occurrence.** `splitClaimSentences()` splits on `.!?`/newlines; `hasSurfaceCompletionClaim` returns true only if SOME single sentence has both a done-term AND a surface-noun (`sentenceHasSurfaceCompletionClaim`). "Fixed the bug. You can see the dashboard later." no longer trips (done and surface are in different sentences).
- **Surface nouns narrowed to real rendered surfaces:** `dashboard|pane|invoice|screen|window|prompt|screenshot|sidecar`. Deliberately DROPPED the recipient/channel terms `james|telegram|see|sees|trustquote|surface` (they don't denote a thing James looks at; for telegram they're trivially true).
- **Forward-looking exemption (`isForwardLookingSurfaceClaim`):** a sentence with `will|i'll|we'll|you'll|going to|about to|once|as soon as|after restart|after the|next|planning|working on|in progress` is treated as not-a-claim — UNLESS it also carries a present-tense marker `now|already|currently|right now`, which keeps the block active ("it's fixed and showing on your dashboard now" still blocks).
- **Standalone starts-with-done trigger REMOVED.** Old code blocked any message starting with "done/complete/finished" even with no surface noun. Now blocking REQUIRES surface-noun + done-term together — a bare "Done. Closing the lane." or "Done — root-caused it, tests green" passes. This is intentional and consistent with the guard's `surface_done_claim` charter (it polices SURFACE done-claims, not all done-claims). `startsWithClaim` now only feeds a narrow test-exemption (`!startsWithClaim || !testOnly`).
- **Blind-log fixed:** violation log now records `bodySnippet|bodySha256|bodyBytes|bodyTruncated` on block+bypass paths (previously only messageId+reason, and blocked msgs never hit the journal — calibration was flying blind).
Verified S404 (Oracle second-eye, behavioral): legit/forward-looking/bare-done PASS; "invoice is fixed and showing on your dashboard now", "done - visible in the TrustQuote pane", and present-tense-override cases BLOCK.

KNOWN GAP (logged S404, judgment call — NOT an auto-fix): present-tense STATE verbs (`open|rendering|live|running|up`) are NOT in the done-term vocab, so "the sidecar is open and rendering right now" PASSES the guard. Expanding done-terms to cover them risks re-over-blocking innocuous status ("the window is open"), so it's deferred to weigh with James, tracked in the task-audit sidecar (id `surface-claim-guard-state-verb-gap-404`).
