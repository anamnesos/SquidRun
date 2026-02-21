# Event Kernel Specification

**Version:** 0.2 | **Status:** Phase 0 — Team Review Complete
**Authors:** Architect, DevOps, Analyst

---

## 1. Overview

The Event Kernel is a two-lane system at the core of SquidRun that replaces implicit side-effect coordination with explicit, typed, traceable events.

- **Lane A (Interaction Kernel):** Always-on control path. Enforces ownership, sequencing, and contracts. Cannot be disabled.
- **Lane B (Timeline / Telemetry):** Optional observability path. Event logging, health strip, replay. Controlled at runtime through Event Bus API controls (`setTelemetryEnabled`), not persisted settings toggles.

**Feature flag / kill-switch:** Lane B has a kill-switch. Lane A does NOT — it is load-bearing infrastructure. If Lane A encounters errors, it degrades to safe mode (Section 5.4), never silently disables.

---

## 2. Event Envelope

Every event in the system uses this shape, regardless of source (renderer or daemon):

```javascript
{
  eventId: string,        // UUID v4 — unique per event
  correlationId: string,  // UUID v4 — links all events in one logical operation
  causationId: string,    // eventId of the direct parent event (null for root events)
  type: string,           // dot-notation, e.g. "inject.requested"
  source: string,         // emitting module, e.g. "injection.js", "daemon", "terminal.js"
  paneId: string,         // "1" | "2" | "3" | "system"
  ts: number,             // Date.now() — millisecond timestamp
  seq: number,            // per-source monotonic sequence number (resets per session)
  payload: object         // action-specific data (sanitized by default)
}
```

### Correlation Rules
- A new `correlationId` is minted when a root action begins (e.g., trigger file detected, WebSocket message received, user types Enter).
- All downstream events from that action share the same `correlationId`.
- `causationId` creates a parent-child chain within the correlation group.

### Sequence Numbers
- Each `source` maintains its own monotonic `seq` counter.
- Starts at 1 per session. Never resets mid-session.
- Used to detect out-of-order or dropped events across process boundaries.

### Payload Sanitization
- By default, message body content is redacted: `{ redacted: true, length: N }`.
- Full payloads available only when Event Bus dev mode is explicitly enabled (`setDevMode(true)`) for controlled debugging.

---

## 3. Event Taxonomy

### 3.1 Injection Lifecycle
| Event | Emitter | Description |
|-------|---------|-------------|
| `inject.requested` | injection.js | Message injection initiated |
| `inject.queued` | injection.js | Added to pane's injection queue |
| `inject.deferred` | kernel | Blocked by contract (payload: `{ reason, contractId }`) |
| `inject.resumed` | kernel | Deferred injection released |
| `inject.applied` | injection.js | Text written to terminal/textarea |
| `inject.submit.requested` | injection.js | Submit action initiated |
| `inject.submit.sent` | injection.js | Submit keypress/action dispatched |
| `inject.verified` | injection.js | Submit confirmed (output activity detected) |
| `inject.failed` | injection.js | Submit verification failed |
| `inject.timeout` | injection.js | Verification timed out |
| `inject.retry` | injection.js | Retrying after failure |
| `inject.dropped` | kernel | Dropped after TTL expiry or max retries (payload: `{ reason }`) |
| `inject.transform.applied` | injection.js | Payload transformed for target CLI |
| `inject.transform.lossy` | injection.js | Transform lost content (e.g., multiline truncation) |
| `inject.mode.selected` | injection.js | CLI-specific injection mode chosen (payload: `{ mode, paneId }`) |
| `verify.pass` | injection.js | Verification passed cleanly |
| `verify.false_positive` | injection.js | Verification passed but suspect (payload: `{ suspectedCompaction, confidenceAtVerify }`) |
| `queue.depth.changed` | injection.js | Queue size changed (payload: `{ paneId, depth }`) |

