# Hivemind

Multi-agent orchestration UI for AI coding assistants. Run 3 persistent AI instances (Claude, Codex) that coordinate and trigger each other autonomously.

## What is this?

Hivemind is a desktop app that runs multiple AI coding CLI instances in parallel. Each agent has a role, persists across app restarts, and coordinates through WebSocket messaging and file-based triggers.

**Watch AI agents coordinate and hand off work without manual intervention.**

## Features

### Core
- **3 Persistent Terminals** - Each running a full AI coding instance with all its tools
- **Multi-Model Support** - Claude Code and OpenAI Codex CLI in the same session
- **Daemon Architecture** - Terminals survive app restarts (PTY processes managed by separate daemon)
- **Agent-to-Agent Triggers** - Agents trigger specific agents or groups via WebSocket (preferred) or trigger files (fallback)
- **Auto-Sync** - Changes to shared context files automatically notify all agents
- **Role-Based Context** - Each agent has its own working directory with role-specific instructions
- **Image Generation** - Built-in AI image generation via Recraft V3 / OpenAI gpt-image-1

### Command Center UI
- **Main Pane Focus** - Large left panel (60%) shows your primary agent (default: Architect)
- **Side Column** - 2 smaller panes (40%) for other agents, click any to swap with main
- **Command Bar** - Full-width input at bottom, targets main pane by default
- **Target Dropdown** - Send to specific agent, all agents, or current main pane
- **Delivery Status** - Visual feedback (sending/delivered/failed) on message submission
- **Bridge Tab** - User-facing dashboard with agent status, system metrics, and live event stream

### Communication
- **WebSocket Messaging** - Primary inter-agent communication with ACK-timeout-resend and server-side dedup
- **Trigger File Fallback** - Automatic fallback when WebSocket is stale
- **Comms Reliability Stack** - ACK-timeout-resend, server dedup, heartbeat health, chunked PTY writes with ack barrier, active-typing deferral
- **Group Messaging** - Send to individuals, groups, or broadcast to all
- **Sequence Numbers** - Duplicate message prevention with auto-reset on restart

### Event Kernel (Phases 1-4 Complete)
- **Interaction Kernel** - Contracts, state vector, injection/terminal/renderer events
- **Telemetry** - Ring buffer with query API, health strip
- **Daemon Bridge** - Event propagation between main process and daemon
- **Transition Ledger** - State transition tracking with evidence spec signals
- **Compaction Gate** - Lexical evidence required for confirmed state, chunk-inactivity decay, safety valve (injection latency: 122-727ms)

### Team Memory Runtime (Phases 0-3 Complete, Phase 4 In Progress)
- **Claim Graph Runtime** - Team-shared claim lifecycle with create/query/update/deprecate flows
- **SQLite WAL Store** - Persistent memory in `workspace/runtime/team-memory.sqlite`
- **Worker + Client Split** - Forked worker execution via `ui/modules/team-memory/worker.js` and `ui/modules/team-memory/worker-client.js`
- **Claims API Module** - Claim CRUD, evidence links, decisions, consensus, belief snapshots, contradiction tracking
- **Search Layer** - Phase 2 retrieval via dedicated search migrations and indexes
- **CLI Tooling** - `ui/scripts/hm-claim.js` for manual claim operations and diagnostics

### Observability
- **Message Inspector** - Real-time view of trigger events, sequences, delivery status
- **Reliability Analytics** - Success rates, latency tracking, per-pane breakdowns
- **Agent Health Dashboard** - Per-pane indicators (last output, stuck warnings)
- **CLI Identity Badges** - Visual indicators showing which CLI each pane runs
- **Comms Metrics** - Health strip with per-metric bucket tracking

### Developer Experience
- **Dry-Run Mode** - Simulate multi-agent flow without spawning real AI instances
- **Session History** - View past sessions with duration and agents involved
- **Projects Tab** - Quick-switch between recent projects
- **Quality Gates** - ESLint, Jest tests (108 suites, 3300 tests), pre-commit hooks, doc-lint gate
- **Shared Intent Board** - Per-agent JSON status files for cross-agent awareness
- **Session Handoff** - Structured JSON handoff for session continuity across restarts

### SDK Mode (Alternative to PTY)
- **3 Independent Agent Sessions** - Full SDK instances via `hivemind-sdk-v2.py`
- **Honeycomb Thinking Animation** - Branded pulse animation with tool-type color coding
- **Streaming Typewriter Effect** - Real-time character-by-character text display
- **Session Status Indicators** - Per-pane status dots (idle, thinking, responding, error)

### Self-Healing
- **PTY Health Monitoring** - Daemon-level alive/idle detection with status cascade (dead > stuck > stale > healthy)
- **Auto-Restart on Dead Panes** - Detects dead terminals on daemon connect and restarts them automatically
- **Auto-Nudge** - Detect and nudge frozen agents automatically with escalation
- **Focus Steal Prevention** - Saves/restores user focus during message injection (active-typing deferral, not focus-only)
- **2-Phase Submit Verification** - Enter dispatch with acceptance verification and retry+backoff

### Smart Automation
- **Smart Routing** - Auto-assign tasks to best-performing agent
- **Auto-Handoff** - Agents trigger next in chain on completion
- **Conflict Queue** - Prevent simultaneous file writes

