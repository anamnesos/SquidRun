# Hivemind

Multi-agent orchestration UI for AI coding assistants. Run 3 persistent AI instances (Claude, Codex, Gemini) that coordinate and trigger each other autonomously.

## What is this?

Hivemind is a desktop app that runs multiple AI coding CLI instances in parallel. Each agent has a role, persists across app restarts, and can trigger other agents through file-based communication.

**Watch AI agents coordinate and hand off work without manual intervention.**

## Features

### Core
- **3 Persistent Terminals** - Each running a full AI coding instance with all its tools
- **Multi-Model Support** - Claude Code, OpenAI Codex CLI, and Gemini CLI in the same session
- **Daemon Architecture** - Terminals survive app restarts (PTY processes managed by separate daemon)
- **Codex Exec Pipeline** - Codex panes use non-interactive `codex exec --json` with JSONL parsing and session resume
- **Agent-to-Agent Triggers** - Agents can trigger specific agents or groups via trigger files
- **Auto-Sync** - Changes to shared context files automatically notify all agents
- **Role-Based Context** - Each agent has its own working directory with role-specific CLAUDE.md/AGENTS.md

### Command Center UI
- **Main Pane Focus** - Large left panel (60%) shows your primary agent (default: Architect)
- **Side Column** - 2 smaller panes (40%) for other agents, click any to swap with main
- **Command Bar** - Full-width input at bottom, targets main pane by default
- **Target Dropdown** - Send to specific agent, all agents, or current main pane
- **Delivery Status** - Visual feedback (sending/delivered/failed) on message submission

### Communication
- **MCP Integration** - Model Context Protocol for structured agent messaging
- **Message Queue** - Persistent message history with delivery confirmation
- **Group Messaging** - Send to individuals, groups, or broadcast to all
- **Sequence Numbers** - Duplicate message prevention with auto-reset on restart
- **Stuck Message Sweeper** - Auto-retry Enter on stuck messages every 30s

### Observability
- **Message Inspector** - Real-time view of trigger events, sequences, delivery status
- **Reliability Analytics** - Success rates, latency tracking, per-pane breakdowns
- **Agent Health Dashboard** - Per-pane indicators (last output, stuck warnings)
- **CLI Identity Badges** - Visual indicators showing which CLI each pane runs

### Developer Experience
- **Dry-Run Mode** - Simulate multi-agent flow without spawning real AI instances
- **Session History** - View past sessions with duration and agents involved
- **Projects Tab** - Quick-switch between recent projects
- **Quality Gates** - mypy, ESLint, Jest tests (2801+), pre-commit hooks
- **IPC Aliases** - Frontend compatibility layer for legacy UI components

### SDK Mode (Alternative to PTY)
- **3 Independent Agent Sessions** - Full SDK instances via `hivemind-sdk-v2.py`
- **Honeycomb Thinking Animation** - Branded pulse animation with tool-type color coding
- **Streaming Typewriter Effect** - Real-time character-by-character text display
- **Session Status Indicators** - Per-pane status dots (idle, thinking, responding, error)

### Self-Healing
- **Auto-Nudge** - Detect and nudge frozen agents automatically with escalation
- **Stuck Message Sweeper** - Periodic retry for messages stuck in textarea
- **Adaptive Heartbeat** - Dynamic check intervals based on system activity
- **Agent Claims** - Track which agent owns which task
- **Session Persistence** - Context summaries saved between sessions
- **Focus Steal Prevention** - Saves/restores user focus during message injection

### Smart Automation
- **Smart Routing** - Auto-assign tasks to best-performing agent
- **Auto-Handoff** - Agents trigger next in chain on completion
- **Conflict Queue** - Prevent simultaneous file writes

## Agent Roles

| Pane | Role | CLI | Domain |
|------|------|-----|--------|
| 1 | Architect | Claude | Architecture, coordination, delegation, git commits + Frontend/Reviewer as internal Agent Teams teammates |
| 2 | DevOps | Codex | CI/CD, deployment, infrastructure, daemon, processes, backend |
| 5 | Analyst | Gemini | Debugging, profiling, root cause analysis, investigations |

**Note:** Frontend and Reviewer run as internal Agent Teams teammates of Architect (pane 1), not as separate panes.

## How Triggers Work

Agents communicate via WebSocket messaging (preferred) or trigger files (fallback):

**WebSocket (preferred):**
```bash
node ui/scripts/hm-send.js <target> "(ROLE #N): message"
```

**Trigger files:**

