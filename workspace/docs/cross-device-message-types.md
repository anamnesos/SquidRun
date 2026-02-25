# SquidRun Cross-Device Message Types (Spec Draft)

This document specifies the structured message types for Architect-to-Architect (Arch-to-Arch) coordination in cross-device SquidRun teams. Structured types ensure that coordination is predictable, machine-parsable, and visually consistent across devices.

---

## 1. Envelope Structure

All cross-device messages must follow the canonical envelope format, with the structured payload contained in the `metadata.structured` field.

```json
{
  "type": "xsend",
  "messageId": "bridge-...",
  "fromDevice": "DEVICE_A",
  "toDevice": "DEVICE_B",
  "fromRole": "architect",
  "content": "[Plain text summary for terminal display]",
  "metadata": {
    "structured": {
      "type": "MESSAGE_TYPE",
      "payload": { ... }
    }
  }
}
```

---

## 2. Message Types

### 2.1 `FYI` (Informational)
Used for sharing general status updates, progress, or "silent" signals that don't require action but improve team context.

- **Payload:**
  - `category`: (String) e.g., `status`, `progress`, `milestone`.
  - `detail`: (String) Detailed information.
  - `impact`: (String, Optional) e.g., `none`, `low`, `context-only`.

### 2.2 `ConflictCheck` (Pre-change Coordination)
Used to verify if an intended action (e.g., editing a specific file, changing a dependency) will conflict with the remote team's work.

- **Payload:**
  - `resource`: (String) File path or system component (e.g., `ui/modules/auth.js`).
  - `action`: (String) Intended action (e.g., `write`, `delete`, `refactor`).
  - `reason`: (String) Why the change is needed.
- **Expected Response:** `ConflictResult` (True/False with detail).

### 2.3 `Blocker` (Issue Escalation)
Used to signal that the local team is blocked by something the remote team owns or is currently working on.

- **Payload:**
  - `severity`: (String) `low`, `high`, `critical`.
  - `source`: (String) The component or task causing the block.
  - `requestedAction`: (String) What the remote team needs to do to unblock.

### 2.4 `Approval` (Cross-team Permission)
Used to request explicit human or Architect-level approval for a high-stakes action that affects both teams.

- **Payload:**
  - `requestType`: (String) e.g., `git-merge`, `deployment`, `schema-change`.
  - `details`: (String) Evidence or rationale for the request.
  - `urgency`: (String) `normal`, `immediate`.
- **Expected Response:** `ApprovalResult` (Approved/Denied with audit trail).

### 2.5 `ConflictResult` (Response to ConflictCheck)
Used to provide the outcome of a pre-change coordination check.

- **Payload:**
  - `checkingMessageId`: (String) ID of the original `ConflictCheck` message.
  - `isConflict`: (Boolean) `true` if a conflict exists, `false` otherwise.
  - `detail`: (String) Explanation of why it conflicts (or why it's safe).

### 2.6 `ApprovalResult` (Response to Approval)
Used to provide the outcome of an approval request.

- **Payload:**
  - `requestMessageId`: (String) ID of the original `Approval` message.
  - `approved`: (Boolean) `true` if approved, `false` if denied.
  - `approverRole`: (String) The role that granted/denied approval (e.g., `architect`, `user`).
  - `reason`: (String, Optional) Rationale for the decision.

---

## 3. Protocol Rules

1. **Fallback Content:** The `content` field must always contain a "Plain English" summary of the structured payload for display in terminals that don't support structured rendering.
2. **Schema Evolution:** Message types must be additive. Unknown types should be treated as general `FYI` by the receiver.
3. **Audit Trail:** All structured messages must be recorded in the `comms_journal` with their full metadata intact.
