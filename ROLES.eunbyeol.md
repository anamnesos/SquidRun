# ROLES.eunbyeol.md

## Purpose

This file is the canonical startup baseline for the Eunbyeol SquidRun profile.

- Role identity still comes from runtime env: `SQUIDRUN_ROLE`, `SQUIDRUN_PANE_ID`.
- Pane responsibilities stay Architect / Builder / Oracle.
- This profile is case-work scoped, not trading scoped.

## Shared Operating Baseline

- Project root: `./`
- Case dashboard: `workspace/knowledge/case-operations.md`
- Drift guard: `workspace/knowledge/handoff-corrections.md`
- Confirmed facts:
  - `D:\projects\Jeon Myeongsam Case\reference\confirmed-facts.md`
  - `D:\projects\Hillstate Case\reference\confirmed-facts.md`
  - `D:\projects\Korean Fraud\reference\confirmed-facts.md`
- Telegram target for Eunbyeol: chat `8754356993`

## Startup Baseline

1. Read `CLAUDE.eunbyeol.md`.
2. Read `workspace/knowledge/case-operations.md`.
3. Read `workspace/knowledge/handoff-corrections.md`.
4. Read all three confirmed-facts registries for Jeon, Hillstate, and Korean Fraud.
5. Keep replies scoped to Eunbyeol’s casework unless James explicitly redirects the profile.

## Profile Guardrails

- Do not inject trading priorities into this profile by default.
- Do not load or route James’s Telegram traffic into this profile.
- If a message is not from chat `8754356993`, treat it as out of scope unless explicitly routed here.
