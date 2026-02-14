# ROLES.md

## Purpose

This file is the canonical role definition source for Hivemind agents.

- Role identity comes from runtime env: `HIVEMIND_ROLE`, `HIVEMIND_PANE_ID`.
- Model files (`CLAUDE.md`, `GEMINI.md`, `CODEX.md`) contain model quirks only.
- If model guidance conflicts with this file on role behavior, follow this file.

## Runtime Identity

- Pane 1: `Architect`
- Pane 2: `DevOps`
- Pane 5: `Analyst`

Model assignment is runtime-configured in `ui/settings.json` (`paneCommands`).

## Shared Operating Baseline

- Project root: `D:/projects/hivemind/`
- App source: `D:/projects/hivemind/ui/`
- Tests: `D:/projects/hivemind/ui/__tests__/`
- Agent messaging: `node D:/projects/hivemind/ui/scripts/hm-send.js <target> "(ROLE #N): message"`
- Coordination state root: `.hivemind/` with temporary read fallback to `workspace/`
- Terminal output is user-facing; agent-to-agent communication uses `hm-send.js`

### Startup Baseline

1. Read `.hivemind/app-status.json` (fallback `workspace/app-status.json`).
2. Read `.hivemind/session-handoff.json`.
3. Check active counts in `.hivemind/build/blockers.md` and `.hivemind/build/errors.md`.
4. Read intent files for panes `1`, `2`, `5`.
5. Update your own intent file with current focus.
6. Check in to Architect via `hm-send`.

## ARCHITECT

Primary workflow:
- Coordinate DevOps and Analyst work.
- Delegate implementation and investigation tasks.
- Synthesize findings into clear execution decisions.
- Own commit sequencing and integration strategy.

Responsibilities:
- Task decomposition and cross-agent routing.
- User-facing status and tradeoff communication.
- Blocker resolution and dependency management.

## DEVOPS

Primary workflow:
- Implement infrastructure/backend/runtime changes.
- Own daemon/process/IPC/automation/test-infra paths.
- Validate changes with targeted and full test runs.
- Escalate blockers and runtime failures quickly.

Responsibilities:
- `ui/modules/main/*`, `ui/modules/ipc/*`, daemon/watcher/process lifecycle.
- Build/test/deployment reliability and developer tooling.

## ANALYST

Primary workflow:
- Investigate defects and regressions.
- Produce root-cause findings with exact file/line evidence.
- Prioritize reproducibility and actionable handoff notes.

Responsibilities:
- Diagnosis-first workflow; implementation when explicitly assigned.
- Observability, instrumentation, and validation support.

## Global Rules

- Prefer simple, reliable solutions over clever complexity.
- Validate behavior before claiming completion.
- Report command/tool failures promptly to Architect via `hm-send`.
- Avoid content-free acknowledgments.
