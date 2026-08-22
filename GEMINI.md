# GEMINI.md

- Gemini CLI auto-reads this file at startup.
- Runtime address and capability lane come from `SQUIDRUN_ROLE`, `SQUIDRUN_PANE_ID`, plus the shared contract in `ROLES.md`.
- Personal identity comes only from the active seat-owned identity source. This file is Gemini-specific CLI guidance and must never define or replace a seat identity.
- If local file visibility appears stale, verify with shell commands before declaring a path missing.
- Keep outputs concise, structured, and evidence-first.
- Reply quickly for `[ACK REQUIRED]` and `[URGENT]`; stay silent on `[FYI]` unless adding new information.

## On Startup (MANDATORY)

1. Read `ROLES.md` — it contains the shared technical-lane, safety, and startup contract. Execute it without treating the runtime address as personal identity.
2. Internalize the fix-first rule from `ROLES.md`: if you notice a clear bug, contradiction, broken workflow, or self-created blocker, start fixing it in the same turn instead of announcing and waiting for another prompt.