### 3.2 Focus Lifecycle
| Event | Emitter | Description |
|-------|---------|-------------|
| `focus.changed` | terminal.js | Active pane focus changed |
| `focus.locked` | injection.js | Focus locked for injection (payload: `{ owner }`) |
| `focus.released` | injection.js | Focus lock released |
| `focus.arbitration.requested` | kernel | Focus requested by multiple sources |
| `focus.arbitration.resolved` | kernel | Arbitration decided (payload: `{ winner, loser }`) |
| `focus.arbitration.conflict` | kernel | Unresolvable simultaneous focus requests |
| `focus.steal.blocked` | kernel | Agent focus steal blocked by user lock |
| `typing.activity` | terminal.js | User typing detected on pane |
| `typing.idle` | terminal.js | User typing ceased on pane |

### 3.3 Resize Lifecycle
| Event | Emitter | Description |
|-------|---------|-------------|
| `resize.requested` | renderer.js | Resize triggered (window drag, panel toggle) |
| `resize.started` | terminal.js | fitAddon.fit() called |
| `resize.completed` | terminal.js | fit completed successfully |
| `resize.coalesced` | kernel | Multiple resize intents merged to latest dimensions |
| `resize.storm.detected` | kernel | Resize frequency exceeded threshold |
| `fit.skipped` | terminal.js | fit() intentionally skipped (payload: `{ reason }`) |
| `pty.resize.requested` | terminal.js | PTY resize signal sent |
| `pty.resize.ack` | daemon | PTY resize acknowledged |

### 3.4 Mode / State
| Event | Emitter | Description |
|-------|---------|-------------|
| `overlay.opened` | renderer.js | Settings/modal overlay opened |
| `overlay.closed` | renderer.js | Settings/modal overlay closed |
| `cli.compaction.suspected` | terminal.js | Compaction-like output detected (payload: `{ confidence, signals[] }`) |
| `cli.compaction.started` | terminal.js | Compaction confirmed (payload: `{ confidence, transitionReason }`) |
| `cli.compaction.ended` | terminal.js | Compaction ended (payload: `{ durationMs, endReason }`) |
| `pane.state.changed` | kernel | Pane state vector transition (payload: full vector diff) |
| `pane.visibility.changed` | renderer.js | Pane shown/hidden |
| `ui.longtask.detected` | renderer.js | Main thread blocked > 50ms |

### 3.5 Daemon / Bridge
| Event | Emitter | Description |
|-------|---------|-------------|
| `daemon.write.requested` | daemon | PTY write requested (payload: `{ paneId, dataLen, mode, requestedBy }`) |
| `daemon.write.ack` | daemon | PTY write result (payload: `{ paneId, status, reason? }`) |
| `pty.data.received` | daemon | PTY data chunk (metadata-first: `{ paneId, byteLen, meaningful, chunkType }`) |
| `bridge.connected` | bridge | IPC bridge established |
| `bridge.disconnected` | bridge | IPC bridge lost |
| `event.dropped` | bridge | Event(s) lost in transit (payload: `{ stage, reason, droppedCount, oldestSeq, newestSeq }`) |
| `pty.up` | daemon | PTY process alive/restored for pane |
| `pty.down` | daemon | PTY process dead/unresponsive for pane |

**`daemon.write.ack` status enum:** `accepted` | `rejected_terminal_missing` | `rejected_not_alive` | `rejected_mode_noninteractive` | `blocked_ghost_dedup` | `error`

**`pty.data.received` policy:** Coalesced at 50-100ms window per pane for Lane B. Full chunk body only in dev mode with explicit sampling gate. Never full payload by default.

### 3.6 Contract Events
| Event | Emitter | Description |
|-------|---------|-------------|
| `contract.checked` | kernel | Contract precondition evaluated |
| `contract.violation` | kernel | Enforced contract violated |
| `contract.shadow.violation` | kernel | Shadow-mode contract would have violated |
| `contract.override` | kernel | Contract bypassed (e.g., high-priority intent) |
| `contract.promoted` | kernel | Contract promoted from shadow to enforced |

### 3.7 System
| Event | Emitter | Description |
|-------|---------|-------------|
| `safemode.entered` | kernel | Safe mode activated (payload: `{ triggerReason }`) |
| `safemode.exited` | kernel | Safe mode deactivated |
| `bus.error` | event-bus.js | Internal bus error (Lane B affected, Lane A continues) |
| `telemetry.enabled` | event-bus.js | Lane B enabled via API/runtime control |
| `telemetry.disabled` | event-bus.js | Lane B disabled via API/runtime control |

