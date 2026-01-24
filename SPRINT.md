# Hivemind Sprint

## Current: V3 - Developer Experience

**Status:** PLANNING
**Started:** January 24, 2026

---

## Instance Roles

| Instance | Role | Responsibilities |
|----------|------|------------------|
| **Instance 1** | Lead | Coordination, architecture decisions, integration |
| **Instance 2** | Worker A | UI/renderer work, UX features |
| **Instance 3** | Worker B | Backend/daemon work, file operations |
| **Instance 4** | Reviewer | Code review, testing, verification |

---

## V3 Goals

Based on team feedback from V2:

1. **Dry-run mode** - Simulate multi-agent flow without spawning Claude (testing/demos)
2. **Context handoff** - Better context persistence between agent handoffs
3. **Session history** - Replay/review past sessions
4. **Deferred tabs** - Projects, Live Preview (from Phase 4)

---

## Task Assignments

| Task | Owner | Status | Description |
|------|-------|--------|-------------|
| V3-1 | Lead | PENDING | Define V3 scope and assign tasks |
| V3-2 | TBD | PENDING | TBD based on planning |

---

## File Ownership

### Lead (Instance 1)
- `ui/main.js` - State machine, IPC, coordination
- `SPRINT.md`, `workspace/shared_context.md`

### Worker A (Instance 2)
- `ui/renderer.js` - UI logic
- `ui/index.html` - Layout/styling
- `ui/modules/` - UI modules

### Worker B (Instance 3)
- `ui/terminal-daemon.js` - Daemon process
- `ui/daemon-client.js` - Client library
- `workspace/` - File operations

### Reviewer (Instance 4)
- `ui/__tests__/` - Test files
- `workspace/build/reviews/` - Review documents

---

## Previous Sprints (Complete)

### V2 - Quality & Polish ✅
- Sprint 2.1: Test suite (86 tests)
- Sprint 2.2: Modularize (3000+ lines → 9 files)
- Sprint 2.3: Polish (logging, health, scrollback, flash, kill all, others triggers)

### V1 - Core Features ✅
- Electron app with 4 terminal panes
- Terminal daemon (survives app restart)
- File-based state machine
- Trigger system for agent coordination
- Settings, folder picker, friction panel

---

## Communication

All instances read/write to `workspace/build/` for coordination:
- `status.md` - Task completion tracking
- `blockers.md` - Questions and blockers
- `reviews/` - Reviewer feedback
