# Hivemind

A plumber with zero software experience built this in a month.

Hivemind is a working multi-agent engineering system where one person directs 3 persistent AI agents, plus 2 internal teammates, that coordinate, recover from failures, and build shared institutional memory over time.

This is not a chatbot wrapper. It is a live orchestration runtime for team intelligence.

## Why This Matters

Most AI tools still treat memory as chat history. Hivemind treats memory as a team system:

- Shared persistent memory with a claim graph
- Consensus and disagreement tracking
- Executable evidence via isolated experiments
- Real delivery/reliability plumbing across agents

It is a working proof that one person can run a real AI engineering team with production-level coordination.

## What Is Running Today

### Core Runtime
- **PTY-only architecture** - one runtime path, no mode split
- **3 persistent panes** - Architect, DevOps, Analyst
- **2 internal teammates** - Frontend + Reviewer under Architect
- **WebSocket-first comms** - ACK/timeout/retry + fallback triggers

### Reliability + Recovery
- **Self-healing loop** - dead/stuck/stale detection, auto-restart, auto-nudge
- **Submit verification pipeline** - injection checks, retry backoff, guardrails
- **Daemon isolation** - terminal lifecycle survives app restarts

### Intelligence Layers
- **Event Kernel (Phases 1-4 complete)** - interaction contracts, telemetry, bridge
- **Evidence Ledger (runtime active)** - causal event history in SQLite WAL
- **Team Memory Runtime (fully shipped)** - Claim Graph -> Search -> Consensus -> Pattern Engine -> Control Plane
- **Experiment Engine (Phase 6 shipped)** - isolated PTY execution that attaches tamper-evident results back to claims

### Developer Experience
- **Quality gates** - ESLint, Jest, pre-commit gates, review gate
- **Current test count** - see latest CI/Jest output (changes frequently)
- **Session continuity** - intent board + context snapshots + Evidence Ledger hooks

## Agent Roles

| Pane | Role | Domain |
|------|------|--------|
| 1 | Architect (+ Frontend + Reviewer teammates) | Architecture, coordination, delegation, integration |
| 2 | DevOps | CI/CD, daemon/process/backend reliability |
| 5 | Analyst | Debugging, profiling, root-cause investigations |

Model/CLI assignment is runtime-configurable via `ui/settings.json` (`paneCommands`).

## How Triggers Work

Agents communicate through WebSocket messaging (primary) with trigger-file fallback.

**WebSocket (preferred):**
```bash
node ui/scripts/hm-send.js <target> "(ROLE #N): message"
```

**Trigger files (fallback):**

| File | Target |
|------|--------|
| `.hivemind/triggers/architect.txt` | Architect (pane 1) |
| `.hivemind/triggers/devops.txt` | DevOps (pane 2) |
| `.hivemind/triggers/analyst.txt` | Analyst (pane 5) |
| `.hivemind/triggers/workers.txt` | DevOps + Analyst |
| `.hivemind/triggers/all.txt` | Everyone |

## Tech Stack

- **Electron 28**
- **Node.js 18+**
- **xterm.js 6.0**
- **node-pty 1.1.0**
- **SQLite (WAL mode)** for evidence + team memory runtimes
- **WebSocket (`ws`)** for low-latency agent messaging
- **Claude Code CLI / Codex CLI / Gemini CLI**

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

```text
hivemind/
├── ui/
│   ├── main.js
│   ├── renderer.js
│   ├── index.html
│   ├── preload.js
│   ├── config.js
│   ├── terminal-daemon.js
│   ├── daemon-client.js
│   ├── mcp-server.js
│   ├── modules/
│   │   ├── terminal.js
│   │   ├── terminal/injection.js
│   │   ├── triggers.js
│   │   ├── event-bus.js
│   │   ├── websocket-server.js
│   │   ├── daemon-handlers.js
│   │   ├── team-memory/
│   │   │   ├── store.js
│   │   │   ├── claims.js
│   │   │   ├── worker.js
│   │   │   ├── worker-client.js
│   │   │   └── migrations/
│   │   ├── experiment/
│   │   │   ├── runtime.js
│   │   │   ├── profiles.js
│   │   │   ├── worker.js
│   │   │   └── worker-client.js
│   │   ├── main/
│   │   │   ├── hivemind-app.js
│   │   │   └── kernel-bridge.js
│   │   ├── tabs/
│   │   │   └── bridge.js
│   │   └── ipc/
│   │       ├── handler-registry.js
│   │       └── team-memory-handlers.js
│   ├── scripts/
│   │   ├── hm-send.js
│   │   ├── hm-claim.js
│   │   └── hm-experiment.js
│   └── __tests__/
├── .hivemind/
│   ├── app-status.json
│   ├── intent/
│   ├── triggers/
│   ├── build/
│   ├── context-snapshots/
│   ├── runtime/
│   │   ├── team-memory.sqlite
│   │   └── experiments/
├── workspace/                  # legacy fallback during migration
├── docs/
│   └── team-memory-spec.md
└── CLAUDE.md
```

## Key Files To Read First

1. `ui/config.js` - Pane/role/source-of-truth config
2. `ui/main.js` - Main process lifecycle
3. `ui/modules/main/hivemind-app.js` - Runtime orchestration glue
4. `ui/renderer.js` - UI + command routing
5. `ui/modules/terminal.js` - PTY runtime + pane behavior
6. `ui/modules/terminal/injection.js` - Injection and submit verification logic
7. `ui/modules/triggers.js` - Agent-to-agent delivery paths
8. `ui/modules/team-memory/runtime.js` - Team Memory runtime lifecycle
9. `ui/modules/experiment/runtime.js` - Experiment execution runtime
10. `docs/team-memory-spec.md` - Claim graph + experiment architecture

## Platform

Windows-first (other platforms not yet fully validated).

## Security Notes

This is a development tool, not a hardened production web app.

- `contextIsolation: false` is intentionally used for direct terminal integration.
- AI CLIs run with permissive flags in trusted local environments.
- The local daemon pipe is accessible to local processes.

## License

MIT