---

## 4. Per-Pane State Vector

Pane state is modeled as a **state vector** with orthogonal lanes, not a single enum. This reflects real-world conditions where multiple states coexist (e.g., injecting while compaction is suspected, resizing while focus is locked).

### 4.1 State Vector Shape

```javascript
{
  activity: 'idle' | 'injecting' | 'resizing' | 'recovering' | 'error',
  gates: {
    focusLocked: boolean,       // user typing lock active
    compacting: 'none' | 'suspected' | 'confirmed' | 'cooldown',
    safeMode: boolean
  },
  connectivity: {
    bridge: 'up' | 'down',
    pty: 'up' | 'down'
  }
}
```

`pane.state.changed` emits the full vector diff whenever any component transitions.

### 4.2 Core Transition Rules

1. `inject.requested` while `focusLocked=true` OR `compacting=confirmed` → `inject.deferred`
2. `inject.requested` while allowed → `activity=injecting`
3. `inject.verified` | `inject.failed` | `inject.dropped` → `activity=idle` (unless another active op)
4. `resize.requested` during `activity=injecting` → coalesce/defer resize, do NOT preempt submit path
5. `bridge.disconnected` | `pty.down` → `activity=recovering` (or `error` if recovery fails)
6. `overlay.opened` + resize intent → `fit.skipped(reason=overlay_open)`

### 4.3 Legal Co-Existing States

These combinations are valid and must be handled:
- `injecting` + `focusLocked=true` (user took lock mid-injection flow)
- `resizing` + `compacting=suspected`
- `idle` + `compacting=confirmed`
- `recovering` + `safeMode=true`

### 4.4 Edge Cases

1. **Dual gate deferral:** Injection blocked by BOTH focus lock and compaction. Store ordered reasons in `inject.deferred` payload.
2. **Compaction starts mid-verification:** Verification result degrades to `verify.false_positive`, not clean `verify.pass`.
3. **Resize storm during deferred queue:** Resizes must coalesce to latest dimensions to prevent backlog amplification.
4. **Safe mode during active injection:** Finish or abort deterministically, then freeze non-critical new intents.
5. **Bridge reconnect with pending deferred intents:** Resume in FIFO with gate re-check on each dequeue.

---

## 5. Contracts

### 5.1 Contract Shape

```javascript
{
  id: string,              // e.g. "inject-requires-no-focus-lock"
  version: number,         // schema version
  owner: string,           // responsible module
  appliesTo: string[],     // event types this contract governs
  preconditions: Function[], // pure predicates — (event, stateVector) => boolean
  severity: string,        // "block" | "warn" | "info"
  action: string,          // see Action Enum below
  fallbackAction: string,  // deterministic safe-mode behavior (documented)
  mode: string,            // "enforced" | "shadow"
  emitOnViolation: string  // event type to emit
}
```

### 5.1.1 Action Enum (Canonical)

| Action | Meaning | Use When |
|--------|---------|----------|
| `defer` | Queue the event, retry when gate clears or TTL expires → drop | Temporary blocker expected to resolve (focus lock, compaction) |
| `drop` | Discard the event immediately, emit reason | Permanent conflict or TTL expiry |
| `block` | Reject the event, do not queue, emit violation | Hard conflict (ownership exclusivity) |
| `skip` | Let the triggering action proceed but skip the side-effect | Safe to continue but side-effect is harmful (fit during overlay) |
| `continue` | Allow event, emit warning only | Informational contracts, shadow mode |

### 5.2 Day-1 Enforced Contracts

| ID | Applies To | Precondition | Action | Fallback | Bypass |
|----|-----------|--------------|--------|----------|--------|
| `focus-lock-guard` | `inject.requested` | `gates.focusLocked !== true` | defer | defer → TTL expiry → drop | None |
| `compaction-gate` | `inject.requested` | `gates.compacting !== 'confirmed'` | defer | defer → compaction.ended or TTL → drop with `inject.dropped(reason=compaction_timeout)` | kill/restart intents bypass |
| `ownership-exclusive` | `inject.requested`, `resize.requested` | No other active operation on this pane | block | block + emit violation | None |
| `overlay-fit-exclusion` | `resize.started` | `overlay.open !== true` | skip | `fit.skipped(reason=overlay_open)` | None |

