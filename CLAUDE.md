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

### SDK Mode Note
If you're running in SDK mode (not PTY terminals):
- Read `workspace/shared_context.md` for SDK-specific onboarding
- Your role comes from `workspace/instances/{role}/CLAUDE.md`
- Messages arrive via SDK API, not keyboard injection
- Use trigger files for inter-agent communication

---

## The One Rule

**Only touch files assigned to your role in SPRINT.md.**

---

## First Thing (Every Session) - AUTO REGISTER

**Do this immediately, no user input needed:**

1. **Read `workspace/app-status.json`** - Check runtime state (SDK mode, last restart time)
2. Read `docs/claude/REGISTRY.md`
3. Find the first role with status = OPEN
4. Claim it: change status to FILLED, add your name (Claude-[Role]), add today's date
5. Save the registry file
6. Say: "I've registered as [Role]. Starting on [first task] now."
7. Read `SPRINT.md` for your task details
8. Start working

**App Status File (`workspace/app-status.json`):**
```json
{
  "started": "2026-01-25T12:00:00.000Z",  // When app last started
  "sdkMode": true,                         // SDK or PTY mode
  "dryRun": false,                         // Dry run mode
  "lastUpdated": "2026-01-25T12:00:00.000Z"
}
```
**DO NOT ask user "did you restart?" or "are you in SDK mode?" - just read this file.**

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

## Communication Protocol - MANDATORY

**You are not alone. Other instances are working in parallel. Communicate through files.**

### ⚠️ CRITICAL: Agent-to-Agent Communication

**Terminal output is for talking to the USER. Trigger files are for talking to OTHER AGENTS.**

When you receive a message FROM another agent (prefixed with their role like `(LEAD):` or `(WORKER-A):`):
1. **DO NOT respond in terminal output** - the user is not your audience
2. **MUST reply via trigger file** - write to their trigger file
3. Format: `(YOUR-ROLE): Your response here`

Example:
- You receive in terminal: `(LEAD): Please review the auth changes`
- You reply by writing to `workspace/triggers/lead.txt`:
  ```
  (WORKER-B): Reviewed. Found 2 issues, see blockers.md
  ```

**This is MANDATORY. Responding to agents via terminal output defeats the entire purpose of multi-agent coordination.**

---

### Before Starting Work
1. Read `workspace/build/blockers.md` - are there blockers assigned to you?
2. Read `workspace/build/errors.md` - are there active errors?
3. Read `workspace/build/status.md` - what have others completed?

### After Completing Work
1. Update `workspace/build/status.md` with your completion
2. Check `workspace/build/blockers.md` again - did Reviewer find issues?
3. If you created blockers for others, they're in blockers.md
4. **Message relevant agents via triggers** about your completion

### When You Find Issues
1. Write to `workspace/build/blockers.md` with owner and suggested fix
2. Write to `workspace/build/errors.md` if it's a runtime error
3. **Message the affected agent via triggers** - don't assume user will relay

### Periodic Check (Every Major Task)
Re-read blockers.md. Another instance may have found issues with your code.

### Triggering Other Agents Directly (USE THIS!)

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
echo "(YOUR-ROLE #1): BUG: Fix needed in main.js line 50" > workspace/triggers/lead.txt
```

### ⚠️ Message Sequence Numbers (IMPORTANT)

Messages use sequence numbers to prevent duplicates: `(ROLE #N): message`

**The app resets sequence tracking on every restart.** This means:
- You can start from `#1` each session
- Don't worry about what sequence numbers were used before
- The format is: `(LEAD #1):`, `(WORKER-A #2):`, etc.

**If your messages aren't going through:**
1. Check the npm console for `[Trigger] SKIPPED duplicate`
2. If you see that, use a higher sequence number
3. This should NOT happen after the Jan 2026 fix, but if it does, restart the app

**Technical detail:** `workspace/message-state.json` tracks sequences but resets `lastSeen` on app startup to prevent stale blocking.

---

## Core Rules

1. **Only touch your files.** Check SPRINT.md for ownership.

2. **Read spec before coding.** The docs/ folder is the implementation spec.

3. **Push back on bad ideas.** Don't agree just to agree.

4. **Verify before claiming.** Use `ls` before saying a file exists.

5. **Update status.md when done.** Others need to know your progress.

6. **Blockers go in blockers.md.** Don't stay stuck.

7. **Check blockers.md for YOUR issues.** Reviewer writes there, you read there.

8. **Fresh session = restart already happened.** If you're in a new session, the user already restarted the app. Don't tell them to restart. If status.md says "requires restart to test", those fixes are NOW LIVE. Ask "Should I verify X is working?" not "Restart to test X."

---

## Reviewer Gate - MANDATORY Before "Ready to Test"

**CRITICAL: "Review the code" means INTEGRATION REVIEW, not just reading one file.**

Before ANY feature is marked "APPROVED FOR TESTING":

1. **Reviewer must audit ALL files involved** - not just the primary file
2. **Check cross-file contracts** - if A calls B, verify B expects what A sends
3. **Check IPC protocols** - sender and receiver must agree on message shape
4. **Check data format compatibility** - snake_case vs camelCase, nested vs flat
5. **Document findings in blockers.md** - even if they seem minor

**Anti-pattern (what went wrong with SDK V2):**
- ❌ Reviewer checked hivemind-sdk-v2.py in isolation
- ❌ Lead accepted "APPROVED" without cross-file verification
- ❌ Critical protocol mismatches (snake_case vs camelCase) were missed
- ❌ User had to demand a thorough audit to find obvious bugs

**Correct pattern:**
- ✅ Reviewer reads ALL files that interact (Python ↔ sdk-bridge.js ↔ renderer.js)
- ✅ Reviewer traces data flow end-to-end
- ✅ Lead verifies Reviewer did integration review, not just spot check
- ✅ No "APPROVED" until integration test passes

**If rushed:** Tell user "needs more review time" rather than approving broken code.

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