| File | Who Gets Triggered |
|------|-------------------|
| `workspace/triggers/architect.txt` | Architect (pane 1) |
| `workspace/triggers/devops.txt` | DevOps (pane 2) |
| `workspace/triggers/analyst.txt` | Analyst (pane 5) |
| `workspace/triggers/workers.txt` | DevOps + Analyst |
| `workspace/triggers/all.txt` | Everyone |

Example: DevOps finishes a task and writes to `triggers/architect.txt` -> Architect receives the message.

Messages use sequence numbers to prevent duplicates: `(ARCHITECT #1): message here`

## Tech Stack

- **Electron** - Desktop app shell
- **Node.js** - Backend/main process
- **xterm.js 6.0** - Terminal emulation
- **node-pty** - Pseudo-terminal for spawning shells
- **chokidar** - File system watching
- **Claude Code CLI** - AI coding assistant (Anthropic)
- **Codex CLI** - AI coding assistant (OpenAI)
- **Gemini CLI** - AI coding assistant (Google)

## Getting Started

```bash
# Install dependencies
cd ui && npm install

# Start the app
npm start

# Run tests
npm test
```

## Project Structure

```
hivemind/
├── ui/                          # Electron app
│   ├── main.js                  # Main process, IPC, state machine
│   ├── renderer.js              # UI logic, pane management, command bar
│   ├── index.html               # Layout (main pane + side column)
│   ├── preload.js               # Electron preload bridge
│   ├── config.js                # Shared constants and configuration
│   ├── terminal-daemon.js       # Daemon that owns PTY processes
│   ├── daemon-client.js         # Client library for daemon
│   ├── mcp-server.js            # MCP server for agent communication
│   ├── styles/                  # CSS modules
│   │   ├── layout.css           # Main layout, command bar
│   │   ├── tabs.css             # Right panel tabs
│   │   └── ...
│   └── modules/
│       ├── terminal.js          # Terminal management, input injection, sweeper
│       ├── triggers.js          # Trigger file routing, sequence tracking
│       ├── watcher.js           # File system watcher with debounce
│       ├── codex-exec.js        # Codex exec pipeline (non-interactive)
│       ├── sdk-bridge.js        # Python SDK <-> Electron bridge
│       ├── sdk-renderer.js      # SDK mode message display + animations
│       ├── daemon-handlers.js   # Daemon event handlers
│       ├── settings.js          # Settings panel logic
│       ├── tabs.js              # Right panel tab UI
│       └── ipc/                 # IPC handler modules
│           ├── state-handlers.js
│           ├── checkpoint-handlers.js
│           └── ...
├── hivemind-sdk-v2.py           # Python SDK orchestrator (SDK mode)
├── workspace/                   # Shared workspace
│   ├── shared_context.md        # Shared context for all agents
│   ├── app-status.json          # Runtime state (mode, version)
│   ├── triggers/                # Agent trigger files
│   ├── instances/               # Per-agent working directories
│   │   ├── arch/                # Architect (pane 1)
│   │   ├── infra/               # DevOps (pane 2)
│   │   └── ana/                 # Analyst (pane 5)
│   └── build/                   # Build status, reviews, blockers
├── docs/                        # Documentation and specs
│   ├── roles/                   # Modular role instruction files
│   └── models/                  # Model-specific notes
└── CLAUDE.md                    # Master agent instructions
```

## Key Files for Understanding the Codebase

If you want to understand how Hivemind works, read these 7 files:

1. **`ui/main.js`** - Electron main process, state machine, IPC handlers
2. **`ui/renderer.js`** - UI logic, pane management, command bar input
3. **`ui/modules/terminal.js`** - Terminal management, PTY injection, stuck sweeper
4. **`ui/modules/triggers.js`** - Agent-to-agent communication, sequence tracking
5. **`ui/terminal-daemon.js`** - PTY daemon architecture, process management
6. **`CLAUDE.md`** - How agents are instructed (master config)
7. **`workspace/instances/arch/CLAUDE.md`** - Example agent role configuration

## Platform

Windows-first (other platforms untested).

## Security Notes

This is a **development tool**, not a production web app. Some security decisions reflect this:

- **Context Isolation Disabled** - `contextIsolation: false` in Electron config. This allows direct Node.js access from renderer, which is intentional for terminal management. Do not use this pattern for apps that load untrusted content.

- **Permissions Bypass** - The `--dangerously-skip-permissions` flag is enabled for Claude Code. Codex uses `--dangerously-bypass-approvals-and-sandbox`. This gives AI agents full access without permission prompts. Use only in trusted environments.

- **Named Pipes** - The daemon uses `\\.\pipe\hivemind-terminal` which is accessible to any local process. Acceptable for local dev tool.

## License

MIT
