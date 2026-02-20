# Transition Ledger Specification

**Version:** 0.1 | **Status:** Shipped (S139)
**Authors:** Analyst, Architect, DevOps

---

## 1. Overview

The Transition Ledger is a state-tracking layer built on top of the Event Kernel. While the Kernel handles discrete events, the Ledger tracks the **lifecycle of high-level operations** (Transitions) that span multiple events, such as a message injection and its subsequent verification.

### 1.1 Transition vs. Event
- **Event:** A point-in-time occurrence (e.g., `inject.submit.sent`).
- **Transition:** A stateful object linked by `correlationId` that aggregates evidence, enforces preconditions, and determines the ultimate success or failure of an operation.

---

## 2. Transition Object Schema

Every transition object in the ledger MUST conform to this schema:

```javascript
{
  transitionId: string,    // "tr-" prefix + timestamp + counter
  correlationId: string,   // Links events to this transition
  causationId: string,     // The eventId that triggered the current state
  paneId: string,          // "1" | "2" | "3" | "system"
  category: string,        // e.g., "inject"
  intentType: string,      // e.g., "inject.requested"
  transitionType: string,  // e.g., "message.submit"
  
  origin: {
    actorType: string,     // "agent" | "user" | "system"
    actorRole: string,     // "architect" | "devops" | "analyst" | "system"
    source: string         // Emitting module (e.g., "injection.js")
  },
  
  owner: {
    module: string,        // Module currently holding the mutation lease
    leaseId: string,       // Unique lease identifier
    acquiredAt: number,    // Timestamp of lease acquisition
    leaseTtlMs: number     // Lease duration (default 15s)
  },
  
  phase: string,           // Current phase (see Section 3)
  phaseHistory: Array,     // History of phase transitions with timestamps
  
  preconditions: Array,    // Results of gate checks (e.g., focus-lock)
  
  evidenceSpec: {
    requiredClass: string, // "strong" | "weak_allowed" | "manual_only"
    acceptedSignals: [],   // List of allowed event types
    disallowedSignals: []  // List of event types that force failure
  },
  
  verification: {
    outcome: string,       // "pass" | "risked_pass" | "fail" | "unknown"
    evidenceClassObserved: string,
    confidence: number,    // 0.0 to 1.0
    verifiedAt: number     // Timestamp of final verification
  },
  
  outcome: {
    status: string,        // "success" | "partial" | "failure"
    reasonCode: string,    // Machine-readable reason (e.g., "timeout_without_evidence")
    resolvedBy: string     // "normal" | "fallback" | "manual"
  },
  
  evidence: Array,         // Log of all classified events received
  createdAt: number,
  updatedAt: number,
  closed: boolean,         // True if in a terminal phase
  closedAt: number
}
```

---

## 3. Lifecycle State Machine

### 3.1 Phases (Enum)

| Phase | Description |
|-------|-------------|
| `requested` | Initial state upon `inject.requested` |
| `accepted` | Intent acknowledged by system |
| `deferred` | Blocked by temporary gate (precondition failure) |
| `applied` | Content written to terminal (Side-effect performed) |
| `verifying` | Submit sent; awaiting evidence |
| `verified` | **Terminal:** Success confirmed by strong evidence |
| `failed` | **Terminal:** Explicit failure or disallowed evidence |
| `timed_out` | **Terminal:** No sufficient evidence within budget |
| `dropped` | **Terminal:** Discarded due to TTL or policy |
| `cancelled` | **Terminal:** Revoked by owner or system |

### 3.2 Phase Graph (Allowed Transitions)

- `requested` → `accepted`, `deferred`, `dropped`
- `accepted` → `applied`, `failed`, `timed_out`
- `deferred` → `accepted`, `dropped`, `timed_out`
- `applied` → `verifying`, `failed`
- `verifying` → `verified`, `failed`, `timed_out`

Terminal phases have no outbound transitions.

---

## 4. Evidence Model

The Ledger classifies events into evidence classes to determine if a transition can be considered `verified`.

### 4.1 Evidence Classes

| Class | Meaning | Example Signals |
|-------|---------|-----------------|
| **STRONG** | Definitive confirmation | `verify.pass`, `inject.verified` |
| **WEAK** | Probabilistic/Partial | `daemon.write.ack(accepted)`, `pty.data.received` |
| **DISALLOWED**| Conflict detected | `pty.data.received` (during compaction) |
| **NONE** | Irrelevant to this transition | Unrelated events |

### 4.2 Evidence Spec Enforcement

At the point of finalization (e.g., timeout or verify signal):

- **Strong Required (Default):** Transition only reaches `verified` if at least one STRONG signal is recorded.
- **Weak Allowed:** Transition can reach `verified` (as `risked_pass`) with WEAK signals if no STRONG signals are present.
- **Disallowed Check:** If any DISALLOWED signal is recorded, the transition MUST transition to `failed`.

---

## 5. Owner Lease Model

To prevent concurrent mutation conflicts (e.g., two modules trying to "apply" the same injection), the Ledger uses an **Owner Lease**.

1. **Acquisition:** The first module to "own" the transition (usually the one processing `inject.requested`) is granted a lease.
2. **Exclusivity:** Only the owner module can trigger mutations (phase changes) for events in the `OWNER_MUTATION` set (e.g., `applied`, `submit.sent`).
3. **Validation:** If another module attempts an owner-locked mutation, the Ledger emits `transition.invalid` with `ownership_conflict`.
4. **Lease Expiry:** If the lease TTL (default 15s) is exceeded, subsequent owner mutations are rejected with `owner_lease_expired`.
5. **Passive Signals:** External modules (e.g., a dedicated verification watcher) can contribute evidence or terminal signals (`verify.pass`, `inject.failed`) without holding the lease.

---

## 6. Preconditions

Before transitioning to the `applied` phase, the Ledger evaluates system-wide **Preconditions**:

- **`focus-lock-guard`:** Fails if `gates.focusLocked === true` (user is typing).
- **`compaction-gate`:** Fails if `gates.compacting === 'confirmed'`.

**Actions on Failure:**
- **Defer:** Move transition to `deferred` phase. It remains open and will be re-evaluated when system state changes.
- **Drop:** Move transition to `dropped` terminal phase if the precondition is unrecoverable or TTL-expired.

---

## 7. Timeout Policy

Transitions have an `overallMs` budget (default 5000ms).

1. **Arming:** Timeout is armed when entering the `verifying` phase (or `submit.requested`).
2. **Trigger:** If the budget expires before a terminal phase is reached:
   - If **Strong Evidence** exists: Finalize as `verified`.
   - If **Weak Evidence** exists: Finalize as `timed_out` with outcome `risked_pass`.
   - If **No Evidence** exists: Finalize as `timed_out` with outcome `unknown`.
   - If **Disallowed Evidence** exists: Finalize as `failed`.

---

## 8. Retention and Pruning

- **Capacity:** The Ledger maintains a ring buffer of the last **500 transitions**.
- **Pruning:** When capacity is exceeded, the oldest **closed** transitions are evicted first.
- **Access:** Closed transitions remain queryable via `transitionId` or `correlationId` until pruned.
