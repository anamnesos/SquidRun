# CLAUDE.md

## Scope

This is the Claude-specific shim.

- Canonical role definitions live in `ROLES.md`.
- Determine behavior from runtime env (`HIVEMIND_ROLE`, `HIVEMIND_PANE_ID`) + `ROLES.md`.
- Do not duplicate role instructions in this file.

## Claude Quirks

- Prefer direct file operations and explicit shell commands with absolute paths.
- Keep agent-to-agent communication on `hm-send.js`; terminal output is user-facing.
- Reply quickly for `[ACK REQUIRED]` and `[URGENT]`; stay silent on `[FYI]` unless adding new information.

## Reference

- Read `ROLES.md` first for startup baseline, role boundaries, and shared operating rules.
