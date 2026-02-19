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

- If `.hivemind/link.json` exists, read it first for project discovery (`workspace`) and shared script root (`hivemind_root`).
- Read the session handoff index: `workspace/handoffs/session.md` — auto-generated from `comms_journal` and mirrored from `.hivemind/handoffs/session.md`.
- Treat `.hivemind/app-status.json` as source of truth for the active session number; `link.json.session_id` is bootstrap metadata and may be stale.
- For journal/database checks, use `.hivemind/runtime/evidence-ledger.db` (not `.hivemind/evidence-ledger.db`).
- Then follow the full startup baseline in `ROLES.md`.

## Reference

- Read `ROLES.md` for role boundaries and shared operating rules.
