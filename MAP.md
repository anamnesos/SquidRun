# Hivemind Codebase Map

**Last Updated:** 2026-02-07
**Purpose:** Navigation guide for developers (human and AI agents)

---

## Quick Start (READ THIS FIRST)

**What is this app?**
Hivemind is an Electron desktop app that orchestrates 3 persistent AI agent instances (Claude, Codex, Gemini) working in parallel. Each agent has a specialized role (Architect, DevOps, Analyst) and coordinates with others through file-based triggers and shared context. Architect (Claude) has internal Frontend and Reviewer teammates via Agent Teams.

**How does it work?**
- **Primary Mode (PTY):** 3 terminal processes managed by a persistent daemon. Native Claude/Codex CLIs and npm Gemini CLI run in pseudo-terminals. Messages sent via keyboard injection. Terminals survive app restarts.
- **Alternative Mode (SDK):** 3 Python SDK sessions orchestrated by `hivemind-sdk-v2.py`. Direct API calls instead of keyboard injection. Supports true parallelism.

**Architecture Decision (Session 73+79):** Hybrid Consensus. Hivemind remains outer-loop coordinator. Native Agent Teams (Opus 4.6) as opt-in per-pane enhancement. Gemini as shared vision service (Oracle). 3-pane layout (1=Architect, 2=DevOps, 5=Analyst).

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
│   ├── modules/                 # Feature modules (143 files)
│   │   ├── terminal.js          # xterm management, PTY, injection
│   │   ├── triggers.js          # Agent-to-agent messaging (modular)
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
│   │   ├── daemon-handlers.js   # Daemon lifecycle, message throttling
│   │   │
│   │   ├── ipc/                 # IPC handlers (57 files)
│   │   │   ├── handler-registry.js  # Route table
│   │   │   ├── pty-handlers.js      # Terminal control
│   │   │   ├── sdk-handlers.js      # SDK mode
│   │   │   └── ...
│   │   │
│   │   ├── terminal/            # Terminal submodules
│   │   │   ├── injection.js     # Input injection queue
│   │   │   └── recovery.js      # Stuck recovery
│   │   │
│   │   ├── triggers/            # Modular trigger logic
│   │   │   ├── routing.js       # Smart routing
│   │   │   ├── sequencing.js    # Duplicate prevention
│   │   │   ├── war-room.js      # Global log
│   │   │   └── metrics.js       # Reliability stats
│   │   │
│   │   ├── tabs/                # Right panel modular tabs (Refactored S72)
│   │   │   ├── activity.js, build.js, workflow.js, etc.
│   │   │
│   │   ├── memory/              # Session memory (10 files)
│   │   │   ├── memory-store.js      # Persistent memory
│   │   │   ├── memory-summarizer.js # Context summarization
│   │   │   └── ...
│   │   │
│   │   ├── analysis/            # Code analysis (4 files)
│   │   │   ├── code-review.js
│   │   │   └── cost-optimizer.js
│   │   │
│   │   ├── plugins/             # Plugin system (2 files)
│   │   │   └── plugin-manager.js
│   │   │
│   │   ├── scaffolding/         # Project scaffolding (1 file)
│   │   │   └── project-scaffolder.js
│   │   │
│   │   ├── security/            # Security management (1 file)
│   │   │   └── security-manager.js
│   │   │
│   │   ├── websocket-server.js  # WebSocket server for agent messaging (port 0 for ephemeral binding in tests)
│   │   ├── sdk-renderer.js      # SDK mode renderer
│   │   ├── model-selector.js    # Model selection logic
│   │   ├── smart-routing.js     # Smart message routing
│   │   ├── gemini-oracle.js     # Gemini Oracle integration
│   │   └── ...                  # Other utilities
│   │
│   ├── sdk-ui/                  # Organic UI v2
│   │   ├── organic-ui.js        # Rounded containers, visual streams
│   │   └── bubble-canvas.js     # Legacy bubble UI
│   │
│   ├── scripts/                 # Utility scripts
│   │   ├── hm-send.js           # WebSocket messaging CLI
│   │   └── hm-screenshot.js     # Screenshot utility
│   │
│   ├── styles/                  # CSS modules
│   │   ├── layout.css           # Main layout
│   │   └── tabs/                # Modular tab styles (20 files)
│   │
│   └── __tests__/               # Jest tests (89 suites, 2803 tests)
│       └── ...
│
├── hivemind-sdk-v2.py           # Python SDK orchestrator (locked parallelism)
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
│   │   ├── arch/, devops/, ana/ # Active (panes 1, 2, 5)
│   │   ├── front/, rev/         # Legacy dirs (panes removed, dirs kept for history)
│   │
│   ├── triggers/                # Agent communication files (created at runtime)
│   │   ├── architect.txt, devops.txt, analyst.txt, workers.txt, all.txt
│   │
│   ├── intent/                 # Shared intent board (JSON per-agent status)
│   │   ├── 1.json, 2.json, 5.json
│   │
│   ├── references/             # Agent capability references
│   │   └── agent-capabilities.md
│   │
│   └── scripts/                # Hook scripts for agent automation
│       ├── arch-hooks.js       # Architect lifecycle hooks (Claude Code)
│       └── ana-hooks.js        # Analyst lifecycle hooks (Gemini CLI)
```

### Obsolete Code (Ignore/Cleanup)

- **docs/archive/python-v1/** - Dead Python architecture
- **ui/modules/tabs.js** - Refactored to sub-modules (only ~126 lines, coordinator stub)
- **Large log files** - workspace/console.log, ui/daemon.log (Safe to delete)

---

## Key Files (Priority Order)

### Must Read to Understand System

1. **`ui/config.js`**
   Source of truth for pane roles, trigger targets, instance directories, and role mapping.

2. **`ui/main.js`**
   Electron lifecycle, Central app initialization.

3. **`ui/modules/main/hivemind-app.js`**
   Central app controller, coordinates managers and daemon. Includes PTY health monitoring and auto-restart on dead panes.

4. **`ui/modules/terminal.js`**
   Terminal management, PTY connections, injection queue.

5. **`ui/modules/triggers.js`**
   Agent-to-agent communication, coordinates modular sub-modules.

6. **`ui/terminal-daemon.js`**
   PTY owner, survives restarts, heartbeat watchdog, Smart Watchdog (churning stall detection).

7. **`hivemind-sdk-v2.py`**
   Python SDK orchestration, agent session management.

---

## Architecture Notes

### Hybrid Consensus (Session 73)

- **Hivemind:** Outer-loop coordinator, cross-model orchestration, global context.
- **Native Teams:** Opt-in per-pane enhancement for Claude/Codex (Opus 4.6).
- **Oracle:** Gemini-powered shared vision and visual QA service.
- **PTY:** Remains the primary, stable fallback for all users.

### Message Sequencing

- Every agent message includes sequence: `(ARCHITECT #1): message`
- `message-state.json` tracks seen sequences, prevents duplicates.
- On restart, `lastSeen` is reset (prevents stale blocking).
- Delivery-ack timeout: 65 seconds.

---

## Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Desktop App | Electron | 28 |
| UI | Vanilla JS + CSS | - |
| Terminal | xterm.js | 6.0 |
| PTY | node-pty | 1.0 |
| CLIs | Native (Claude/Codex), npm (Gemini) | - |
| Daemon | Node.js | 18+ |
| File Watching | chokidar | 3.6 |
| Testing | Jest | 30 (89 suites, 2803 tests) |
| Python SDK | Multi-agent | Claude SDK, OpenAI Agents, Google GenAI |
| Message Protocol | MCP | 1.25 |

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

---

**End of Map**

For cleanup candidates, see `CLEANUP.md`.
For project vision, see `VISION.md`.
For current tasks, see `SPRINT.md`.