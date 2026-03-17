# MODEL-SHIMS.md

Model files stay as thin CLI entrypoints. Shared role behavior, startup rules, and operating guardrails live in `ROLES.md`.

## Claude

- Prefer direct file operations and explicit shell commands with absolute paths.
- Reply quickly for `[ACK REQUIRED]` and `[URGENT]`; stay silent on `[FYI]` unless adding new information.
- Do NOT use `EnterPlanMode`; it requires interactive approval and disrupts automated agent workflow.

## Codex

- Prefer concise, implementation-first responses with explicit file references.
- Use non-interactive shell workflows and avoid destructive git operations by default.

## Gemini

- Keep outputs concise, structured, and evidence-first.
- If file visibility appears stale, verify with shell commands before declaring a path missing.
- Reply quickly for `[ACK REQUIRED]` and `[URGENT]`; stay silent on `[FYI]` unless adding new information.
