## Cognitive Memory Antibody Architecture (Session 244)

To solve the gap of low-confidence hallucinations being grandfathered into truth, the team agreed on an async antibody worker pattern.

### Implementation Guardrails
1. **Quarantine:** Soft flag only for now. Exclude flagged nodes from default retrieval, but keep them in the DB to test the detection accuracy before building a permanent 'delete' pipeline.
2. **Worker Location:** Must live in \ui/supervisor-daemon.js\ alongside the Sleep Consolidator, operating on an idle-tick to keep the main event loop clean.
3. **Lease Invalidation (Additive Constraint):** If a memory is mid-lease during retrieval and the antibody worker flags it, it must emit an immediate invalidation event to cancel the lease, preventing contested facts from being utilized.


## Deterministic Mira Progress Accounting (Session 381)

To prevent unverified or vibes-based claims of Mira capability, the team shifted to a fully deterministic progress accounting model (`mira-progress-v0.js`).

### Implementation Guardrails
1. **No Manual Authority:** Manual percentage bumps and global_percent edits are entirely deprecated. Progress is computed exclusively from the v0 contract, Presence state, proof inputs, blocker flags, and HEAD metadata.
2. **Strict Exclusions:** Historical conversational estimates (e.g. 35-45/40) are explicitly excluded from computations.
3. **Stale State Handling:** When Presence state predates HEAD or lacks proof inputs, it correctly forces a stale/BLOCKED status (e.g., locking voice scores to 0 when blocked), preserving system truth.


## Electron Audit Remediation — Major Upgrade Deferred (Session 398)

npm-audit branch `security/npm-audit-remediation-394` was merged to main (ff). The remediation is **deliberately partial — do NOT treat the remaining audit warning as unfinished work.**

### What landed
1. **Non-Electron deps (commit `98217095`):** `overrides` block pins ~24 transitive deps (protobufjs, tar, hono, qs, lodash, minimatch/picomatch/brace-expansion families, ajv, etc.) + `ws` 8.19→8.21. Audit clean of all those.
2. **Electron vuln-class (commit `7de1fdde`):** ~964 lines of in-code mitigations (permission-request-handler scoping, IPC reply-spoof guards, window.open target scoping) + tests. Electron version NOT bumped.

### The remaining `1 high` is expected and accepted
- Installed Electron is `28.3.3` (range `^28.0.0`). `npm audit` will report **1 high** indefinitely until a version bump. The only audit-clean fix is `electron@42.3.1` — a **14-major breaking jump** forcing a full app restart.
- **Defer rationale (verified S398, not "macOS-specific" — that framing is wrong on a Windows app):** the platform-API-specific advisories target functions we never call — `grep ui/` for `setAsDefaultProtocolClient` / `setLoginItemSettings` / `moveToApplicationsFolder` = zero matches, so both Windows advisories + the macOS AppleScript one are non-reachable dead paths. The reachable cross-platform renderer/IPC class is exactly what `7de1fdde` mitigates in-code. High regression risk, low marginal benefit → parked pending an explicit James/Architect upgrade decision.


## Session 398 — Changed Behavior (pre-restart docs pass)

Durable behavior changes from the S398 reconciliation audit. Restart required to activate (the live app at restart time predated all of these commits).

1. **Cognitive-memory stableKey de-dup + upsert prevention (`b8421933`).** Node identity for knowledge is `stableKey = sourceType|sourcePath|heading|sectionIndex|chunkIndex` (`memory-consistency-check.js`), NOT `(source_path, heading)` — multi-chunk sections are distinct nodes, so do not dedupe by heading alone. Re-ingest now UPSERTS on stableKey (`cognitive-memory-api.js ensureNodeFromSearchResult`: content_hash check → stable-key fallback → update-existing) so the same section can no longer mint content-divergent duplicates. The prior 1GB-scale "orphan" inflation was edit-noise (content folded into the old identity hash), not corruption. Repair: in-place resync (keep disk-matching survivor, migrate edges/leases via `moveDuplicateEdges`/`moveDuplicateLeases`, delete losers). **16 edge-blocked residuals remain as explicit `needs_follow_up_purge_review`** (node IDs/blockers/purge-rec in `.squidrun/runtime/oracle-audit-398/memory-phase2-live-gate-s398.json`) — NOT silent survivors; a later pass migrates edges (VIGIL/MACBOOK → runtime-environment) or manually purges the gone-heading set.

