# Codex ↔ Architect Inbox Protocol (v1)

File-based message channel between Architect (Claude Code CLI in SquidRun pane 1) and Codex (Codex Desktop, outside SquidRun). Used because hm-send cannot route to Codex (Codex is not a SquidRun pane).

## Files

- `.squidrun/coord/codex-inbox.jsonl` — Architect → Codex. Architect appends; Codex polls and processes.
- `.squidrun/coord/architect-inbox.jsonl` — Codex → Architect. Codex appends; Architect reads on demand or via supervisor lane (TBD).
- `.squidrun/coord/inbox-acks.jsonl` — both sides append `ack` entries here so each side can confirm the other consumed a message.

Each line is one JSON object. No JSON arrays. Append-only — never edit or delete past lines.

## Common envelope (every message must have)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | unique, format: `<type-prefix>-<sender>-<unixSeconds>-<rand>` |
| `createdAt` | ISO8601 UTC | yes | `2026-04-26T23:30:01.531Z` |
| `type` | string | yes | from the type table below |
| `from` | string | yes | `architect` \| `codex` |
| `to` | string | yes | `architect` \| `codex` |
| `sessionId` | number | optional | SquidRun session id at write time |
| `priority` | `low`\|`normal`\|`urgent` | optional | default `normal` |

## Message types

### Architect → Codex (`codex-inbox.jsonl`)

| `type` | Required extra fields | Codex's expected handler |
|---|---|---|
| `demo_ping` | `note` | log + ack only. Used for channel verification. |
| `restart_request` | `requestPath` (e.g., `.squidrun/coord/restart-request.json`) | run preflight on referenced JSON, append `preflight_result` to architect-inbox |
| `clear_check` | `driftResultsPath`, `sessionIdNew` | grade drift results, append `drift_grade` to architect-inbox |
| `heartbeat` | `headCommit`, `branch`, `dirtyTree`, `hlPositionCount`, `hlAccountValue`, `memoryChecksum`, `topPriority` | update live state cache; append `anomaly` to architect-inbox if heartbeat is overdue or fields are missing |
| `anomaly` | `anomalyType`, `severity`, `details` | persist into Codex's anomaly aggregator; nothing to ack unless severity=`hard` |
| `escalate_to_james` | `reason`, `context` | Codex prompts James in its own pane; appends `ack` |

### Codex → Architect (`architect-inbox.jsonl`)

| `type` | Required extra fields | Architect's handler |
|---|---|---|
| `ack` | `refId` (id of the message being acked) | log; remove from local "awaiting-ack" list |
| `preflight_result` | `requestId`, `status` (`approved`\|`approval_required`\|`rejected`), `findings[]` | if `approved`, proceed with restart; if `approval_required`, await James; if `rejected`, abort restart and surface reason |
| `drift_grade` | `sessionIdNew`, `grade` (`pass`\|`soft_fail`\|`hard_fail`), `failedItems[]`, `notes` | hard_fail → architect pauses + escalates; soft_fail → architect logs anomaly + continues; pass → architect resumes work queue |
| `anomaly` | `anomalyType`, `severity`, `details` | Architect logs the anomaly forwarded by Codex (e.g., "your last heartbeat is 22 minutes stale") |
| `query` | `question`, `replyToId` | Architect reads, appends a reply via `architect → codex` `query_reply` |
| `query_reply` | `refId`, `answer` | log + ack |

## Acknowledgment

Each side SHOULD append an `ack` to the OTHER side's inbox after successfully processing a message:

```
{"id":"ack-codex-...","createdAt":"...","type":"ack","from":"codex","to":"architect","refId":"<original-id>","note":"processed"}
```

`demo_ping`, `heartbeat`, and `anomaly` (severity=`low`) MAY be processed silently without ack. Anything else SHOULD ack so the sender's local awaiting-ack list can be reconciled.

## Handler timing

Codex polls `codex-inbox.jsonl` on its automation interval (currently set up by Codex's "Squidrun Codex Inbox Poller" heartbeat). Architect reads `architect-inbox.jsonl` on demand initially; once `hm-supervisor-lane-poller.js` exists, that supervisor lane will poll for incoming messages and emit them via hm-send to the Architect pane.

## ID format examples

- `ping-arch-1777246201-3990` — demo_ping from Architect
- `restart-arch-1777246900-1a2b` — restart_request from Architect
- `ack-codex-1777246950-c3d4` — ack from Codex
- `preflight-codex-1777246960-e5f6` — preflight_result from Codex
- `grade-codex-1777247200-789a` — drift_grade from Codex

## Reserved future types (do not use yet)

- `consultation_request` — when consultation pipeline supports cross-agent
- `pause` / `resume` — coordination primitives once we want soft-pause-without-restart
- `key_rotation_signal` — security event broadcast

## Versioning

This is v1. Schema bumps are signaled by writing a `protocol_version` envelope field. Both sides MUST refuse to process messages with a `protocol_version` higher than they support.
