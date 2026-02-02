# Hivemind Codebase Map

**Last Updated:** 2026-02-02
**Purpose:** Navigation guide for developers (human and AI agents)

---

## Quick Start (READ THIS FIRST)

**What is this app?**
Hivemind is an Electron desktop app that orchestrates 6 persistent AI agent instances (Claude, Codex, Gemini) working in parallel. Each agent has a specialized role (Architect, Infra, Frontend, Backend, Analyst, Reviewer) and coordinates with others through file-based triggers and shared context.

**How does it work?**
- **Primary Mode (PTY):** 6 terminal processes managed by a persistent daemon. Full Claude/Codex/Gemini CLIs run in pseudo-terminals. Messages sent via keyboard injection. Terminals survive app restarts.
- **Alternative Mode (SDK):** 6 Python SDK sessions orchestrated by `hivemind-sdk-v2.py`. Direct API calls instead of keyboard injection. Currently experimental.

**Architecture Decision (Session 65):** PTY mode is primary/stable. SDK mode is experimental/debug path.

---

## File Structure

### Active Codebase (PRODUCTION)

```
hivemind/
├── ui/                          # Electron app (main codebase)
│   ├── main.js                  # Electron lifecycle, modular init
│   ├── renderer.js              # UI orchestration, terminal mgmt, pane switching
│   ├── index.html               # Layout (60% main + 40% side), CSS, structure
│   ├── preload.js               # IPC bridge
│   ├── config.js                # Shared constants, pane roles, paths
│   ├── terminal-daemon.js       # PTY owner, survives restarts
│   ├── daemon-client.js         # Client library for daemon
│   ├── mcp-server.js            # MCP protocol server
│   ├── package.json             # Dependencies (xterm.js, node-pty, chokidar)
│   │
│   ├── modules/                 # Feature modules (116 files, ~1.5MB)
│   │   ├── terminal.js          # xterm management, PTY, injection
│   │   ├── triggers.js          # Agent-to-agent messaging
│   │   ├── watcher.js           # File system watching (chokidar)
│   │   ├── sdk-bridge.js        # Python SDK orchestration
│   │   ├── codex-exec.js        # Codex non-interactive pipeline
│   │   │
│   │   ├── main/                # App managers (7 files)
│   │   │   ├── hivemind-app.js  # Main controller
│   │   │   ├── settings-manager.js
│   │   │   ├── activity-manager.js
│   │   │   └── ...
│   │   │
│   │   ├── ipc/                 # IPC handlers (58 files)
│   │   │   ├── handler-registry.js  # Route table
│   │   │   ├── pty-handlers.js      # Terminal control
│   │   │   ├── sdk-handlers.js      # SDK mode
│   │   │   ├── daemon-handlers.js   # Daemon lifecycle
│   │   │   └── ...
│   │   │
│   │   ├── terminal/            # Terminal submodules
│   │   │   ├── injection.js     # Input injection queue
│   │   │   └── recovery.js      # Stuck recovery
│   │   │
│   │   └── ...                  # UI, utilities, analysis modules
│   │
│   ├── styles/                  # CSS modules
│   │   └── layout.css           # Main layout, panes, command bar
│   │
│   └── __tests__/               # Jest tests (2700+ tests)
│       └── ...
│
├── hivemind-sdk-v2.py           # Python SDK orchestrator (58KB)
├── test-sdk.py                  # SDK testing utility
│
├── workspace/                   # Shared context for agents
│   ├── app-status.json          # Runtime state (mode, version)
│   ├── current_state.md         # Slim session summary
│   ├── session-handoff.json     # Structured task/blocker handoff
│   ├── shared_context.md        # Full session context
│   │
│   ├── build/                   # Build artifacts, reviews, decisions
│   │   ├── status.md            # Task completions
│   │   ├── blockers.md          # Active blockers
│   │   ├── errors.md            # Active errors
│   │   └── ...
│   │
│   ├── instances/               # Per-agent working directories
│   │   ├── lead/                # Architect (Claude)
│   │   ├── orchestrator/        # Infra (Codex)
│   │   ├── worker-a/            # Frontend (Claude)
│   │   ├── worker-b/            # Backend (Codex)
│   │   ├── investigator/        # Analyst (Gemini)
│   │   └── reviewer/            # Reviewer (Claude)
│   │       └── CLAUDE.md        # Role-specific instructions
│   │
│   └── triggers/                # Agent communication files
│       ├── architect.txt
│       ├── infra.txt
│       ├── frontend.txt
│       ├── backend.txt
│       ├── analyst.txt
│       ├── reviewer.txt
│       ├── all.txt              # Broadcast to all
│       └── others-*.txt         # Broadcast except sender
│
├── docs/                        # Documentation
│   ├── claude/                  # Agent-specific docs
│   ├── instance-mapping.md      # Folder → role mapping
│   ├── triggers.md              # Trigger system docs
│   └── ...
│
├── CLAUDE.md                    # Master agent instructions
├── VISION.md                    # Project philosophy
├── README.md                    # Feature overview
├── MAP.md                       # This file
├── CLEANUP.md                   # Cleanup candidates
└── SPRINT.md                    # Task assignments
```

