# Hivemind Sprint

**Last Updated:** Session 80, February 6, 2026

---

## Architecture (3-Pane Layout)

| Pane | Role | Agent | CLI | Responsibilities |
|------|------|-------|-----|------------------|
| **1** | Architect | Claude (Opus) | `claude` | Coordination, architecture, git commits |
| | + Frontend | Agent Teams teammate | (internal) | UI, renderer.js, CSS |
| | + Reviewer | Agent Teams teammate | (internal) | Code review, quality gates |
| **2** | DevOps | Codex | `codex` | CI/CD, deployment, daemon, processes, backend |
| **5** | Analyst | Gemini | `gemini` | Debugging, profiling, root cause analysis |

**Config source of truth:** `ui/config.js` (PANE_ROLES, PANE_IDS, ROLE_ID_MAP, TRIGGER_TARGETS)

---

## File Ownership

### Architect (Pane 1 + internal teammates)
- `ui/renderer.js` - UI logic, terminal management
- `ui/index.html` - Layout, styling, HTML
- `ui/modules/` - UI modules (Frontend teammate)
- `ui/__tests__/` - Test files (Reviewer teammate)
- `SPRINT.md`, `CLAUDE.md`, `workspace/` docs

### DevOps (Pane 2)
- `ui/main.js` - Electron main process
- `ui/terminal-daemon.js` - Daemon process
- `ui/daemon-client.js` - Client library
- `.github/workflows/` - CI/CD

### Analyst (Pane 5)
- Investigations, audits, profiling
- `workspace/build/reviews/` - Review documents
- No code ownership — reads everything, edits nothing

---

## Current Session (81) - Rename Sprint + Instance Cleanup

| Task | Owner | Status |
|------|-------|--------|
| Audit instance dirs for stale refs | Analyst | DONE |
| Doc cleanup (ana/, infra/ AGENTS.md/GEMINI.md) | Architect | DONE |
| Delete stale back/, front/AGENTS.md, nul artifacts | Architect | DONE |
| Remove Pane 4 from settings.json | DevOps | DONE |
| spawnClaude → spawnAgent rename (50+ refs) | Architect | DONE |
| spawnAllClaude → spawnAllAgents rename | Architect | DONE |
| infra/ → devops/ instance dir rename | Architect | DONE |
| Reviewer gate | Reviewer | APPROVED |
| Delete stale infra/ directory | — | BLOCKED (needs restart) |
| Runtime verification of 3-pane UI | — | BLOCKED (needs restart) |

---

## Previous Sprints (Complete)

### Session 80 - Doc Cleanup Sprint
- Updated 20+ doc files to 3-pane references
- Archived blockers.md, status.md, shared_context.md
- Source JSDoc + test mock audit (14 test files aligned)
- Commits: a7ac5e6, 8b1ffc9, 5a4848a, bd64803, d143270

### Session 79 - 3-Pane Migration
- Merged Pane 4 (Backend) into Pane 2 (DevOps)
- 54 files changed, 87 test suites / 2796 tests passing
- Committed: `1f9b7b9`

### Session 77 - Agent Teams Migration
- Removed Panes 3 (Frontend) and 6 (Reviewer)
- Migrated to internal Agent Teams teammates of Architect

### Session 76 - Agent Teams POC
- Confirmed Agent Teams working with Claude 2.1.32
- Full cycle: spawnTeam → TaskCreate → teammate → SendMessage → report

### Sessions 70-73 - SDK Mode + Organic UI + Reliability
- SDK overhaul, organic UI v2, smart watchdog
- CLI native migration (Claude 2.1.32, Codex 0.98.0)

### Sessions 50-69 - Quality + Modularization
- Role rename, 12,955 lines dead code removed
- Renderer modularized (2383 → 1774 lines)
- Gemini integration, trigger race condition fix
- Message injection reliability (WebSocket)

### V2 - Quality & Polish
- Test suite (87 suites, 2796 tests)
- Modularize (3000+ lines → modules)
- Polish (logging, health, scrollback)

### V1 - Core Features
- Electron app with terminal panes
- Terminal daemon (survives app restart)
- File-based state machine
- Trigger system for agent coordination

---

## Communication

Agents coordinate through:
- **WebSocket messaging** (`hm-send.js`) - primary, fast, reliable
- **Trigger files** (`workspace/triggers/`) - fallback
- **Shared docs** (`workspace/build/`) - status.md, blockers.md, errors.md
