# Hivemind

Multi-agent orchestration UI for Claude Code. Run 4 persistent Claude instances that coordinate and trigger each other autonomously.

## What is this?

Hivemind is a desktop app that runs multiple Claude Code CLI instances in parallel. Each agent has a role (Lead, Worker A, Worker B, Reviewer), persists across app restarts, and can trigger other agents through file-based communication.

**Watch AI agents coordinate and hand off work without manual intervention.**

## Features

### Core
- **4 Persistent Terminals** - Each running a full Claude Code instance with all its tools
- **Daemon Architecture** - Terminals survive app restarts (PTY processes managed by separate daemon)
- **Agent-to-Agent Triggers** - Agents can trigger specific agents or groups via trigger files
- **Auto-Sync** - Changes to shared context files automatically notify all agents
- **Role-Based Context** - Each agent has its own working directory with role-specific CLAUDE.md

### Developer Experience (V3)
- **Dry-Run Mode** - Simulate multi-agent flow without spawning real Claude
- **Session History** - View past sessions with duration and agents involved
- **Projects Tab** - Quick-switch between recent projects
- **Workflow Gate** - Enforce Lead → Reviewer → Workers approval flow

### Self-Healing (V4)
- **Auto-Unstick** - Detect and nudge frozen terminals automatically
- **Agent Claims** - Track which agent owns which task
- **Session Persistence** - Context summaries saved between sessions

### Smart Automation (V6)
- **Smart Routing** - Auto-assign tasks to best-performing agent
- **Auto-Handoff** - Agents trigger next in chain on completion
- **Conflict Queue** - Prevent simultaneous file writes
- **Learning Mode** - Improve routing based on outcomes

### Quality & Observability (V7)
- **Activity Log** - Real-time event tracking with filters
- **Quality Validation** - Confidence scoring for completions
- **Rollback Support** - Checkpoint and restore file states

### Testing & Automation (V8)
- **Test Runner** - Auto-detect Jest/npm and run tests
- **Test Results UI** - Display pass/fail with details
- **CI Integration** - Pre-commit validation hooks

## How Triggers Work

Agents communicate by writing to trigger files:

| File | Who Gets Triggered |
|------|-------------------|
| `workspace/triggers/lead.txt` | Lead only |
| `workspace/triggers/worker-a.txt` | Worker A only |
| `workspace/triggers/worker-b.txt` | Worker B only |
| `workspace/triggers/reviewer.txt` | Reviewer only |
| `workspace/triggers/workers.txt` | Worker A + B |
| `workspace/triggers/all.txt` | Everyone |

Example: Worker B finishes a task and writes to `triggers/worker-a.txt` → Worker A receives the message and starts their work.

## Tech Stack

- **Electron** - Desktop app shell
- **Node.js** - Backend/main process  
- **xterm.js** - Terminal emulation
- **node-pty** - Pseudo-terminal for spawning shells
- **chokidar** - File system watching
- **Claude Code CLI** - Spawned in each terminal pane

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
├── ui/                     # Electron app
│   ├── main.js            # Main process, IPC, daemon client
│   ├── renderer.js        # UI logic, terminal management
│   ├── index.html         # Layout and styling
│   ├── terminal-daemon.js # Daemon that owns PTY processes
│   └── daemon-client.js   # Client library for daemon
├── workspace/             # Shared workspace
│   ├── shared_context.md  # Shared context for all agents
│   ├── triggers/          # Agent trigger files
│   └── build/             # Build status and reviews
└── docs/                  # Documentation
```

## Platform

Windows-first (other platforms untested).

## Security Notes

This is a **development tool**, not a production web app. Some security decisions reflect this:

- **Context Isolation Disabled** - `contextIsolation: false` in Electron config. This allows direct Node.js access from renderer, which is intentional for terminal management. Do not use this pattern for apps that load untrusted content.

- **Permissions Bypass** - The `--dangerously-skip-permissions` flag can be enabled in settings. This gives Claude Code full access without permission prompts. Use only in trusted environments.

- **Named Pipes** - The daemon uses `\\.\pipe\hivemind-terminal` which is accessible to any local process. Acceptable for local dev tool.

## License

MIT
