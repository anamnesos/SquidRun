# GEMINI.md

## Scope

This is the Gemini-specific shim.

- Canonical role definitions live in `ROLES.md`.
- Determine behavior from runtime env (`HIVEMIND_ROLE`, `HIVEMIND_PANE_ID`) + `ROLES.md`.
- Do not duplicate role instructions in this file.

## Gemini Quirks

- Keep outputs concise, structured, and evidence-first.
- If file visibility appears stale, verify with shell commands before declaring a path missing.
- Maintain strict message discipline: respond on `[ACK REQUIRED]`/`[URGENT]`, avoid content-free acknowledgments.

## Reference

- Read `ROLES.md` first for startup baseline, role boundaries, and shared operating rules.
