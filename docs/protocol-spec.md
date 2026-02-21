# SquidRun Agent Protocol Specification (v1.0)

**Status:** Canonical | **Target Audience:** Agents & Developers

This document formalizes the communication and coordination protocols for the SquidRun multi-agent system. It transforms the "tribal knowledge" of the system into a practical specification for message formats, routing, reliability, and lifecycle management.

---

## 1. Message Format

All agent-to-agent communication must follow the standard envelope format. This ensures messages are attributable, ordered, and parsable by both humans and machines.

### 1.1 The Role Header
Every message must begin with a role identifier and a sequence number:
`([ROLE] #[N]): [Message Content]`

- **[ROLE]:** The canonical role name (e.g., `ARCH`, `BUILDER`, `ORACLE`).
- **#[N]:** A session-relative monotonic sequence number (e.g., `#1`, `#2`).

### 1.2 Sequence Numbering Rules
- **Reset:** Start from `#1` at the beginning of every session (app startup).
- **Monotonicity:** Increment the number by exactly 1 for every message sent by that agent.
- **Persistence:** Never reuse a sequence number within the same session.

### 1.3 Examples
- `(ARCH #1): Roll call. Report status.`
- `(BUILDER #42): Implementation complete. Running tests.`

---

## 2. Routing & Targets

Messages are routed via the `ui/scripts/hm-send.js` utility.

### 2.1 Canonical Targets
| Target | Role | Pane ID | Responsibilities |
|--------|------|---------|------------------|
| `architect` | Architect | 1 | Coordination, Decisions, Review |
| `builder` | Builder | 2 | Implementation, Testing, DevOps |
| `oracle` | Oracle | 3 | Investigation, Docs, Benchmarks |
| `builder-bg-1` | Background Builder Slot 1 | `bg-2-1` | Builder-owned delegated implementation work |
| `builder-bg-2` | Background Builder Slot 2 | `bg-2-2` | Builder-owned delegated implementation work |
| `builder-bg-3` | Background Builder Slot 3 | `bg-2-3` | Builder-owned delegated implementation work |

### 2.2 Special Targets
- **`user`:** Routes to the terminal and automatically to Telegram if an inbound message was received in the last 5 minutes.
- **`telegram`:** Explicitly routes to the configured Telegram bot.

### 2.3 Background Routing Rules (Stages 1-3)
- Background targets resolve through `resolveTargetToPane()` and accept either alias (`builder-bg-*`) or synthetic pane ID (`bg-2-*`).
- Brokered sends to background targets route through direct daemon PTY write (`delivered.daemon_write`) rather than trigger-file injection.
- Owner binding is enforced:
  - Background senders may message Builder only.
  - Non-Builder target attempts are blocked with `owner_binding_violation`.

### 2.4 Background Control Plane (Stage 2/3)
- Message type `background-agent` is handled by the app WebSocket broker.
- Builder-only actions:
  - `spawn`
  - `kill`
  - `kill-all`
  - `list`
  - `target-map`
- Non-Builder callers receive `owner_binding_violation`.
- Builder CLI helper `ui/scripts/hm-bg.js` sends these actions over WebSocket.
- Daemon event handling suppresses non-owner UI/recovery/CLI-identity side effects for background panes.

### 2.5 Legacy Aliases
The system maintains aliases for backward compatibility:
- `devops` → Routes to `builder`
- `analyst` → Routes to `oracle`

---

## 3. Delivery & Reliability

SquidRun uses a dual-path delivery system to ensure no message is lost.

### 3.1 Path A: WebSocket (Primary)
- **Mechanism:** Direct connection to the internal message bus (Port 9900).
- **Latency:** ~10ms.
- **Reliability:** High. Supports instant ACKs and delivery verification.

### 3.2 Path B: Trigger Files (Fallback)
- **Mechanism:** Writing to `.squidrun/triggers/[target].txt`.
- **Latency:** 500ms - 2000ms (dependent on file watchers).
- **Use Case:** Automatically used by `hm-send.js` if the WebSocket connection fails or times out.
- **Stage 1-3 Caveat:** Trigger fallback remains role/pane based; `builder-bg-*` aliases are WebSocket-route targets.

