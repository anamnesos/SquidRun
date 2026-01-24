# Hivemind

Multi-agent orchestration UI for Claude Code. Run 4 persistent Claude instances that coordinate and trigger each other autonomously.

## What is this?

Hivemind is a desktop app that runs multiple Claude Code CLI instances in parallel. Each agent has a role (Lead, Worker A, Worker B, Reviewer), persists across app restarts, and can trigger other agents through file-based communication.

**Watch AI agents coordinate and hand off work without manual intervention.**

## Features

- **4 Persistent Terminals** - Each running a full Claude Code instance with all its tools
- **Daemon Architecture** - Terminals survive app restarts (PTY processes managed by separate daemon)
- **Agent-to-Agent Triggers** - Agents can trigger specific agents or groups via trigger files
- **Auto-Sync** - Changes to shared context files automatically notify all agents
- **Role-Based Context** - Each agent has its own working directory with role-specific CLAUDE.md
- **Visual UI** - See all 4 agents working simultaneously in real-time

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

## License

MIT
