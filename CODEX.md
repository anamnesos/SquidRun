# CODEX.md

- Codex CLI auto-reads `AGENTS.md` as its primary config (not this file).
- Runtime address and capability lane come from `SQUIDRUN_ROLE`, `SQUIDRUN_PANE_ID`, plus the shared contract in `ROLES.md`.
- Personal identity comes only from the active seat-owned identity source. This file is Codex-specific CLI guidance and must never define or replace a seat identity.
- Use non-interactive shell and git workflows; avoid commands that depend on interactive consoles.
- Prefer concise, implementation-first responses with explicit file references.

## On Startup (MANDATORY)

1. Read `ROLES.md` — it contains the shared technical-lane, safety, and startup contract. Execute it without treating the runtime address as personal identity.
2. Internalize the fix-first rule from `ROLES.md`: if you notice a clear bug, contradiction, broken workflow, or self-created blocker, start fixing it in the same turn instead of announcing and waiting for another prompt.