2. **F2 knowledge git-tracking privacy model (allowlist `5c928000`).** `workspace/knowledge/` is NOT blanket-tracked (ROLES.md's old "git-tracked and shared across devices" claim was false). Only explicitly allowlisted **procedural** files are tracked (16: README, architecture-decisions, workflows, infrastructure, projects, runtime-environment, trading-operations, consultation-schema, exogenous-triggers-spec, mira-lab-window-workflow, recovering-lost-user-input, trustquote-field-workflow, unlock-trading-routine, unlock-watchlist, hyperliquid-rate-limit-broker-plan, paper-trading-cycle-protocol). **Relationship / persona / scoped-case / financial / session-handoff files stay LOCAL-ONLY** and must never enter the allowlist (including user-context, james-master-requirements, case-operations, handoff-corrections, relationship-*.json/jsonl, mira-self-profile.json, side-profile-comms-runbook, two-squidrun-architecture). gitignore uses step-wise re-include (blanket `workspace/` then `!`-allowlist) so unlisted files fail-safe to ignored.

3. **bus-reliability-trace rotation cap (`17b510db`).** Shared writer caps active trace at 32MB, single events at 64KB, keeps 3 tail-truncated rotated archives. Fixed unbounded growth (main had hit 1.13GB). Rotated-archive readers must tolerate a partial first JSON line (byte-truncation). Legacy 2.338GB `eunbyeol-casework/.squidrun/coord/bus-reliability-trace.jsonl` cleared for deletion (dormant root, no writer/consumer).

4. **TrustQuote forward-route fix (`d6f85386`).** Forward send main→work-room previously returned `ack=unrouted` and fell back to the MAIN builder trigger; routing into profile work-rooms now repaired.

5. **Reconciler / Telegram egress credit.** The comms reconciler credits `target=user` Telegram egress as a satisfied reply (egress source-key alignment), so a real user-facing Telegram reply correctly clears the reply-guard rather than re-nagging.


## Session 399 — Changed Behavior (native DB ABI drift)

Durable behavior changes from commit `104fbd64`. Restart required to activate — the live session-399 main predates the binary fix and holds the broken in-memory state.

1. **Native-module ABI drift root cause.** The Electron main process runs Electron 28.3.3 / Node **18.18.2 / ABI 119**, which lacks `node:sqlite`; CLI scripts run system Node **24.x / ABI 137** with `node:sqlite` built in. All three main-process stores (evidence-ledger `evidence-ledger-store.js`, supervisor `supervisor/store.js`, cognitive-memory via `sqlite-compat.js`) share a `node:sqlite`-first → `better-sqlite3`-fallback `loadSqliteDriver`, so inside Electron they ALL depend on `better-sqlite3`. A stray `npm install`/`rebuild` under Node 24 recompiles `better_sqlite3.node` to ABI 137, which Electron 28 (ABI 119) then **cannot load** → every store silently enters degraded mode (reads AND writes become no-ops; there is NO write-outbox, so degraded writes are dropped, not queued). CLI scripts keep working (node:sqlite), so the on-disk journal stays populated while the running app is blind to it.

2. **Symptom decoupling — the reply-guard false-nag was downstream, not a guard bug.** A delivered `hm-send telegram` row written by the CLI (Node 24) is fully matchable (`channel=telegram`, `direction=outbound`, `status=acked`, `ack_status=telegram_delivered`, `target=user`, metadata `chatId`), but the main-process reply-guard reconciler could not query the journal at all, so it kept nagging. **Triage rule:** matchable journal row + persistent nag ⇒ suspect main-process SQLite / native-ABI health (probe `better-sqlite3` under Electron) BEFORE shipping a duplicate Telegram reply or "fixing" reply-guard logic. (Triage also in `workflows.md`.)

3. **Postinstall self-probing rebuild guard (`ui/scripts/postinstall-electron-rebuild.js`).** Wired as `ui/package.json` `postinstall`, so it runs on `npm install`/`npm ci` ONLY — never on app launch/relaunch. It first probes `better-sqlite3` in a child Electron run (`ELECTRON_RUN_AS_NODE=1`); if it loads at ABI 119 it skips, and only on probe failure does it run the targeted `electron-rebuild -f -o better-sqlite3` and re-probe. This is the **durable protection**: the rebuilt binary lives in local `node_modules` (NOT git-tracked), so the guard — not the commit — is what re-heals ABI drift on every machine and after every future Node-24 install.

4. **Restart-safety profile (verified S399 Oracle gate).** Clean quit→relaunch is lock-safe: relaunch never rebuilds, so it never unlinks the loaded `.node` (the EPERM Builder saw only occurs when a rebuild tries to replace the binary while a process holds it). No first-healthy-boot stampede: degraded stores queued nothing to replay; the reply-guard `pendingTelegramReplyGuards` map is in-memory and starts empty on boot, and its reconcile timer arms only when a guard is set + self-clears when idle; the supervisor daemon and cognitive recall are on-demand, not backlog-flushers. Caveat (not a blocker): main-process-only writes during the degraded window were silently dropped — CLI-originated rows are intact, but expect a small gap in any main-originated journal rows for that window.
