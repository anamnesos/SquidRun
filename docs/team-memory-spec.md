# Team Memory Runtime — Build Spec v0.3

**Status:** FINAL — DevOps + Architect aligned
**Author:** Architect (with inputs from DevOps #9-#12, Analyst #10-#12)
**Date:** 2026-02-13

---

## 1. Vision

Every multi-agent memory system today is a library — store, search, retrieve. Hivemind's Team Memory Runtime treats memory as an **operating system for team intelligence**: memory that understands causality, tracks beliefs, preserves disagreement, learns from failures, detects coordination patterns, and actively shapes agent behavior in real-time.

**Core thesis:** The unit of memory is not a "fact" or a "document chunk" — it's a **CLAIM** with ownership, evidence, confidence, lifecycle, and consensus state.

---

## 2. What Exists Today (Our Starting Point)

| Component | Status | Location |
|-----------|--------|----------|
| Evidence Ledger (SQLite WAL) | RUNTIME ACTIVE | `ui/modules/evidence-ledger/` |
| TraceId propagation (7 files) | SHIPPED | Across IPC/trigger/daemon pipeline |
| Intent Board JSON files | REMOVED | Replaced by Team Memory + Evidence Ledger runtime signals |
| War Room log | DEPRECATED — pending removal | `workspace/war-room.log` |
| Arch hooks (SessionStart/End, PreCompact) | ACTIVE | `workspace/scripts/arch-hooks.js` |
| Ana hooks (SessionStart/End, AfterTool) | ACTIVE | `workspace/scripts/ana-hooks.js` |
| MEMORY.md (Claude auto-memory) | ACTIVE | Per-instance `.claude/` dirs |

**Key insight:** We have the immutable event store (Evidence Ledger), propagation infrastructure (traceIds), and lifecycle hooks. What's missing are the intelligence layers on top.

---

## 3. Architecture — Five Layers

```
Layer 5: ACTIVE CONTROL PLANE     — memory shapes routing, policies, gates
Layer 4: PATTERN ENGINE            — recurring motifs, risk prediction, drift
Layer 3: BELIEF & CONSENSUS        — what agents think is true, contradictions
Layer 2: SEARCH & RETRIEVAL        — FTS5, scope queries, temporal queries
Layer 1: CLAIM GRAPH               — causal DAG, decision lineage, negative knowledge
Layer 0: EVENT STORE               — immutable evidence (ALREADY BUILT)
```

---

## 4. Database Design

### 4.1 Location & Ownership

- **Path:** `workspace/runtime/team-memory.sqlite` (persistent across sessions, co-located with Evidence Ledger)
- **Single writer:** Dedicated fork worker process (like Evidence Ledger). All writes go through the worker.
- **Read access:** Any agent can query via IPC (`team-memory:query`)
- **Failure mode:** If worker is down, reads continue (SQLite WAL allows concurrent reads). Writes spool to a **durable append-only file** at `workspace/runtime/team-memory-spool.jsonl` (same pattern as outbound WS queue). On worker recovery, spool is replayed and truncated. No silent drops — if app crashes while worker is down, spooled writes survive on disk.
- **Write ack semantics:** When worker is healthy, API returns `{accepted: true, committed: true}`. When worker is down and write is spooled, API returns `{accepted: true, queued: true}`. Callers must NOT treat queued writes as committed. A `team-memory:flushed` IPC event fires when spooled writes are committed after worker recovery.
- **Agent identity:** Canonical agent identifiers are `architect`, `devops`, `analyst`, `frontend`, `reviewer`. An alias map normalizes variants (`arch`→`architect`, `ana`→`analyst`, `infra`→`devops`, etc.) at the API boundary before any write. Consensus and claim tables store only canonical IDs — no fragmented identities.

### 4.2 Schema Versioning

```sql
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL,       -- epoch_ms
  description TEXT
);
-- Initial migration = version 1
```

All schema changes go through numbered migration scripts. Worker checks version on startup and auto-migrates.

### 4.3 Timestamps

All timestamps are **INTEGER epoch_ms** (milliseconds since Unix epoch). Faster range scans, no parsing overhead, aligns with <50ms query target.

### 4.4 Core Tables

#### claims

```sql
CREATE TABLE claims (
  id            TEXT PRIMARY KEY,       -- uuid
  idempotency_key TEXT UNIQUE,          -- prevents duplicate creation from retried hooks/CLI
  statement     TEXT NOT NULL,          -- human-readable claim
  claim_type    TEXT NOT NULL CHECK (claim_type IN ('fact', 'decision', 'hypothesis', 'negative')),
  owner         TEXT NOT NULL,          -- which agent/role created this
  confidence    REAL DEFAULT 1.0 CHECK (confidence BETWEEN 0.0 AND 1.0),
  status        TEXT DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'contested', 'deprecated')),
  supersedes    TEXT REFERENCES claims(id),
  session       TEXT,                   -- session ID (matches Evidence Ledger session_id convention)
  ttl_hours     INTEGER,               -- optional expiry (NULL = permanent)
  created_at    INTEGER NOT NULL,      -- epoch_ms
  updated_at    INTEGER NOT NULL       -- epoch_ms
);

CREATE INDEX idx_claims_status ON claims(status);
CREATE INDEX idx_claims_owner ON claims(owner);
CREATE INDEX idx_claims_type ON claims(claim_type);
CREATE INDEX idx_claims_session ON claims(session);
CREATE INDEX idx_claims_created ON claims(created_at);
```

#### claim_scopes (normalized, replaces JSON array)

```sql
CREATE TABLE claim_scopes (
  claim_id    TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL,            -- file path or domain tag
  PRIMARY KEY (claim_id, scope)
);

CREATE INDEX idx_scopes_scope ON claim_scopes(scope);
```

#### claim_evidence

```sql
CREATE TABLE claim_evidence (
  claim_id      TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  evidence_ref  TEXT NOT NULL,          -- Evidence Ledger event ID (TEXT ref, not FK — separate DB)
  added_by      TEXT NOT NULL,          -- agent that attached this evidence (may differ from claim owner)
  relation      TEXT NOT NULL CHECK (relation IN ('supports', 'contradicts', 'caused_by')),
  weight        REAL DEFAULT 1.0,
  created_at    INTEGER NOT NULL,       -- epoch_ms
  PRIMARY KEY (claim_id, evidence_ref)
);
```

**Cross-DB linkage note:** Evidence Ledger lives in a separate SQLite database. `evidence_ref` is a TEXT reference to the ledger's event ID — no true FK constraint. Validation happens at the application layer. This is an intentional trade-off: separate DBs allow independent WAL/locking, and the ledger's immutability means referenced rows won't disappear.

#### claim_status_history (audit trail)

```sql
CREATE TABLE claim_status_history (
  id            TEXT PRIMARY KEY,
  claim_id      TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  old_status    TEXT,
  new_status    TEXT NOT NULL,
  changed_by    TEXT NOT NULL,          -- agent that made the change
  reason        TEXT,
  changed_at    INTEGER NOT NULL        -- epoch_ms
);

CREATE INDEX idx_history_claim ON claim_status_history(claim_id);
```

#### decisions

```sql
CREATE TABLE decisions (
  id            TEXT PRIMARY KEY,
  claim_id      TEXT NOT NULL REFERENCES claims(id),
  decided_by    TEXT NOT NULL,          -- agent that made the final call (may differ from claim owner)
  context       TEXT,                   -- what problem this addressed
  rationale     TEXT,                   -- why this was chosen
  outcome       TEXT CHECK (outcome IN ('success', 'partial', 'failure', 'unknown')),
  outcome_notes TEXT,
  created_at    INTEGER NOT NULL,       -- epoch_ms
  session       TEXT                    -- session ID (matches Evidence Ledger convention)
);
```

#### decision_alternatives (join table, replaces JSON array)

```sql
CREATE TABLE decision_alternatives (
  decision_id     TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  alternative_id  TEXT NOT NULL REFERENCES claims(id),
  rejection_reason TEXT,
  PRIMARY KEY (decision_id, alternative_id)
);
```

#### consensus

```sql
CREATE TABLE consensus (
  id            TEXT PRIMARY KEY,
  claim_id      TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  agent         TEXT NOT NULL,
  position      TEXT NOT NULL CHECK (position IN ('support', 'challenge', 'abstain')),
  reason        TEXT,
  created_at    INTEGER NOT NULL,       -- epoch_ms
  UNIQUE (claim_id, agent)              -- one position per agent per claim
);

CREATE INDEX idx_consensus_claim ON consensus(claim_id);
```

#### belief_snapshots

```sql
CREATE TABLE belief_snapshots (
  id              TEXT PRIMARY KEY,
  agent           TEXT NOT NULL,
  session         TEXT NOT NULL,          -- session ID (matches Evidence Ledger convention)
  snapshot_at     INTEGER NOT NULL,     -- epoch_ms
  beliefs         TEXT NOT NULL          -- JSON: [{claim_id, confidence}]
);

CREATE INDEX idx_snapshots_agent ON belief_snapshots(agent);
CREATE INDEX idx_snapshots_session ON belief_snapshots(session);
```

#### belief_contradictions (normalized from snapshot — queryable without JSON parsing)

```sql
CREATE TABLE belief_contradictions (
  id              TEXT PRIMARY KEY,
  snapshot_id     TEXT NOT NULL REFERENCES belief_snapshots(id) ON DELETE CASCADE,
  claim_a         TEXT NOT NULL REFERENCES claims(id),
  claim_b         TEXT NOT NULL REFERENCES claims(id),
  agent           TEXT NOT NULL,          -- denormalized for fast filtering
  session         TEXT NOT NULL,          -- denormalized for fast filtering
  detected_at     INTEGER NOT NULL,       -- epoch_ms
  reason          TEXT                    -- why these contradict (optional explanation)
);

CREATE INDEX idx_contradictions_agent ON belief_contradictions(agent);
CREATE INDEX idx_contradictions_session ON belief_contradictions(session);
CREATE INDEX idx_contradictions_claim_a ON belief_contradictions(claim_a);
CREATE INDEX idx_contradictions_claim_b ON belief_contradictions(claim_b);
```

#### patterns

```sql
CREATE TABLE patterns (
  id            TEXT PRIMARY KEY,
  pattern_type  TEXT NOT NULL CHECK (pattern_type IN ('handoff_loop', 'escalation_spiral', 'stall', 'contradiction_cluster')),
  agents        TEXT NOT NULL,          -- JSON array
  scope         TEXT,
  frequency     INTEGER DEFAULT 1,
  first_seen    INTEGER NOT NULL,       -- epoch_ms
  last_seen     INTEGER NOT NULL,       -- epoch_ms
  risk_score    REAL CHECK (risk_score BETWEEN 0.0 AND 1.0),
  resolution    TEXT
);

CREATE INDEX idx_patterns_type ON patterns(pattern_type);
CREATE INDEX idx_patterns_risk ON patterns(risk_score);
```

#### guards

```sql
CREATE TABLE guards (
  id                TEXT PRIMARY KEY,
  trigger_condition TEXT NOT NULL,       -- JSON: event pattern to match
  action            TEXT NOT NULL CHECK (action IN ('warn', 'escalate')),
  source_claim      TEXT REFERENCES claims(id),
  source_pattern    TEXT REFERENCES patterns(id),
  active            INTEGER DEFAULT 1,
  created_at        INTEGER NOT NULL,   -- epoch_ms
  expires_at        INTEGER             -- epoch_ms, optional TTL
);

CREATE INDEX idx_guards_active ON guards(active) WHERE active = 1;
```

**Note:** Guards can only `warn` or `escalate` — no `require_review` or `block` in initial cut (deferred per DevOps review). Auto-blocking is too aggressive before we validate contradiction detection precision.

---

## 5. Claim Status State Machine

```
                 ┌──────────────┐
                 │   proposed   │ ← initial state on creation
                 └──────┬───────┘
                        │
            ┌───────────┼───────────┐
            ▼           ▼           ▼
     ┌────────────┐ ┌──────────┐ ┌────────────┐
     │  confirmed │ │ contested│ │ deprecated │
     └─────┬──────┘ └────┬─────┘ └────────────┘
           │              │              ▲
           │              │              │
           └──────────────┴──────────────┘
```

**Transition rules:**
- `proposed → confirmed`: All consensus edges are `support` (minimum 1 support, 0 challenges)
- `proposed → contested`: Any consensus edge is `challenge`
- `proposed → deprecated`: Owner deprecates own unconfirmed claim
- `confirmed → contested`: New `challenge` edge added
- `confirmed → deprecated`: Owner or Architect deprecates
- `contested → confirmed`: All `challenge` edges withdrawn (agent changes position to support)
- `contested → deprecated`: Owner or Architect deprecates
- `deprecated → (any)`: **NOT ALLOWED** — deprecated is terminal. Create a new claim with `supersedes` instead.

**All transitions are recorded in `claim_status_history`.**

---

## 6. Build Phases (Revised Order Per DevOps Review)

### Phase 0: Foundation & Cleanup

**Owner:** DevOps
**Goal:** Solid base for everything above

- [ ] Audit Evidence Ledger schema — verify traceId/causationId consistency
- [ ] Verify hook entry points (PreToolUse for Codex panes? — check capabilities)
- [ ] War Room log: add structured JSON metadata to entries (from, to, timestamp, traceId)
- [ ] Define boot/backfill process: on first run, scan Evidence Ledger for historical events that should seed initial claims. **Backfill idempotency contract:** idempotency_key for backfilled claims is derived deterministically from source event data (`backfill:{event_type}:{event_id}`). Re-running backfill on the same ledger produces identical keys → no duplicates via UNIQUE constraint on idempotency_key.
- [ ] Scaffold `ui/modules/team-memory/` directory + worker process skeleton
- [ ] Schema migration runner + version 1 migration script
- [ ] Cross-DB evidence_ref integrity checker: periodic scan (SessionStart + nightly TTL sweep) that verifies all `claim_evidence.evidence_ref` TEXT pointers resolve to actual Evidence Ledger entries. Orphans logged to `workspace/build/errors.md` with claim ID and stale ref. Non-blocking — reports only, does not auto-delete.

### Phase 1: Claim Graph (Layer 1)

**Owner:** DevOps (infra) + Architect (schema)
**Goal:** Core CRUD — boring, strict, correct

- [ ] Create `team-memory.sqlite` with all core tables (claims, claim_scopes, claim_evidence, claim_status_history, decisions, decision_alternatives)
- [ ] Single-writer fork worker process (mirrors Evidence Ledger pattern)
- [ ] CRUD module: `ui/modules/team-memory/claims.js`
  - createClaim(data) — with idempotency_key dedup
  - queryClaims(filters) — by scope, type, status, owner, session, time range
  - updateClaimStatus(id, newStatus, changedBy, reason) — enforces state machine
  - deprecateClaim(id, changedBy, reason)
  - addEvidence(claimId, evidenceRef, relation)
  - createDecision(data) — with alternatives as join table rows
  - recordOutcome(decisionId, outcome, notes)
- [ ] CLI script: `ui/scripts/hm-claim.js` (create/query/deprecate)
- [ ] IPC handlers: `team-memory:create`, `team-memory:query`, `team-memory:update`, `team-memory:deprecate`
- [ ] Negative knowledge: claims with type='negative', queryable by scope
- [ ] Tests: schema validation, CRUD ops, idempotency, state machine transitions, evidence binding, decision lineage

### Phase 2: Search & Retrieval (Layer 2)

**Owner:** DevOps
**Goal:** Make claims queryable before building consensus on top
**Depends on:** Phase 1

- [ ] FTS5 virtual table over claims.statement
- [ ] Scope-based retrieval: "all claims about triggers.js" (via claim_scopes index)
- [ ] Temporal queries: "claims from session 120-123" (via epoch_ms range scan)
- [ ] Confidence-weighted result ordering
- [ ] Context injection via SessionStart hook: load relevant claims for agent's domain
- [ ] CLI: `hm-claim search "query"` with scope/time/type filters
- [ ] Tests: search accuracy, index performance, hook integration

**Vector search deferred.** FTS5 + scope indexes are sufficient for our claim volume (hundreds to low thousands). Vector embeddings add provider dependency with marginal gain at this scale.

### Phase 3: Consensus & Belief (Layer 3)

**Owner:** DevOps (infra) + Architect (protocol)
**Depends on:** Phase 1 + 2

- [ ] Consensus table + edges (support/challenge/abstain)
- [ ] Auto-status update trigger: recompute claim status on consensus change
- [ ] Belief snapshot creation (triggered by SessionEnd hook + on-demand)
- [ ] Contradiction detector: compare snapshots across agents, flag mismatches
- [ ] Architect notification on contradiction (via IPC → war room entry)
- [ ] CLI: `hm-claim challenge <claim-id> --reason "..."`
- [ ] CLI: `hm-claim support <claim-id> --reason "..."`
- [ ] Tests: consensus resolution, contradiction detection, snapshot creation

**Deferred to later phase (per DevOps review):**
- Per-claim `memory_permissions` table — all claims readable by all agents for now
- Trust-weighted arbitration — defer until contradiction detection precision is proven
- Auto-policy blocking — warn/escalate only, no hard blocks initially

### Phase 4: Pattern Engine (Layer 4)

**Owner:** DevOps (mining logic) + Analyst (validation)
**Depends on:** Phase 1 + 2 + 3

- [ ] Patterns table + types
- [ ] HYBRID pattern runtime:
  - **Hook path (lightweight):** PostToolUse/trigger hooks do cheap event ingestion + immediate lightweight checks (e.g., "is this the 3rd blocker on same scope?"). Runs in main process, must be <5ms.
  - **Worker path (heavy):** Fork worker handles expensive mining, scoring, playbook extraction, cross-session analysis. Runs on schedule (every N minutes) or on-demand via IPC.
- [ ] Handoff loop detection
- [ ] Escalation spiral detection
- [ ] Silent stall detection
- [ ] Contradiction cluster detection
- [ ] Risk score calculation (frequency-weighted, time-decayed)
- [ ] Playbook extraction from successful multi-agent workflows
- [ ] Tests: pattern detection, false positive rate, risk scoring

### Phase 5: Active Control Plane (Layer 5)

**Owner:** DevOps (guard execution) + Architect (policy)
**Depends on:** Phase 1-4
**Gate:** Only start after Phase 3 contradiction precision is validated

- [ ] Guards table + CRUD
- [ ] Guard evaluation in hook pipeline (warn/escalate only — no hard blocks initially)
- [ ] PostToolUse integration: auto-create claims from significant tool results
- [ ] Guard suggestion engine: recommend guards from pattern data (human-approved, not auto-created)
- [ ] Agent calibration table + auto-update logic (informational only — no enforcement yet)
- [ ] Tests: guard evaluation, suggestion quality

---

## 7. Migration & Cleanup

### What Stays

| Component | Fate | Notes |
|-----------|------|-------|
| Evidence Ledger | KEEP as Layer 0 | Immutable backing store, no changes |
| Intent Board JSON files | REMOVED | Runtime writes now go directly to Team Memory/Evidence Ledger |
| War Room log | KEEP + ENHANCE | Add structured metadata (Phase 0) |
| Session Handoff | KEEP | May eventually derive from claim queries |
| MEMORY.md | KEEP | Orthogonal — Claude auto-memory for model-specific notes |

**Backup/restore:** `team-memory.sqlite` should be included in any backup/restore process. Add explicit `hm-claim export` and `hm-claim import` CLI commands for portability. SQLite `.backup` API can be used for hot copies.

**Intent-board deprecation note (historical):** This spec originally planned dual-write. Runtime has since cut over to Team Memory/Evidence Ledger-only writes and removed JSON intent files.

### What's New

- `workspace/runtime/team-memory.sqlite` — single database for Layers 1-5
- `ui/modules/team-memory/` — module directory
  - `worker.js` — fork worker (single writer)
  - `claims.js` — CRUD for claims + evidence bindings + decisions
  - `consensus.js` — consensus edges + contradiction detection
  - `patterns.js` — pattern mining engine
  - `guards.js` — active control plane
  - `search.js` — FTS5 + scope + temporal queries
  - `migrations/` — numbered schema migration scripts
- `ui/scripts/hm-claim.js` — CLI for claim operations
- `ui/modules/ipc/team-memory-handlers.js` — IPC handlers

---

## 8. TTL & Retention

- **Default:** Claims have no TTL (permanent until deprecated)
- **Optional TTL:** `ttl_hours` field for hypothesis-type claims that should auto-expire
- **Sweeper:** Runs on SessionStart hook. Marks expired claims as `deprecated` with reason `ttl_expired`. Does NOT delete rows — deprecated claims remain queryable for negative knowledge.
- **Clock source:** `Date.now()` (system clock). No NTP dependency.
- **Retention policy:** No auto-purge in v1. If DB grows >100MB, add manual archive command later.

---

## 9. Open Questions (Resolved)

| Question | Resolution |
|----------|-----------|
| Where does team-memory.sqlite live? | `workspace/runtime/` — persistent, co-located with Evidence Ledger |
| Single writer or multi-writer? | Single writer (fork worker) — consistent with Evidence Ledger pattern |
| Claims survive across sessions? | Yes — that's the whole point |
| Pattern engine: worker or hook? | HYBRID — hooks for cheap ingestion/immediate checks, worker for heavy mining/scoring |
| Vector search? | Deferred — FTS5 sufficient at our scale |
| Intent board deprecation? | Completed — JSON intent files removed from runtime |
| Guard enforcement level? | Warn/escalate only — no hard blocks until precision proven |
| Trust/calibration enforcement? | Informational only — no weighted arbitration until Phase 3 validated |

---

## 10. Novelty Summary

Research survey (2026-02-13) of LangGraph, CrewAI, AutoGen, OpenClaw, Observational Memory (Mastra), GAM, Mem0, MIRIX, and the "Memory in the Age of AI Agents" survey (arxiv 2512.13564) confirms no existing system combines: CLAIM lifecycle, consensus/dissent preservation, negative knowledge, coordination pattern mining, or memory-driven runtime guards. Closest prior art is CrewAI's shared ChromaDB (flat store, no claims) and classical BDI (beliefs without multi-agent disagreement preservation).

---

## 11. Success Criteria

- [ ] Agents can create, query, challenge, and deprecate claims via CLI or IPC
- [ ] All status transitions follow the state machine and are audited
- [ ] Contradictions between agents are automatically detected and surfaced to Architect
- [ ] Failed approaches are stored as negative claims and warn against repetition
- [ ] Recurring coordination patterns are detected and risk-scored
- [ ] Guards can warn or escalate based on claims and patterns
- [ ] All queries complete in < 50ms for typical operations (< 1000 claims), verified via benchmark harness with fixed synthetic dataset (100/500/1000 claims, mixed types and scopes)
- [ ] Full test coverage for each phase
- [ ] Existing Evidence Ledger and hooks remain stable while intent-board JSON paths stay removed
- [ ] Single-writer worker process with graceful degradation on failure

---

## 12. Experiment Engine (Phase 6)

**Status:** SPEC — DevOps + Architect aligned on architecture + risk controls
**Concept:** When a claim is contested, agents don't argue — they run an experiment. An isolated PTY executes a test, captures evidence, and attaches it to the claim as executable proof.

### 12.1 Core Concept

The unit of proof is not an opinion — it's an **EXPERIMENT** with a hypothesis, execution, result, and evidence chain.

```
Agent proposes claim → Another agent contests → Experiment runs → Evidence attached → Claim resolved with proof
```

"Don't argue — run the experiment."

### 12.2 Architecture

**Worker pair pattern** (same as team-memory, comms, evidence-ledger workers):

| Component | Path | Role |
|-----------|------|------|
| Worker | `ui/modules/experiment/worker.js` | Owns ephemeral node-pty spawn, captures output, enforces timeout |
| Worker Client | `ui/modules/experiment/worker-client.js` | Main-process API, request/response via reqId |
| CLI | `ui/scripts/hm-experiment.js` | Agent-facing: create, get, list experiments |
| IPC | `team-memory:run-experiment` | Renderer/main bridge |

**Main process is orchestrator only** — enqueue run, map result to claim evidence. Worker owns the full PTY lifecycle.

### 12.3 Evidence Flow (tamper-evident)

Experiments do NOT attach raw file paths to claims. Evidence flows through the Ledger:

```
1. Agent calls run_experiment(profile, claimId)
2. Fork worker spawns isolated PTY (no UI binding)
3. Captures stdout, stderr, exit code, duration
4. Artifacts saved to workspace/runtime/experiments/<runId>/
   ├── stdout.log
   ├── stderr.log
   └── meta.json (git SHA, cwd, env fingerprint, timestamps, hashes)
5. Worker reports result to main process
6. Main creates Evidence Ledger event: experiment.completed
   - payload: artifact paths + SHA-256 hashes + exit code + profile name
7. claim_evidence row links claim → ledger event ID
   - relation: 'supports' (exit 0) or 'contradicts' (exit non-0)
8. Integrity checker validates evidence_ref → ledger event (existing scan)
```

Tamper-evident: hashes are in the immutable Ledger. Artifacts are for replay — the proof is the hash.

### 12.4 Experiment Schema

```sql
CREATE TABLE experiments (
  id              TEXT PRIMARY KEY,
  claim_id        TEXT REFERENCES claims(id),
  profile         TEXT NOT NULL,          -- named test profile (no raw shell)
  command         TEXT NOT NULL,          -- resolved command from profile
  requested_by    TEXT NOT NULL,          -- agent that requested the experiment
  status          TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'canceled', 'attach_pending', 'attached')),
  exit_code       INTEGER,
  duration_ms     INTEGER,
  stdout_hash     TEXT,                   -- SHA-256 of stdout.log
  stderr_hash     TEXT,                   -- SHA-256 of stderr.log
  git_sha         TEXT,                   -- repo state at execution time
  evidence_ref    TEXT,                   -- Evidence Ledger event ID (set after completion)
  session         TEXT,                   -- session ID
  created_at      INTEGER NOT NULL,       -- epoch_ms
  completed_at    INTEGER                 -- epoch_ms
);

CREATE INDEX idx_experiments_claim ON experiments(claim_id);
CREATE INDEX idx_experiments_status ON experiments(status);
CREATE INDEX idx_experiments_session ON experiments(session);
```

### 12.5 Test Profiles (named only — no raw shell)

Experiments run **named profiles**, not arbitrary commands. This prevents command injection from claim text.

```json
// workspace/runtime/experiment-profiles.json
{
  "jest-suite": {
    "command": "cd /d/projects/hivemind/ui && npx jest --no-coverage",
    "timeout_ms": 120000,
    "description": "Full test suite"
  },
  "jest-file": {
    "command": "cd /d/projects/hivemind/ui && npx jest --no-coverage -- {file}",
    "timeout_ms": 30000,
    "params": ["file"],
    "description": "Single test file"
  },
  "lint": {
    "command": "cd /d/projects/hivemind/ui && npx eslint {file}",
    "timeout_ms": 15000,
    "params": ["file"],
    "description": "Lint a specific file"
  }
}
```

Parameters are validated and sanitized at the API boundary. Only registered profile names are accepted.

### 12.6 Risk Controls

| Risk | Control |
|------|---------|
| Command injection | Named profiles only — no raw shell from claim text or agent input |
| Resource leaks / hangs | Hard timeout per profile + kill entire process tree + max 1 concurrent run |
| Log growth / secrets | Output byte cap (default 1MB) + optional redaction patterns + retention TTL |
| Reproducibility | Git SHA + cwd + env fingerprint captured in meta.json |
| Orphaned processes | Worker monitors child PID, kills on timeout/crash/shutdown |

### 12.7 Guard Integration

Guards can auto-trigger experiments on contested claims:

| Guard action | Experiment behavior |
|-------------|-------------------|
| `warn` / `suggest` | Experiment runs async, result logged but doesn't block |
| `block` | Claim status set to `pending_proof`, block path gates on experiment result |
| `escalate` | Experiment runs, result forwarded to Architect for decision |

**New claim status:** `pending_proof` — claim is contested and awaiting experiment result before resolution.

### 12.8 API Contract

**create-experiment** (alias: `run-experiment`, `run_experiment`)
```
Request: {
  profileId,              -- named profile (required)
  claimId?,               -- claim to link (optional — can attach later)
  relation?,              -- 'supports' | 'contradicts' | 'caused_by'
  requestedBy,            -- agent requesting the experiment
  scope?,                 -- file/module scope for context
  input: {
    repoPath?,            -- override cwd
    args?,                -- profile parameter values
    envAllowlist?         -- env vars to pass through (explicit, not implicit)
  },
  timeoutMs?,             -- override profile default
  outputCapBytes?,        -- override default 1MB cap
  redactionRules?,        -- patterns to scrub from output
  idempotencyKey?,        -- dedup repeated runs
  guardContext?: {
    guardId,              -- which guard triggered this
    action,               -- warn | block | suggest | escalate
    blocking: bool        -- whether caller waits for result
  }
}
Response: { ok, runId, status: 'queued'|'running'|'rejected', artifactDir, reason? }
```

**get-experiment**
```
Request: { runId }
Response: {
  ok, experiment: {
    runId, profileId, status,  -- queued|running|succeeded|failed|timed_out|canceled|attach_pending|attached
    requestedBy, claimId?, relation?, guardContext?,
    startedAt?, finishedAt?, exitCode?, durationMs?, timeoutMs,
    cwd, git: { sha, branch, dirty },
    commandPreview,            -- sanitized command (no secrets)
    artifactDir,
    files: { stdout, stderr, meta, result },
    output: { stdoutBytes, stderrBytes, truncated, redacted },
    attach: { evidenceEventId?, claimEvidenceStatus? },
    error?
  }
}
```

**list-experiments**
```
Request: { status?, profileId?, claimId?, guardId?, sinceMs?, untilMs?, limit?, cursor? }
Response: { ok, experiments: [summary...], nextCursor? }
```

**attach-to-claim**
```
Request: { runId, claimId, relation, addedBy, summary? }
Response: { ok, status: 'attached'|'duplicate'|'not_attachable', evidenceEventId, claimId, relation }
```

Integrity rule: attach always goes through Evidence Ledger event_id. Ledger event payload points to experiment artifacts. claim_evidence.evidence_ref = ledger event ID. Existing integrity checker validates the chain.

### 12.9 Build Phases

#### Phase 6a: Foundation
- [ ] Experiment profiles schema + loader (`workspace/runtime/experiment-profiles.json`)
- [ ] `experiments` table via migration v6
- [ ] Worker pair: `ui/modules/experiment/worker.js` + `worker-client.js`
- [ ] PTY spawn + capture + timeout + kill tree
- [ ] Artifact storage: `workspace/runtime/experiments/<runId>/`

#### Phase 6b: Evidence Chain
- [ ] Evidence Ledger integration: `experiment.completed` event with hashes
- [ ] Auto-attach to claim_evidence (supports/contradicts based on exit code)
- [ ] `pending_proof` claim status (add to state machine)
- [ ] Guard trigger: block-path guards auto-queue experiments

#### Phase 6c: CLI + IPC
- [ ] `hm-experiment.js` CLI (create, get, list)
- [ ] IPC handlers: `team-memory:run-experiment`, `team-memory:get-experiment`, `team-memory:list-experiments`
- [ ] App wiring: init/shutdown worker in hivemind-app.js

#### Phase 6d: Tests
- [ ] Worker isolation tests (spawn, capture, timeout, kill)
- [ ] Evidence chain tests (artifact → ledger → claim_evidence)
- [ ] Profile validation tests (injection prevention, param sanitization)
- [ ] Guard integration tests (auto-trigger, pending_proof, block-path gating)
- [ ] Full suite regression

### 12.10 Deferred

- **Video/terminal recording** — capture full PTY render as asciinema-compatible recording (adds visual replay)
- **Parallel experiments** — raise max concurrent from 1 when resource usage is validated
- **Remote execution** — run experiments on remote machines / CI runners
- **Experiment history comparison** — "this test passed in Session 118 but fails now, what changed?"
