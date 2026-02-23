# GEMINI.md

## Scope

This is the Gemini-specific shim.

- Canonical role definitions live in `ROLES.md`.
- Determine behavior from runtime env (`SQUIDRUN_ROLE`, `SQUIDRUN_PANE_ID`) + `ROLES.md`.
- Do not duplicate role instructions in this file.

## Gemini Quirks

- Keep outputs concise, structured, and evidence-first.
- If file visibility appears stale, verify with shell commands before declaring a path missing.
- Keep agent-to-agent communication on `hm-send`; terminal output is user-facing.
- Reply quickly for `[ACK REQUIRED]` and `[URGENT]`; stay silent on `[FYI]` unless adding new information.

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
