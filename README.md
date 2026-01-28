# Hivemind

Multi-agent orchestration UI for AI coding assistants. Run 6 persistent AI instances (Claude, Codex, Gemini) that coordinate and trigger each other autonomously.

## What is this?

Hivemind is a desktop app that runs multiple AI coding CLI instances in parallel. Each agent has a role, persists across app restarts, and can trigger other agents through file-based communication.

**Watch AI agents coordinate and hand off work without manual intervention.**

## Features

### Core
- **6 Persistent Terminals** - Each running a full AI coding instance with all its tools
- **Multi-Model Support** - Claude Code, OpenAI Codex CLI, and Gemini CLI in the same session
- **Daemon Architecture** - Terminals survive app restarts (PTY processes managed by separate daemon)
- **Codex Exec Pipeline** - Codex panes use non-interactive `codex exec --json` with JSONL parsing and session resume
- **Agent-to-Agent Triggers** - Agents can trigger specific agents or groups via trigger files
- **Auto-Sync** - Changes to shared context files automatically notify all agents
- **Role-Based Context** - Each agent has its own working directory with role-specific CLAUDE.md/AGENTS.md

### Communication
- **MCP Integration** - Model Context Protocol for structured agent messaging
- **Message Queue** - Persistent message history with delivery confirmation
- **Group Messaging** - Send to individuals, groups, or broadcast to all
- **Sequence Numbers** - Duplicate message prevention with auto-reset on restart

### Developer Experience
- **Dry-Run Mode** - Simulate multi-agent flow without spawning real AI instances
- **Session History** - View past sessions with duration and agents involved
- **Projects Tab** - Quick-switch between recent projects
- **Quality Gates** - mypy, ESLint, serialization tests, pre-commit hooks
- **CLI Identity Badges** - Visual indicators showing which CLI each pane runs

### SDK Mode (Alternative to PTY)
- **4 Independent Claude Sessions** - Full Claude SDK instances via `hivemind-sdk-v2.py`
- **Honeycomb Thinking Animation** - Branded pulse animation with tool-type color coding
- **Streaming Typewriter Effect** - Real-time character-by-character text display
- **Session Status Indicators** - Per-pane status dots (idle, thinking, responding, error)

### Self-Healing
- **Auto-Nudge** - Detect and nudge frozen agents automatically with escalation
- **Adaptive Heartbeat** - Dynamic check intervals based on system activity
- **Agent Claims** - Track which agent owns which task
- **Session Persistence** - Context summaries saved between sessions
- **Focus Steal Prevention** - Saves/restores user focus during message injection

### Smart Automation
- **Smart Routing** - Auto-assign tasks to best-performing agent
- **Auto-Handoff** - Agents trigger next in chain on completion
- **Conflict Queue** - Prevent simultaneous file writes

## Agent Roles

| Pane | Role | CLI | Responsibility |
|------|------|-----|----------------|
| 1 | Architect | Claude | Architecture decisions, coordination, delegation |
| 2 | Orchestrator | Codex | Task routing, status tracking |
| 3 | Implementer A | Claude | UI components, renderer work |
| 4 | Implementer B | Codex | Backend, daemon, file watching |
| 5 | Investigator | Codex | Root cause analysis, debugging |
| 6 | Reviewer | Claude | Code review, verification, quality gates |

## How Triggers Work

Agents communicate by writing to trigger files:

| File | Who Gets Triggered |
|------|-------------------|
| `workspace/triggers/lead.txt` | Architect |
| `workspace/triggers/orchestrator.txt` | Orchestrator |
| `workspace/triggers/worker-a.txt` | Implementer A |
| `workspace/triggers/worker-b.txt` | Implementer B |
| `workspace/triggers/investigator.txt` | Investigator |
| `workspace/triggers/reviewer.txt` | Reviewer |
| `workspace/triggers/workers.txt` | Both Implementers |
| `workspace/triggers/all.txt` | Everyone |
| `workspace/triggers/others-{role}.txt` | Everyone except sender |

Example: Implementer B finishes a task and writes to `triggers/reviewer.txt` → Reviewer receives the message and starts their review.

Messages use sequence numbers to prevent duplicates: `(ARCHITECT #1): message here`

## Tech Stack

- **Electron** - Desktop app shell
- **Node.js** - Backend/main process
- **xterm.js** - Terminal emulation
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
```

## Project Structure

```
hivemind/
├── ui/                          # Electron app
│   ├── main.js                  # Main process, IPC, daemon client
│   ├── renderer.js              # UI logic, terminal management
│   ├── index.html               # Layout and styling
│   ├── preload.js               # Electron preload bridge
│   ├── config.js                # Shared constants and configuration
│   ├── terminal-daemon.js       # Daemon that owns PTY processes
│   ├── daemon-client.js         # Client library for daemon
│   ├── mcp-server.js            # MCP server for agent communication
│   └── modules/
│       ├── codex-exec.js        # Codex exec pipeline (non-interactive)
│       ├── sdk-bridge.js        # Python SDK ↔ Electron bridge
│       ├── sdk-renderer.js      # SDK mode message display + animations
│       ├── ipc-handlers.js      # IPC handler registration
│       ├── daemon-handlers.js   # Daemon event handlers
│       ├── terminal.js          # Terminal management and input
│       ├── triggers.js          # Trigger file routing
│       ├── watcher.js           # File system watcher with debounce
│       ├── settings.js          # Settings panel logic
│       ├── tabs.js              # Right panel tab UI
│       └── mcp-bridge.js        # MCP integration bridge
├── hivemind-sdk-v2.py           # Python SDK orchestrator (SDK mode)
├── workspace/                   # Shared workspace
│   ├── shared_context.md        # Shared context for all agents
│   ├── app-status.json          # Runtime state (mode, version)
│   ├── triggers/                # Agent trigger files
│   ├── instances/               # Per-agent working directories
│   └── build/                   # Build status, reviews, blockers
└── docs/                        # Documentation
```

## Platform

Windows-first (other platforms untested).

## Security Notes

This is a **development tool**, not a production web app. Some security decisions reflect this:

- **Context Isolation Disabled** - `contextIsolation: false` in Electron config. This allows direct Node.js access from renderer, which is intentional for terminal management. Do not use this pattern for apps that load untrusted content.

- **Permissions Bypass** - The `--dangerously-skip-permissions` flag is enabled for Claude Code. Codex uses `--dangerously-bypass-approvals-and-sandbox`. This gives AI agents full access without permission prompts. Use only in trusted environments.

- **Named Pipes** - The daemon uses `\\.\pipe\hivemind-terminal` which is accessible to any local process. Acceptable for local dev tool.

## License

MIT