### Obsolete Code (Ignore/Cleanup)

- **docs/archive/python-v1/** - Dead Python architecture (156KB, no references)
- **Large log files** - Already cleaned (was 360MB bloat)
- **workspace/backups/** - 120MB of old session backups (keep last 3)
- **Build artifacts** - `.mypy_cache/`, `__pycache__/` (already cleaned)

---

## Key Files (Priority Order)

### Must Read to Understand System

1. **`ui/config.js`** (3.3KB)
   Source of truth for pane roles, trigger targets, instance directories

2. **`ui/main.js`** (52 lines)
   Electron lifecycle, app initialization (now modular)

3. **`ui/modules/terminal.js`** (45KB)
   Terminal management, PTY connections, injection queue, stuck detection

4. **`ui/modules/triggers.js`** (60KB)
   Agent-to-agent communication, message sequencing, reliability metrics

5. **`ui/terminal-daemon.js`** (57KB)
   Daemon architecture, PTY ownership, survives restarts

6. **`CLAUDE.md`** (27KB, project root)
   Master agent instructions, human context, vision alignment, protocols

7. **`hivemind-sdk-v2.py`** (58KB)
   Python SDK orchestration, agent session management (ClaudeAgent, CodexAgent, GeminiAgent)

### Should Read for Context

- `VISION.md` - Project philosophy ("Service as a Software")
- `README.md` - Feature overview
- `ui/modules/main/hivemind-app.js` - Central app controller
- `ui/modules/sdk-bridge.js` - SDK mode integration
- `ui/modules/watcher.js` - File watching + context sync
- `workspace/shared_context.md` - Session history

### Reference (As Needed)

- `ui/renderer.js` (62KB) - UI orchestration (complex)
- `ui/index.html` (165KB) - Layout structure
- `ui/modules/ipc/handler-registry.js` - IPC route table
- `ui/modules/tabs.js` (262KB) - Right panel state machine (HUGE, could refactor)

---

## Data Flow

### User Input → App → Agents

```
User types in command bar
    ↓
renderer.js (terminal.js) receives input
    ↓
PTY Mode: Keyboard injection → xterm → injectionController queues keystrokes
    OR
SDK Mode: sdk-bridge → Python API → agent.send_message()
    ↓
Agent (Claude/Codex/Gemini CLI) receives message
    ↓
Agent runs tools, reads context from workspace/instances/{role}/
    ↓
Agent writes response to terminal/API stream
    ↓
PTY Mode: daemon.log captures → renderer gets via pty.onData
    OR
SDK Mode: Python streams back → sdk-renderer displays
    ↓
Response appears in pane
```

### Agent-to-Agent Communication (Triggers)

```
Agent A finishes work
    ↓
Writes to workspace/triggers/{agent-b}.txt with message format: (AGENT-A #N): message
    ↓
watcher.js detects file change (chokidar, 500ms debounce)
    ↓
Notifies renderer via IPC
    ↓
renderer.js sends to Agent B's pane (injection or SDK message)
    ↓
Agent B receives message and continues work
    ↓
Trigger file is cleared after delivery
```

### State Persistence Across Restarts

```
Current session state
    → workspace/shared_context.md (human-readable)
    → workspace/current_state.md (slim version, 11KB)
    → workspace/session-handoff.json (structured JSON)
    → workspace/build/{status,blockers,errors}.md

Agent instructions
    → workspace/instances/{role}/CLAUDE.md or GEMINI.md

On app restart:
  1. Fresh agent reads workspace/app-status.json (mode, what happened)
  2. Reads workspace/current_state.md (slim session summary)
  3. Reads CLAUDE.md/GEMINI.md (role instructions)
  4. Daemon reconnects to existing PTY processes (if PTY mode)
  5. Agent auto-resumes work
```

---

## Module Guide

### Terminal Management (PTY Mode)

| Module | Purpose |
|--------|---------|
| `terminal.js` | xterm instances, font sizing, scrollback, search |
| `terminal/injection.js` | Keyboard event queueing, timing guards, focus stealing prevention |
| `terminal/recovery.js` | Stuck detection, auto-recovery, Enter retry logic |
| `terminal-daemon.js` | Spawn PTY, write bytes, resize, kill, persist across restarts |
| `daemon-client.js` | Client-side daemon communication protocol |

### SDK Mode

| Module | Purpose |
|--------|---------|
| `sdk-bridge.js` | Spawn Python, manage 6 sessions, message routing |
| `sdk-renderer.js` | Display streaming responses, honeycomb animation |
| `hivemind-sdk-v2.py` | Python Agent classes (ClaudeAgent, CodexAgent, GeminiAgent) |
| `codex-exec.js` | Codex non-interactive pipeline (exec --json mode) |

### Communication & Triggers

| Module | Purpose |
|--------|---------|
| `triggers.js` | Read/write trigger files, sequence tracking, reliability metrics |
| `watcher.js` | File system watching (chokidar), debounced context sync |
| `message-state.json` | Sequence tracking, prevents duplicate messages |

### IPC/Main Process

| Module | Purpose |
|--------|---------|
| `main.js` + `modules/main/*.js` | Electron lifecycle, settings, activity tracking |
| `ipc/handler-registry.js` | Route all IPC calls to handlers |
| `ipc/*.js` | 58 specialized handlers (pty, sdk, model-switch, git, etc.) |

### UI Rendering

| Module | Purpose |
|--------|---------|
| `renderer.js` | Main UI controller, pane switching, command bar |
| `tabs.js` | Right panel state machine (262KB - refactor candidate) |
| `ui-view.js` | UI state layer |
| `sdk-renderer.js` | SDK mode display with animations |
| `status-strip.js` | Bottom status bar |
| `command-palette.js` | Command palette UI |

### Utilities & Support

| Module | Purpose |
|--------|---------|
| `constants.js` | Shared timing constants |
| `logger.js` | Logging utility |
| `notifications.js` | Toast notifications |
| `formatters.js` | Time formatting |
| `settings.js` | Settings UI |
| `recovery-manager.js` | Multi-layer recovery system |
| `backup-manager.js` | Session backup/restore |

---

## Agent Context System

### What Agents Read

**On startup:**
1. `workspace/app-status.json` - Runtime state (mode, version)
2. `workspace/current_state.md` - Slim session summary (~11KB)
3. `workspace/build/blockers.md` - Active blockers
4. `workspace/build/errors.md` - Active errors
5. Role-specific `CLAUDE.md` or `GEMINI.md` - Instructions

**During work:**
- Read `workspace/shared_context.md` - Full session history
- Write to `workspace/triggers/{other-agent}.txt` - Send messages
- Write to `workspace/build/status.md` - Report completion
- Write to `workspace/build/blockers.md` - Raise blockers
- Write to `workspace/build/errors.md` - Log errors

### Token Optimization

**Slim files (read always):**
- `app-status.json` (0.2KB)
- `current_state.md` (11KB)
- `blockers.md` (12KB)
- `errors.md` (1.6KB)

**Full files (read when needed):**
- `shared_context.md` (7.5KB)
- `status.md` (varies)

**Archives (historical only):**
- `shared_context_archive.md`
- `status-archive.md`
- `blockers-archive.md`
- `errors-archive.md`

---

## Adding Features - Common Patterns

### Add a new UI component

1. Create file in `ui/modules/` or `ui/modules/{category}/`
2. Export public functions/class
3. Import in `renderer.js` or `ui-view.js`
4. Add styles to `ui/styles/{component}.css`
5. Add tests in `ui/__tests__/{component}.test.js`
6. If IPC needed, add handler in `ui/modules/ipc/{feature}-handlers.js`
7. Register handler in `ipc/handler-registry.js`

### Add agent communication feature

1. Define message format (JSON in `workspace/triggers/`)
2. Implement sender (e.g., Frontend writes to `triggers/backend.txt`)
3. Implement receiver (Backend reads trigger, parses, acts)
4. Add test: send/receive messages, verify sequence tracking
5. Add reliability metrics in `triggers.js`

### Add SDK mode support

1. Update `hivemind-sdk-v2.py` (Agent class method)
2. Update `sdk-bridge.js` (message routing)
3. Update `ipc/sdk-*-handlers.js`
4. Test both modes (SDK + PTY) with `app-status.json` toggle

---

## Debugging Guide

### "Message didn't arrive between agents"

1. Check `workspace/message-state.json` - is sequence tracking stuck?
2. Check npm console for "[Trigger]" entries
3. Verify sender used absolute path: `D:\projects\hivemind\workspace\triggers\...`
4. Check if trigger file is being watched (watcher.js logs)
5. Verify receiver pane is running

### "Agent is stuck/not responding"

1. Check `ui/modules/constants.js` for timeout thresholds
2. Check `terminal/recovery.js` - is auto-recovery triggering?
3. Check `terminal/injection.js` - is queue building up?
4. PTY mode: Check `daemon.log` for PTY errors
5. SDK mode: Check Python stderr for exceptions

### "Tests failing"

1. Run `npm test` in `ui/` folder
2. Check `jest.config.js` for test configuration
3. Most failures are mock mismatches - update mocks if code changed
4. Check handler tests in `ui/__tests__/ipc/`

### "SDK mode shows errors"

1. Verify Python packages: `pip install -r requirements.txt`
2. Check `workspace/app-status.json` for `sdkMode: true`
3. Check `sdk-bridge.js` for session initialization
4. Check Python stderr for API key errors (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY)

### "Performance issues"

1. Check `workspace/perf-profile.json` for hot paths
2. Profile `tabs.js` (262KB, potential bottleneck)
3. Check `triggers.js` reliability metrics
4. Use DevTools profiler: `npm run dev` + F12

### "Where are the logs?"

**Available logs:**
- `workspace/console.log` - DevTools console (regenerated on restart)
- `workspace/logs/app.log` - Application log (regenerated on restart)
- `ui/daemon.log` - Daemon process log
- npm terminal - Main process logs (file watcher, IPC, state machine)
- Agent terminals - Individual agent outputs

**IMPORTANT:** Never ask user to check logs - read them yourself with `tail -50 workspace/console.log` or similar.

---

## Architecture Notes

### PTY vs SDK Mode

**PTY (Primary):**
- 6 independent terminal processes
- True parallelism (all agents work simultaneously)
- Proven stable
- Keyboard injection (quirks but reliable)

**SDK (Alternative):**
- 6 Python SDK sessions
- Explicit API calls (cleaner)
- Currently has parallelism bug (sequential execution)
- Being debugged

**Decision:** PTY is production. SDK is experimental.

### Daemon Architecture

- `terminal-daemon.js` runs as separate process
- Owns all PTY processes
- Electron app connects as client via named pipe
- Terminals survive app restarts (daemon keeps running)
- `daemon-client.js` is client library

### Message Sequencing

- Every agent message includes sequence: `(ARCHITECT #1): message`
- `message-state.json` tracks seen sequences, prevents duplicates
- On restart, `lastSeen` is reset (prevents stale blocking)
- Delivery-ack timeout: 65 seconds

### File-Based Communication

- Agents write to `workspace/triggers/{target}.txt`
- `watcher.js` detects changes (500ms debounce)
- File cleared after delivery (prevents re-triggering)
- Works because workspace is network-accessible to all processes

### Role Mapping (Legacy)

- Instance folders use v1 names: `lead/`, `orchestrator/`, `worker-a/`, etc.
- Config uses v2 names: Architect, Infra, Frontend, Backend, Analyst, Reviewer
- Trigger files support BOTH (transition compatibility)
- Code should use new names

---

## Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Desktop App | Electron | 28 |
| UI | Vanilla JS + CSS | - |
| Terminal | xterm.js | 6.0 |
| PTY | node-pty | 1.0 |
| Daemon | Node.js | 18 |
| IPC | Electron IPC | - |
| File Watching | chokidar | 3.6 |
| Testing | Jest | 30 (2700+ tests) |
| Python SDK | Multi-agent | Claude SDK, OpenAI Agents, Google GenAI |
| Message Protocol | MCP | 1.25 |
| Linting | ESLint | 9 |

---

## Quick Reference

### Start the app
```bash
cd ui
npm start
```

### Run tests
```bash
cd ui
npm test
```

### Check PTY mode
```bash
# App status shows current mode
cat workspace/app-status.json
```

### Send agent message (from code)
```javascript
// Write to trigger file
fs.writeFileSync(
  'D:/projects/hivemind/workspace/triggers/backend.txt',
  '(FRONTEND #1): Please review auth changes'
);
```

### Check if agent is stuck
```bash
# Check injection queue
tail -50 ui/daemon.log | grep injection

# Check recovery attempts
tail -50 workspace/console.log | grep recovery
```

---

**End of Map**

For cleanup candidates, see `CLEANUP.md`.
For project vision, see `VISION.md`.
For current tasks, see `SPRINT.md`.
