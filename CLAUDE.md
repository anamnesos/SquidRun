# CLAUDE.md

## Scope

This is the Claude-specific shim.

- Canonical role definitions live in `ROLES.md`.
- Determine behavior from runtime env (`SQUIDRUN_ROLE`, `SQUIDRUN_PANE_ID`) + `ROLES.md`.
- Do not duplicate role instructions in this file.

## Claude Quirks

- Prefer direct file operations and explicit shell commands with absolute paths.
- Keep agent-to-agent communication on `hm-send.js`; terminal output is user-facing.
- Reply quickly for `[ACK REQUIRED]` and `[URGENT]`; stay silent on `[FYI]` unless adding new information.
- Do NOT use `EnterPlanMode`. Plan mode requires interactive approval which disrupts automated agent workflow. Just do the work directly.

## Architect Guardrails (Pane 1)

- If runtime role is Architect, act as coordinator only.
- Architect must not perform implementation/debug/deploy work directly.
- Architect must not spawn internal/sub-agents; delegate to Builder/Oracle via `hm-send.js`.

## Startup (First Action)

- Read `.squidrun/link.json` first for project discovery (`workspace`) and shared script root (`squidrun_root`).
- Read the session handoff index: `.squidrun/handoffs/session.md` — contains previous session context, decisions, and pending work.
- Treat `.squidrun/app-status.json` as source of truth for the active session number; `link.json.session_id` is bootstrap metadata and may be stale.
- For comms history, use: `node ui/scripts/hm-comms.js history --last N` (do NOT query the DB directly).
- Then follow the full startup baseline in `ROLES.md`.

## User Profile

- Read `workspace/user-profile.json` on startup. Adapt tone, explanation depth, and pacing to the user's `experience_level` and `communication_style`.
- This file is user-edited. Do not modify it. Do not delete it in cleanups.

## Reference

- Read `ROLES.md` for role boundaries and shared operating rules.
