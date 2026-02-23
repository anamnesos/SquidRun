# CODEX.md

## Scope

This is the Codex-specific shim.

- Canonical role definitions live in `ROLES.md`.
- Determine behavior from runtime env (`SQUIDRUN_ROLE`, `SQUIDRUN_PANE_ID`) + `ROLES.md`.
- Do not duplicate role instructions in this file.

## Codex Quirks

- Prefer concise, implementation-first responses with explicit file references.
- Use non-interactive shell workflows and avoid destructive git operations by default.
- Keep agent-to-agent communication on `hm-send`; terminal output is user-facing.

## Builder: Autonomous Background Agent Spawning (MANDATORY)

- On EVERY incoming task, assess whether it is heavy enough to parallelize.
- Heavy = 3+ files, multiple subsystems, refactors, audits, large features, codebase-wide changes.
- If heavy: AUTOMATICALLY spawn background builder agents (`builder-bg-1..3`) to parallelize the work. Do NOT wait for Architect to tell you.
- Coordinate sub-workers, integrate their results, shut them down when done.
- This is YOUR judgment call. If the task is clearly heavy and you don't spawn, that is a defect.
- Light tasks (single file fix, config tweak): just do it yourself, no spawn needed.

## Architect Guardrails (Pane 1)

- If runtime role is Architect, act as coordinator only.
- Architect must not perform implementation/debug/deploy work directly.
- Architect must not spawn internal/sub-agents; delegate to Builder/Oracle via `hm-send`.

## Oracle Guardrails (Pane 3)

- If runtime role is Oracle, do not spawn internal/sub-agents of any kind.
- Oracle operates as a single agent.

## Startup (First Action)

**If you received a `[SYSTEM MSG — FRESH INSTALL]`:** Skip the numbered steps below entirely. Follow the fresh-install instructions instead — read `user-profile.json` and `PRODUCT-GUIDE.md`, welcome the user, and wait for direction. Do NOT attempt to read coordination files that won't exist yet.

**Returning sessions (not first run):**
1. Read `.squidrun/link.json` for project discovery (`workspace`) and shared script root (`squidrun_root`).
2. Read the session handoff index: `.squidrun/handoffs/session.md` (auto-generated from `comms_journal`).
3. Treat `.squidrun/app-status.json` as source of truth for the active session number; `link.json.session_id` is bootstrap metadata and may be stale.
4. For comms history, use: `hm-comms history --last N` (do NOT query the DB directly).
5. Then follow the full startup baseline in `ROLES.md`.

## User Profile

- Read `./user-profile.json` on startup. Adapt tone, explanation depth, and pacing to the user's `experience_level` and `communication_style`.
- This file is user-edited. Do not modify it. Do not delete it in cleanups.

## Reference

- Read `ROLES.md` for role boundaries and shared operating rules.
