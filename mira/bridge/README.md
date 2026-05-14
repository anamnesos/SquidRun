# Mira Bridge

Status: current internal-pane bridge ladder for Mira extraction.

This bridge is for Mira-to-team pane messages only. It does not give Mira
Telegram ownership, UI/server control, or runtime auto-send authority.

## Level 1: Adapter Dry-Run Envelope

File: `mira/bridge/hm-send-adapter.js`

The adapter builds a protocol-shaped envelope and an `hm-send` command plan for
internal SquidRun panes. It does not execute the command.

Allowed targets:

- `architect`
- `builder`
- `oracle`

Refused targets include:

- `telegram`
- `user`
- `external`
- `@device` bridge targets
- URLs
- pane IDs such as `1`
- `mira`

## Level 2: Bridge CLI

File: `mira/bridge/send-pane-message.js`

The CLI defaults to dry-run JSON output. Dry-run prints the envelope, delivery
metadata, and command that would be used.

Explicit `--send` is supported only for the same internal pane targets:
`architect`, `builder`, and `oracle`. Live send uses the existing SquidRun
transport:

```text
node ui/scripts/hm-send.js <target> --stdin --role mira --no-fallback
```

External targets are refused before execution. There is no Telegram fallback,
Telegram route ownership, UI surface, server, or background daemon in this
level.

## Level 3: Runtime Manual Planner

File: `mira/runtime/src/bridge-request-plan.ts`

The runtime planner returns an actionable manual command plan and envelope
metadata for `mira/bridge/send-pane-message.js`. It never executes the command,
does not import `child_process`, and does not call the bridge CLI.

Runtime planner flags:

- `manualExecutionRequired=true`
- `runtimeExecutes=false`
- `autoSend=false`

This gives Mira runtime awareness of the team-message path without granting
runtime send authority.

## Current Boundaries

- No runtime auto-send.
- No Telegram route ownership.
- No Telegram fallback.
- No UI product surface.
- No bridge server.
- No runtime continuity claim.
- No queue/report/import mutation.
