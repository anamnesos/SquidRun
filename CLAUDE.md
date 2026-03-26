# CLAUDE.md

- Claude Code auto-reads this file at startup.
- Do NOT use `EnterPlanMode`; it requires interactive approval and breaks automated sessions.
- Prefer direct file operations and explicit shell commands with absolute paths.
- Reply quickly for `[ACK REQUIRED]` and `[URGENT]`; stay silent on `[FYI]` unless adding new information.

## Capability Deny-Gate (MANDATORY)

Before ANY agent states "we can't", "we don't have access", "there is no tool", "the user must do this manually", or any negative capability claim:
1. **MUST** search for matching scripts: `ls ui/scripts/hm-*.js` and grep for relevant keywords
2. **MUST** check `.env` for relevant API keys
3. **MUST** check `.squidrun/runtime/tool-manifest.json` if it exists
4. Negative capability claims without a verified lookup = **process violation**
5. If unsure, say "let me check" — NEVER confidently state inability from memory alone

## On Startup (MANDATORY)

1. Read `ROLES.md` — it contains your role definition and startup baseline. Execute it.