### 3.3 Target Health Semantics
- WebSocket `health-check` supports background aliases/pane IDs (`builder-bg-*`, `bg-2-*`).
- Background health statuses:
  - `healthy`: route active and within stale threshold.
  - `stale`: route exists but exceeded stale threshold.
  - `no_route`: target identity is valid but no active route is connected.
- Invalid names still return `invalid_target`.

### 3.4 ACK & Delivery Semantics
- **`delivered.verified`:** The target agent's runtime acknowledged receipt of the message.
- **`accepted.unverified`:** The message was accepted by the bus but the target agent hasn't acknowledged it yet (common during high load or sleep/wake cycles).
- **`fallback.triggered`:** WebSocket failed; the message was written to a trigger file.

---

## 4. Priority Tags

Priority tags are used at the start of the message body (after the header) to signal required handling.

| Tag | Meaning | Expected Action |
|-----|---------|-----------------|
| `[ACK REQUIRED]` | High-stakes message. | Target must acknowledge receipt immediately via `hm-send`. |
| `[URGENT]` | Blocker or critical failure. | Target should interrupt current task to address. |
| `[FYI]` | Informational only. | No response expected. |
| `[TASK]` | Formal delegation. | Target should treat as a new claim/task in the system. |

Example: `(ARCH #5): [URGENT] Build is failing on main. Oracle, investigate.`

---

## 5. Startup & Onboarding

### 5.1 The Check-in Procedure
On startup, every agent must follow this sequence:
1. **Identify Role:** Determine role and pane from environment variables (`SQUIDRUN_ROLE`, `SQUIDRUN_PANE_ID`).
2. **Read Runtime Truth:** Read `.squidrun/app-status.json` for active session number and treat it as canonical.
3. **Use Canonical Journal Path:** For memory/comms checks, use `.squidrun/runtime/evidence-ledger.db`.
4. **Role-Specific Baseline:**
   - **Architect only:** Await the automated **Startup Briefing** (summarizing `comms_journal`, unresolved claims, and failed deliveries).
   - **Builder/Oracle:** Read the **Session Handoff Index** at `.squidrun/handoffs/session.md` (auto-materialized from `comms_journal`).
5. **Signal Readiness:** Message the Architect to check in with a one-line status:
   `node ui/scripts/hm-send.js architect "(ROLE #1): [Role] online. Standing by."`

### 5.2 Failure Escalation
If an agent encounters a tool failure or a system blocker:
1. **Local Retry:** Attempt once if the error is transient.
2. **Escalate:** Notify the Architect immediately with the error logs.
3. **Document:** If the failure is a recurring pattern, notify the Oracle to document it as "Negative Knowledge."

---

## 6. Extending the System (Adding a New Agent)

To add a new agent (e.g., `Reviewer` or `SRE`) to SquidRun:

1. **Update Config:** Add the role and Pane ID to `ui/config.js`.
2. **Define Role:** Add responsibilities and sub-roles to `ROLES.md`.
3. **Provision Pane:** Update `ui/settings.json` (`paneCommands`) to include the new CLI command.
4. **Update Spec:** Add the new canonical target to Section 2.1 of this document.
5. **Initial Roll Call:** The Architect should perform a system-wide roll call to verify the new agent's `hm-send` path is active.

---

## 7. Operational Safety

- **Terminal vs. Agent:** Terminal output is for the USER. Never assume another agent can see your terminal.
- **No Content-Free ACKs:** Avoid "Okay" or "Received" unless `[ACK REQUIRED]` was specified. Prefer status-rich updates.
- **Verify Before Redesign:** Validate that a subsystem is actually failing against live runtime data before proposing replacement architecture.
- **Commit First:** Always commit work before declaring "Ready for restart." Uncommitted state is lost when a pane restarts.

### 7.1 Pre-Restart Release Gate
1. Builder completes fix + tests.
2. Architect verifies independently.
3. Oracle performs restart-risk review.
4. Oracle updates startup-facing docs for changed behavior and lessons learned.
