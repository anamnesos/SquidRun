# Hivemind Sprint

**Last Updated:** Session 80, February 6, 2026

---

## Architecture (3-Pane Layout)

| Pane | Role | Agent | CLI | Responsibilities |
|------|------|-------|-----|------------------|
| **1** | Architect | Claude (Opus) | `claude` | Coordination, architecture, git commits |
| | + Frontend | Agent Teams teammate | (internal) | UI, renderer.js, CSS |
| | + Reviewer | Agent Teams teammate | (internal) | Code review, quality gates |
| **2** | DevOps | Codex | `codex` | CI/CD, infra, daemon, processes, backend |
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

## Current Session (80) - Doc Cleanup Sprint

| Task | Owner | Status |
|------|-------|--------|
| Update CLAUDE.md to 3-pane | Architect | DONE |
| Overhaul SPRINT.md | Architect | DONE |
| Audit + fix MAP.md | Frontend | IN PROGRESS |
| Archive blockers.md | DevOps | ASSIGNED |
| Archive status.md | DevOps | ASSIGNED |
| Audit agent instruction files | Analyst | IN PROGRESS |
| Review all changes | Reviewer | BLOCKED (waiting on above) |

---

## Previous Sprints (Complete)

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