**Enforcement location:** `focus-lock-guard` and `overlay-fit-exclusion` are renderer-authoritative. `compaction-gate` is renderer-authoritative with daemon executing deferred policy when instructed. `ownership-exclusive` is feasible daemon-side for terminal operations.

### 5.3 Promotion Criteria (Shadow → Enforced)

A shadow-mode contract is promoted to enforced when ALL of:
1. Ran in shadow mode for >= 5 sessions
2. Zero false positives during shadow period
3. Replay validation confirms correct would-have-blocked behavior
4. Sign-off from at least two agents

### 5.4 Safe Mode

**Triggered by:** manual activation OR cascading contract violations (3+ violations within 10 seconds).

**Behavior:**
- Defer all non-critical intents
- Allow recovery intents (kill, restart, manual user input)
- Emit `safemode.entered` with trigger reason
- Auto-exit after 30 seconds of no violations, emit `safemode.exited`

---

## 6. Ring Buffer (Lane B)

- **Size:** max(1000 events, 5 minutes of events)
- **Eviction:** Oldest events evicted first when both limits exceeded
- **Storm handling:** During high-frequency bursts, buffer expands to time window limit
- **Access:** Queryable by correlationId, paneId, event type, time range
- **Backpressure:** Lane B uses drop-oldest policy. Dropped events emit `event.dropped` summary. Never blocks Lane A.

---

## 7. IPC Bridge (Daemon ↔ Renderer)

### 7.1 Topology

```
Renderer Event Kernel ←→ Main Bridge ←→ Daemon Socket
```

One canonical event envelope throughout. Bridge adds transport metadata wrapper.

### 7.2 Transport Envelope (Bridge Wrapper)

```json
{
  "bridgeVersion": 1,
  "bridgeSeq": 1234,
  "bridgeTs": 1739212345678,
  "direction": "daemon->renderer",
  "event": {
    "eventId": "...",
    "correlationId": "...",
    "causationId": "...",
    "type": "daemon.write.ack",
    "source": "daemon",
    "paneId": "2",
    "ts": 1739212345670,
    "seq": 99,
    "payload": { "status": "accepted", "dataLen": 42 }
  }
}
```

### 7.3 Command Path (Renderer → Daemon)

Extend existing daemon actions with optional kernel metadata:

```json
{
  "action": "write",
  "paneId": "2",
  "data": "...",
  "kernelMeta": {
    "eventId": "renderer-event-id",
    "correlationId": "...",
    "causationId": "...",
    "source": "injection.js",
    "seq": 314
  }
}
```

Daemon copies `correlationId`/`causationId` into ack/event emissions, preserving the causal chain across process boundaries.

### 7.4 IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `kernel:bridge-event` | main → renderer | Push daemon events to renderer kernel |
| `kernel:bridge-stats` | main → renderer | Diagnostics: drop counts, queue depth, lag |

### 7.5 Ordering and Loss Semantics

- Per-source monotonic `seq` in both daemon and renderer sources.
- Main bridge maintains independent `bridgeSeq` to detect handoff gaps.
- On overflow/loss, emit `event.dropped` with counters — **never silent**.

### 7.6 Backpressure

- **Lane A events:** Bounded queue with priority ordering: contract/system > lifecycle > telemetry.
- **Lane B events:** Drop-oldest in ring buffer; emit `event.dropped` summary.

### 7.7 Daemon Defer/Drop Execution

- Daemon executes deterministic policy handed down by Lane A — it does NOT invent UI-level rules.
- Defer: enqueue with `{ correlationId, expiresAt, reason }`.
- Resume triggers (exhaustive list — daemon ONLY resumes on these):
  - Explicit `inject.resumed` event from renderer/main (primary path)
  - `pty.up` after `pty.down` recovery (daemon-local, safe — pane just came back)
  - TTL expiry (daemon-local — deterministic timeout, always emits `inject.dropped`)
