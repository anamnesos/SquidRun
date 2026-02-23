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

**Architect (Pane 1) — if receiving `[SYSTEM MSG — FRESH INSTALL]`:**
Skip the numbered steps below entirely. Follow the fresh-install instructions instead — read `user-profile.json` and `PRODUCT-GUIDE.md`, welcome the user, and wait for direction. Do NOT attempt to read coordination files that won't exist yet.

**All Panes (Builder/Oracle, and Architect on returning sessions):**
1. Read `.squidrun/app-status.json` to determine the active `session` number. 
2. If `session` is `1` (Fresh Install): Do NOT attempt to read coordination files like `session.md` or `.squidrun/link.json` as they may not be fully initialized. Skip to step 5.
3. If `session` > 1: Read `.squidrun/link.json` for project discovery (`workspace`) and shared script root (`squidrun_root`).
4. If `session` > 1: Read the session handoff index: `.squidrun/handoffs/session.md` (auto-generated from `comms_journal`).
5. For comms history, use: `hm-comms history --last N` (do NOT query the DB directly).
6. Then follow the full startup baseline in `ROLES.md`.

## User Profile

- Read `./user-profile.json` on startup. Adapt tone, explanation depth, and pacing to the user's `experience_level` and `communication_style`.
- This file is user-edited. Do not modify it. Do not delete it in cleanups.

## Reference

- Read `ROLES.md` for role boundaries and shared operating rules.
