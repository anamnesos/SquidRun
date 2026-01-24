# CLAUDE.md

---

**Project:** Hivemind - Multi-agent orchestration for Claude Code
**Status:** Active Build Sprint
**Last Updated:** January 2026

---

## CRITICAL CONTEXT

You are BUILDING a multi-agent system. You are NOT the agents in that system.
The Reviewer in the codebase is a PRODUCT FEATURE, not your role.
Your role comes from the sprint file, not from the code you're writing.

---

## The One Rule

**Only touch files assigned to your role in SPRINT.md.**

---

## First Thing (Every Session) - AUTO REGISTER

**Do this immediately, no user input needed:**

1. Read `docs/claude/REGISTRY.md`
2. Find the first role with status = OPEN
3. Claim it: change status to FILLED, add your name (Claude-[Role]), add today's date
4. Save the registry file
5. Say: "I've registered as [Role]. Starting on [first task] now."
6. Read `SPRINT.md` for your task details
7. Start working

**If all roles are FILLED:** Ask the user what role they need.

**If user overrides:** They may tell you to take a specific role. Do that instead.

---

## Roles and Ownership

| Role | Files Owned | Tasks |
|------|-------------|-------|
| **Lead** | ui/main.js (state machine, IPC), coordination | Architecture decisions, state transitions |
| **Worker A** | ui/renderer.js (UI logic), ui/index.html (layout) | UI components, panel logic |
| **Worker B** | ui/main.js (file watchers, processes), workspace/ | File watching, process management |
| **Reviewer** | workspace/build/reviews/, verification | Review code, test UI, verify functionality |

---

## Documentation

| Doc | Purpose |
|-----|---------|
| `docs/claude/REGISTRY.md` | Who's working on what (check/update first) |
| `SPRINT.md` | Task assignments and details |
| `workspace/build/status.md` | Task completion tracking |
| `workspace/build/blockers.md` | Questions and blockers |
| `workspace/build/friction.md` | Problems and patterns (LOG FRICTION HERE) |
| `workspace/build/errors.md` | Active errors - CHECK THIS FIRST if stuck |
| `workspace/shared_context.md` | Current task context for all agents |
| `workspace/feedback.md` | Agent feedback and discussions |

**Actual Code (READ THIS, NOT docs/):**
| File | What It Does |
|------|--------------|
| `ui/main.js` | Electron main process, state machine, IPC handlers, file watcher |
| `ui/renderer.js` | UI logic, terminal management, panels |
| `ui/index.html` | Layout, styling, HTML structure |

**Note:** The `docs/` folder contains *planning specs* from an earlier Python architecture that was abandoned. The actual implementation is in `ui/`. Read the code, not the old docs.

---

## Communication Protocol - CHECK SHARED FILES

**You are not alone. Other instances are working in parallel. Communicate through files.**

### Before Starting Work
1. Read `workspace/build/blockers.md` - are there blockers assigned to you?
2. Read `workspace/build/errors.md` - are there active errors?
3. Read `workspace/build/status.md` - what have others completed?

### After Completing Work
1. Update `workspace/build/status.md` with your completion
2. Check `workspace/build/blockers.md` again - did Reviewer find issues?
3. If you created blockers for others, they're in blockers.md

### When You Find Issues
1. Write to `workspace/build/blockers.md` with owner and suggested fix
2. Write to `workspace/build/errors.md` if it's a runtime error
3. **Don't assume the user will relay messages** - the files ARE the communication

### Periodic Check (Every Major Task)
Re-read blockers.md. Another instance may have found issues with your code.

### Triggering Other Agents Directly

To send a message directly to another agent's terminal, write to `workspace/triggers/`:

| File | Targets |
|------|---------|
| `workspace/triggers/lead.txt` | Lead (pane 1) |
| `workspace/triggers/worker-a.txt` | Worker A (pane 2) |
| `workspace/triggers/worker-b.txt` | Worker B (pane 3) |
| `workspace/triggers/reviewer.txt` | Reviewer (pane 4) |
| `workspace/triggers/workers.txt` | Both workers (panes 2+3) |
| `workspace/triggers/all.txt` | All agents |
| `workspace/triggers/others-{role}.txt` | Everyone except sender |

The file watcher detects changes and injects the content into the target terminal(s). The file is cleared after sending.

**Example:** To tell Lead about a bug:
```
echo "BUG: Fix needed in main.js line 50" > workspace/triggers/lead.txt
```

---

## Core Rules

1. **Only touch your files.** Check SPRINT.md for ownership.

2. **Read spec before coding.** The docs/ folder is the implementation spec.

3. **Push back on bad ideas.** Don't agree just to agree.

4. **Verify before claiming.** Use `ls` before saying a file exists.

5. **Update status.md when done.** Others need to know your progress.

6. **Blockers go in blockers.md.** Don't stay stuck.

7. **Check blockers.md for YOUR issues.** Reviewer writes there, you read there.

---

## Tech Stack

- **Electron** - Desktop app shell
- **Node.js** - Backend/main process
- **xterm.js** - Terminal emulation in browser
- **node-pty** - Pseudo-terminal for spawning shells
- **chokidar** - File system watching
- **Claude Code CLI** - Spawned in each terminal pane

**Platform:** Windows-first (others untested)

---

## Quick Checks

```bash
# Install dependencies
cd ui && npm install

# Run the app
cd ui && npm start

# Check if Electron launches with 4 terminal panes
```

---

## What We're Building

Hivemind automates multi-Claude workflows. We're building it using the same multi-instance pattern it will eventually automate.

---

_END OF CLAUDE.md_