- No other daemon-local resume triggers. All policy decisions stay in Lane A (renderer/main).
- TTL expiry: emit `inject.dropped` with deterministic reason code.
- Drop: never silent — always emits event with reason.

---

## 8. Failure Taxonomy Mapping

Mapping of past incidents to event chains that would have detected/prevented them:

| Item | Failure Mode | Missing Event Chain | Key Missing Events | Preventing Contract |
|------|-------------|--------------------|--------------------|-------------------|
| **14** | Agent messages executed as commands (double-submit: triggers.js + injection.js) | `inject.requested → inject.submit.requested → inject.submit.sent → inject.verified` | `inject.submit.requested`, `inject.submit.sent`, `ownership.conflict` | **ownership-exclusive**: If second submit actor appears in same correlation → block, emit violation |
| **15** | Gemini injection fragility (payload transform + timing) | `inject.requested → inject.transform.applied → inject.applied → inject.verified` | `inject.transform.applied`, `inject.transform.lossy`, `inject.mode.selected` | **No lossy transform without policy**: Lossy transform must emit warn/violation |
| **16** | Injection during user typing (global check missed per-pane state) | `typing.activity → focus.locked → inject.deferred(reason=locked)` | `typing.activity`, `typing.idle`, `focus.lock.owner` | **focus-lock-guard**: Per-pane typing lock blocks injection |
| **19** | Terminal layout regressions (PTY resize race, hidden pane, timer conflicts) | `resize.requested → resize.started → pty.resize.requested → pty.resize.ack → resize.completed` | `pty.resize.requested`, `pty.resize.ack`, `pane.visibility.changed`, `resize.coalesced`, `fit.skipped` | **Resize sequencing**: fit/PTY resize only on visible pane, stale intents coalesced |
| **22** | broadcastInput interrupted by xterm focus steal during injection | `focus.arbitration.requested → focus.locked(user) → inject.deferred → focus.released → inject.resumed` | `focus.arbitration.requested`, `focus.arbitration.resolved`, `focus.steal.blocked` | **User focus non-preemptive**: Agent injection cannot steal focus during user lock |
| **23** | Settings overlay freeze (resize + fitAddon + WebGL pressure) | `overlay.opened → resize.requested → fit.skipped(reason=overlay_open)` | `fit.skipped`, `ui.longtask.detected` | **overlay-fit-exclusion**: No fit while overlay open |

### 8.1 Failure Classes

These incidents collapse into five repeated failure classes:

1. **Ownership ambiguity** — Who is allowed to submit/apply right now?
2. **Focus arbitration races** — User intent vs agent intent
3. **Hidden mode/state** — Overlay open, compacting, pane hidden — not represented in control path
4. **Cross-process ack gaps** — Write requested without confirmed ack or ordering
5. **High-frequency storm collapse** — Resize bursts, retry loops without coalescing/backpressure

---

## 9. Compaction Detection Model

### 9.1 Problem

Item 20: output activity is used as a generic "submit succeeded" signal. During CLI compaction, this signal produces false-positive confirmation for unrelated injections.

### 9.2 Detector States

4-state detector per pane:

| State | Meaning |
|-------|---------|
| `none` | No compaction evidence |
| `suspected` | Early/weak evidence detected |
| `confirmed` | High-confidence compaction in progress |
| `cooldown` | Compaction ended recently; suppress flapping |

### 9.3 Detection Signals (Multi-Signal, Not Keyword-Only)

| Signal | Example | Weight | Notes |
|--------|---------|--------|-------|
| Lexical marker | "compacting", "summarizing conversation" | Medium | Useful but not sufficient alone |
| Structured block pattern | Repeated summary/scaffold output | High | More robust than single tokens |
| Burst without prompt-ready | Sustained output with no prompt restoration | Medium | Distinguishes internal processing |
| Absence of user causation | No recent `inject.requested` root event | Medium | Reduces false positives during normal replies |

### 9.4 Transition Rules

- `none → suspected`: confidence >= T_suspect sustained for >= 300ms
- `suspected → confirmed`: confidence >= T_confirm sustained for >= 800ms OR repeated suspect hits in short window
- `confirmed → cooldown`: explicit end marker OR prompt-ready restoration + confidence decay
- `cooldown → none`: cooldown timer (1500ms) elapsed with no renewed evidence

