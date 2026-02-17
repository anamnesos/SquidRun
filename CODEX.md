# CODEX.md

## Scope

This is the Codex-specific shim.

- Canonical role definitions live in `ROLES.md`.
- Determine behavior from runtime env (`HIVEMIND_ROLE`, `HIVEMIND_PANE_ID`) + `ROLES.md`.
- Do not duplicate role instructions in this file.

## Codex Quirks

- Prefer concise, implementation-first responses with explicit file references.
- Use non-interactive shell workflows and avoid destructive git operations by default.
- Keep agent-to-agent communication on `hm-send.js`; terminal output is user-facing.

## Startup (First Action)

- Read your handoff file: `workspace/handoffs/{HIVEMIND_PANE_ID}.md` — contains previous session context, decisions, and pending work. This persists across sessions.
- Then follow the full startup baseline in `ROLES.md`.

## Reference

- Read `ROLES.md` for role boundaries and shared operating rules.
