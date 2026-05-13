# SquidRun Adapter Protocol v0

Status: milestone skeleton for the next Mira extraction step.

Scope: define the narrow bridge between independent Mira runtime and SquidRun.
This does not implement runtime code, alter Telegram routes, or add UI surface.

## Transport

V0 can be HTTP or WebSocket behind a local-only bind. The contract below is the
stable payload shape; transport adapters may wrap it but must not rename fields.

Required envelope fields:

```json
{
  "protocol": "mira.squidrun_adapter.v0",
  "request_id": "req_...",
  "message_id": "mira_...",
  "session_id": "app-session-373",
  "timestamp_ms": 1778710000000,
  "source": { "service": "mira-runtime", "surface": "local" },
  "target": { "system": "squidrun", "role": "architect", "pane_id": "1" },
  "evidence": [],
  "body": {}
}
```

## Health

`GET /bridge/health`

Returns whether the SquidRun adapter can accept Mira requests and route to panes.

```json
{
  "ok": true,
  "status": "healthy",
  "adapter": "squidrun",
  "protocol": "mira.squidrun_adapter.v0",
  "session_id": "app-session-373",
  "session_ordinal": 373,
  "uptime_ms": 120000,
  "checks": {
    "pane_host": "ready",
    "comms_journal": "ready",
    "agent_ws": "ready",
    "session_context": "ready"
  }
}
```

## Capabilities

`GET /bridge/capabilities`

Returns the current SquidRun adapter affordances available to Mira. Capabilities
must be explicit; Mira should not infer write/send powers from repository access.

```json
{
  "ok": true,
  "session_id": "app-session-373",
  "capabilities": {
    "pane_message_send": true,
    "pane_message_receive": true,
    "session_context_read": true,
    "evidence_metadata_write": true,
    "telegram_route_control": false,
    "ui_surface_control": false
  },
  "roles": [
    { "role": "architect", "pane_id": "1", "send": true, "receive": true },
    { "role": "builder", "pane_id": "2", "send": true, "receive": true },
    { "role": "oracle", "pane_id": "3", "send": true, "receive": true }
  ]
}
```

## Session Context

`GET /bridge/session-context`

Returns the current SquidRun session state Mira needs to address the team without
borrowing SquidRun as Mira-owned memory.

```json
{
  "ok": true,
  "session_id": "app-session-373",
  "session_ordinal": 373,
  "workspace": "D:/projects/squidrun",
  "squidrun_root": "D:/projects/squidrun",
  "role_targets": {
    "architect": "architect",
    "builder": "builder",
    "oracle": "oracle"
  },
  "handoff": {
    "path": ".squidrun/handoffs/session.md",
    "generated_at": "2026-05-13T22:17:12.187Z"
  }
}
```

## Pane Message Send

`POST /bridge/pane-messages`

Mira asks SquidRun to deliver an internal pane message. The adapter owns mapping
role targets to the current SquidRun transport.

Request:

```json
{
  "message_id": "mira_msg_01",
  "session_id": "app-session-373",
  "target": { "role": "builder" },
  "sender": { "role": "mira", "surface": "mira-runtime" },
  "content": "(MIRA #1): Please inspect the adapter health path.",
  "priority": "normal",
  "evidence": [
    {
      "kind": "file",
      "path": "mira/bridge/squidrun-adapter-protocol-v0.md",
      "summary": "Protocol skeleton requested for extraction milestone."
    }
  ]
}
```

Response:

```json
{
  "ok": true,
  "message_id": "mira_msg_01",
  "delivery": {
    "status": "routed",
    "ack_status": "accepted_unverified",
    "target_role": "builder",
    "target_pane_id": "2",
    "channel": "ws",
    "attempt": 1
  }
}
```

## Pane Message Receive

`GET /bridge/pane-messages?since=<cursor>`

Mira reads replies or routed team messages addressed to `mira` or a specific
Mira request correlation id.

```json
{
  "ok": true,
  "cursor": "comms_journal:12345",
  "messages": [
    {
      "message_id": "hm-...",
      "correlation_id": "mira_msg_01",
      "session_id": "app-session-373",
      "sender": { "role": "builder", "pane_id": "2" },
      "target": { "role": "mira" },
      "channel": "ws",
      "sent_at_ms": 1778710001000,
      "content": "(BUILDER #1): Adapter health path checked.",
      "evidence": []
    }
  ]
}
```

## Evidence Metadata

Every send/read response may include evidence metadata. Evidence points to
reviewable artifacts; it must not smuggle SquidRun durable memory into Mira as
Mira-owned state.

```json
{
  "evidence": [
    {
      "kind": "comms_journal",
      "message_id": "hm-...",
      "session_id": "app-session-373",
      "status": "routed"
    },
    {
      "kind": "file",
      "path": ".squidrun/app-status.json",
      "fields": ["session", "paneHost.readyPanes"]
    }
  ]
}
```

## Error Shape

All failures use the same shape.

```json
{
  "ok": false,
  "error": {
    "code": "target_unavailable",
    "message": "Builder pane is not accepting messages.",
    "retryable": true,
    "details": {
      "target_role": "builder",
      "health_status": "stale"
    }
  },
  "request_id": "req_...",
  "message_id": "mira_msg_01",
  "session_id": "app-session-373"
}
```

Stable error codes:

- `invalid_request`
- `session_mismatch`
- `target_unavailable`
- `delivery_timeout`
- `delivery_failed`
- `capability_denied`
- `adapter_unhealthy`
- `internal_error`

## Read-Only SquidRun Adapter Inventory

These files are later implementation candidates for the SquidRun side of the
adapter. They were inspected as inventory only.

- `ui/scripts/hm-send.js`: existing CLI and WebSocket send path, target roles,
  health-check query, canonical message id/session metadata, fallback behavior.
- `ui/scripts/hm-comms.js`: read path over `comms_journal`, including session
  filtering and JSON output.
- `ui/modules/comms/message-envelope.js`: canonical outbound envelope and
  metadata builder used by WebSocket routing.
- `ui/modules/main/squidrun-app.js`: WebSocket broker, app session scope,
  pane routing, bridge routing, capability snapshot refresh, comms journaling.
- `ui/modules/main/comms-journal.js`: wrapper over evidence ledger journal
  operations.
- `ui/modules/main/evidence-ledger-store.js`: `comms_journal` schema, statuses,
  ack/error fields, evidence refs and event metadata storage.
- `ui/modules/ipc/settings-handlers.js`: current app status and feature
  capability read IPC handlers.
- `ui/modules/ipc/mira-lab-handlers.js`: legacy Mira Lab IPC send/drive shapes
  to replace after runtime/bridge parity.
- `.squidrun/link.json`: workspace, SquidRun root, comms script paths, and role
  targets.
- `.squidrun/app-status.json`: current session ordinal, pane host readiness,
  platform, and runtime status.
- `.squidrun/handoffs/session.md`: materialized session context and recent
  comms summary derived from `comms_journal`.

## Non-Scope

- No Telegram route work.
- No UI product surface.
- No SquidRun tab or Electron window work.
- No live state copy or deletion.