### 9.5 Contract Behavior by State

| Detector State | Contract Action |
|----------------|----------------|
| `none` | No gating |
| `suspected` | No hard-block; emit `cli.compaction.suspected`; mark verification as risky |
| `confirmed` | Enforce compaction gate on non-critical injects (`inject.deferred`) |
| `cooldown` | Continue deferred queue hold to avoid thrash |

High-priority recovery intents (kill, restart) bypass gate at ALL states. Emit `contract.override`.

### 9.6 False Positive Mitigations

| Risk | Cause | Mitigation |
|------|-------|------------|
| Long model response misclassified | Output burst + summary-like text | Require multi-signal confirmation + minimum sustained window |
| Tool output contains compaction words | Lexical-only trigger | Lexical signal never sufficient alone |
| Flapping between states | Noisy output boundaries | Cooldown state + hysteresis thresholds |

### 9.7 Compaction Event Payloads

- `cli.compaction.suspected`: `{ confidence, detectorVersion, signals[] }`
- `cli.compaction.started`: `{ confidence, detectorVersion, transitionReason }`
- `cli.compaction.ended`: `{ durationMs, endReason }`
- `verify.false_positive`: `{ suspectedCompaction: true, confidenceAtVerify }`

Payloads make detector quality measurable, not anecdotal.

---

## 10. Success Metrics

### 10.1 Core Metrics (Phase-Gated)

| Metric | Phase 2 Target | Phase 4 Target | Measurement Method |
|--------|---------------|----------------|-------------------|
| p95 time-to-root-cause (injection incidents) | < 5 min | < 2 min | Timed investigation using event log vs. manual archaeology |
| % incidents with complete lifecycle chain | >= 90% | >= 95% | Audit correlation chains for traced flows |
| False-positive submit rate (Item 20 class) | < 5% | < 2% | `verify.false_positive` / total `inject.verified` |
| p95 event emission overhead | < 1ms | < 1ms | Performance.now() benchmarks per emit |
| p95 overhead under resize storm | < 2ms | < 2ms | Benchmark during rapid window resize |
| Contract violation detection latency | < 10ms | < 10ms | Time from trigger event to violation emission |

### 10.2 Integrity Metrics (Split by Lane)

| Metric | Lane A Target | Lane B Target | Measurement Method |
|--------|--------------|---------------|-------------------|
| Event loss rate | 0% | <= 0.1% | Compare emitted seq vs. received |
| Event out-of-order rate | 0% | < 1% | Seq number analysis |
| p99 emission overhead | < 2ms | < 5ms | Performance.now() benchmarks |

### 10.3 Additional Metrics

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| Compaction detector precision/recall | Track per session | Adjudicated against manual samples |
| Contract false-positive rate (per contract ID) | < 1% | Shadow violations that would have been wrong |
| Deferred-to-dropped ratio (by reason) | Track per session | `inject.deferred` → `inject.dropped` ratio |
| Queue wait latency p95 | < 5s | `inject.queued` → `inject.applied` delta |
| Safe-mode trigger quality | > 80% true incidents | Manual classification of triggers |
| Replay fidelity | Scored checklist pass rate >= 90% | Standardized checklist against known incidents |

---

## 11. Phase 2 Acceptance Tests (Daemon Side)

From DevOps review:

1. **Write roundtrip chain:** `inject.requested → daemon.write.requested → daemon.write.ack(status=accepted)` — full correlation chain visible.
2. **Missing terminal path:** `daemon.write.ack(status=rejected_terminal_missing)` emitted with contract visibility.
3. **Bridge disconnect/reconnect:** `bridge.disconnected → bridge.connected` with no silent gap (or explicit `event.dropped`).
4. **Storm behavior:** Under synthetic resize+data burst, event path remains bounded. Emits `event.dropped` summaries instead of hanging.

---

*v0.2 — Integrates DevOps daemon/bridge review and Analyst failure taxonomy/compaction model/state vector/metrics. Ready for team sign-off before Phase 1 coding begins.*