## Agent Roles

| Pane | Role | CLI | Domain |
|------|------|-----|--------|
| 1 | Architect | Claude | Architecture, coordination, delegation, git commits + Frontend/Reviewer as internal Agent Teams teammates |
| 2 | DevOps | Codex | CI/CD, deployment, infrastructure, daemon, processes, backend |
| 5 | Analyst | Codex | Debugging, profiling, root cause analysis, investigations |

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

- **Electron 28** - Desktop app shell
- **Node.js 18+** - Backend/main process
- **xterm.js 6.0** - Terminal emulation (WebGL-accelerated)
- **node-pty 1.1.0** - Pseudo-terminal for spawning shells
- **chokidar** - File system watching
- **Claude Code CLI** - AI coding assistant (Anthropic)
- **Codex CLI** - AI coding assistant (OpenAI)

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
│       ├── terminal.js          # Terminal management, PTY connections
│       ├── terminal/injection.js # Input injection queue, focus deferral, submit verification
│       ├── triggers.js          # Agent-to-agent messaging, sequence tracking
│       ├── watcher.js           # File system watcher with debounce
│       ├── event-bus.js         # Event kernel, ring buffer telemetry
│       ├── team-memory/         # Team Memory Runtime
│       │   ├── store.js         # SQLite store and schema bootstrap
│       │   ├── claims.js        # Claim graph CRUD/query operations
│       │   ├── worker.js        # Forked worker runtime
│       │   ├── worker-client.js # Main-process worker client
│       │   └── migrations/      # Team Memory schema/search migrations
│       ├── websocket-server.js  # WebSocket server for agent messaging
│       ├── daemon-handlers.js   # Daemon event handlers, message throttling
│       ├── main/
│       │   ├── hivemind-app.js  # Central app controller
│       │   ├── kernel-bridge.js # Event kernel daemon bridge
│       │   └── ...
│       ├── tabs/
│       │   ├── bridge.js        # Bridge tab (agent status, metrics, events)
│       │   └── ...
│       └── ipc/                 # IPC handler modules
│           ├── handler-registry.js # Route table
│           ├── pty-handlers.js     # Terminal control
│           └── ...
├── hivemind-sdk-v2.py           # Python SDK orchestrator (SDK mode)
├── workspace/                   # Shared workspace
│   ├── session-handoff.json     # Primary session state (tasks, roadmap, issues, stats)
│   ├── shared_context.md        # Shared context for all agents
│   ├── app-status.json          # Runtime state (mode, version)
│   ├── review.json              # Pre-commit review gate (Gate 7)
│   ├── triggers/                # Agent trigger files
│   ├── instances/               # Per-agent working directories
│   │   ├── arch/                # Architect (pane 1)
│   │   ├── devops/              # DevOps (pane 2)
│   │   └── ana/                 # Analyst (pane 5)
│   ├── build/                   # Build status, reviews, blockers, specs
│   ├── intent/                  # Shared intent board (per-agent JSON status)
│   ├── runtime/                 # Runtime databases/artifacts (`team-memory.sqlite`)
│   └── scripts/                 # Agent lifecycle hooks
├── docs/                        # Documentation and specs
│   ├── team-memory-spec.md      # Team Memory Runtime spec
│   └── ...
└── CLAUDE.md                    # Master agent instructions
```

## Key Files for Understanding the Codebase

If you want to understand how Hivemind works, read these files:

1. **`ui/config.js`** - Source of truth for pane roles, trigger targets, instance directories
2. **`ui/main.js`** - Electron main process, app initialization
3. **`ui/modules/main/hivemind-app.js`** - Central app controller, coordinates managers and daemon
4. **`ui/renderer.js`** - UI logic, pane management, command bar input
5. **`ui/modules/terminal.js`** - Terminal management, PTY connections
6. **`ui/modules/terminal/injection.js`** - Input injection queue, focus deferral, submit verification
7. **`ui/modules/triggers.js`** - Agent-to-agent communication, sequence tracking
8. **`ui/terminal-daemon.js`** - PTY daemon architecture, process management
9. **`ui/modules/team-memory/runtime.js`** - Team Memory Runtime lifecycle, worker wiring, DB bootstrap
10. **`ui/scripts/hm-claim.js`** - Team Memory CLI for claim create/query/update/deprecate operations
11. **`docs/team-memory-spec.md`** - Team Memory architecture/spec (phases, schema, contracts)
12. **`CLAUDE.md`** - How agents are instructed (master config)

## Platform

Windows-first (other platforms untested).

## Security Notes

This is a **development tool**, not a production web app. Some security decisions reflect this:

- **Context Isolation Disabled** - `contextIsolation: false` in Electron config. This allows direct Node.js access from renderer, which is intentional for terminal management. Do not use this pattern for apps that load untrusted content.

- **Permissions Bypass** - The `--dangerously-skip-permissions` flag is enabled for Claude Code. Codex uses `--dangerously-bypass-approvals-and-sandbox`. This gives AI agents full access without permission prompts. Use only in trusted environments.

- **Named Pipes** - The daemon uses `\\.\pipe\hivemind-terminal` which is accessible to any local process. Acceptable for local dev tool.

## License

MIT
