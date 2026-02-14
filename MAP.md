# Hivemind Codebase Map

**Last Updated:** 2026-02-13
**Purpose:** Navigation guide for developers (human and AI agents)

---

## Quick Start (READ THIS FIRST)

**What is this app?**
Hivemind is an Electron desktop app that orchestrates 3 persistent AI agent instances working in parallel. Each agent has a specialized role (Architect, DevOps, Analyst) and can run any supported CLI (Claude, Codex, Gemini) — model assignment is runtime config in `ui/settings.json` → `paneCommands`. Agents coordinate through WebSocket messaging and file-based trigger fallback. Architect has internal Frontend and Reviewer teammates via Agent Teams.

**How does it work?**
- **Primary Mode (PTY):** 3 terminal processes managed by a persistent daemon. Native Claude/Codex CLIs and npm Gemini CLI run in pseudo-terminals. Messages sent via keyboard injection. Terminals survive app restarts.
- **Alternative Mode (SDK):** PURGED in Session 123. PTY is the only mode. Clean-slate SDK rebuild planned for separate project.
- **Team Memory Runtime:** Shared claim-graph memory layer in `ui/modules/team-memory/` backed by SQLite WAL (`workspace/runtime/team-memory.sqlite`) with IPC + WebSocket integration.

**Architecture Decision (Session 73+79):** Hybrid Consensus. Hivemind remains outer-loop coordinator. Native Agent Teams as opt-in per-pane enhancement. 3-pane layout (1=Architect, 2=DevOps, 5=Analyst). **Models are runtime config** — any pane can run any supported CLI (Claude, Codex, Gemini). Check `ui/settings.json` → `paneCommands` for current assignments.

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
│   │   ├── team-memory/         # Team Memory Runtime (Phases 0-3 complete, Phase 4 in progress)
│   │   │   ├── store.js         # SQLite store + schema management
│   │   │   ├── claims.js        # Claim graph CRUD/query/consensus operations
│   │   │   ├── runtime.js       # Runtime lifecycle and orchestration
│   │   │   ├── worker.js        # Forked worker process
│   │   │   ├── worker-client.js # Main-process worker client
│   │   │   ├── migrations.js    # Migration runner
│   │   │   └── migrations/      # 001-004 schema/search/pattern migrations
│   │   │
│   │   ├── main/                # App managers
│   │   │   ├── hivemind-app.js  # Main controller
│   │   │   ├── kernel-bridge.js # Event kernel daemon bridge
│   │   │   ├── settings-manager.js
│   │   │   ├── activity-manager.js
│   │   │   └── ...
│   │   │
│   │   ├── daemon-handlers.js   # Daemon lifecycle, message throttling
│   │   │
│   │   ├── ipc/                 # IPC handlers (57 files)
│   │   │   ├── handler-registry.js  # Route table
│   │   │   ├── pty-handlers.js      # Terminal control
│   │   │   ├── evidence-ledger-handlers.js # Evidence Ledger IPC
│   │   │   ├── team-memory-handlers.js # Team Memory IPC endpoints
│   │   │   └── ...
│   │   │
│   │   ├── terminal/            # Terminal submodules
│   │   │   ├── injection.js     # Input injection queue, focus deferral, submit verification
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
│   │   ├── plugins/             # Plugin system (2 files)
│   │   │   └── plugin-manager.js
│   │   │
│   │   ├── scaffolding/         # Project scaffolding (1 file)
│   │   │   └── project-scaffolder.js
│   │   │
│   │   ├── websocket-server.js  # WebSocket server for agent messaging (port 0 for ephemeral binding in tests)
│   │   ├── constants.js          # Shared constants
│   │   ├── model-selector.js    # Model selection logic
│   │   ├── smart-routing.js     # Smart message routing
│   │   ├── gemini-oracle.js     # Gemini Oracle integration
│   │   └── ...                  # Other utilities
│   │
│   │
│   ├── scripts/                 # Utility scripts
│   │   ├── hm-send.js           # WebSocket messaging CLI
│   │   ├── hm-claim.js          # Team Memory claim CLI
│   │   └── hm-screenshot.js     # Screenshot utility
│   │
│   ├── styles/                  # CSS modules
│   │   ├── layout.css           # Main layout
│   │   └── tabs/                # Modular tab styles (20 files)
│   │
│   └── __tests__/               # Jest tests (108 suites, 3300 tests)
│       └── ...
│
├── hivemind-sdk-v2.py           # Python SDK orchestrator (locked parallelism)
├── test-sdk.py                  # SDK testing utility
│
├── workspace/                   # Shared context for agents
│   ├── app-status.json          # Runtime state (mode, version)
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
│   ├── runtime/                # Runtime DB/log artifacts
│   │   └── team-memory.sqlite  # Team Memory SQLite database (WAL)
│   │
│   └── scripts/                # Hook scripts for agent automation
│       ├── arch-hooks.js       # Architect lifecycle hooks (Claude Code)
│       └── ana-hooks.js        # Analyst lifecycle hooks (Gemini CLI)
│
├── docs/
│   └── team-memory-spec.md     # Team Memory Runtime spec
```

### Obsolete Code (Ignore/Cleanup)

- **docs/archive/python-v1/** - Dead Python architecture
- **ui/modules/tabs.js** - Refactored to sub-modules (only ~126 lines, coordinator stub)
- **Large log files** - workspace/console.log, ui/daemon.log (Safe to delete)
- **Deleted S112:** agent-skills.js, analysis/code-review.js, analysis/cost-optimizer.js, ipc/scaffolding-handlers.js, security/security-manager.js (~2,700 lines of confirmed dead code removed)

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

8. **`ui/modules/team-memory/runtime.js`**
   Team Memory runtime bootstrap, worker/client wiring, startup/shutdown lifecycle.

9. **`ui/modules/team-memory/claims.js`**
   Claim graph operations: create/query/update/deprecate, evidence links, consensus, contradictions.

10. **`ui/scripts/hm-claim.js`**
    CLI entry point for Team Memory claim operations.

---

## Architecture Notes

### Hybrid Consensus (Session 73)

- **Hivemind:** Outer-loop coordinator, cross-model orchestration, global context.
- **Native Teams:** Opt-in per-pane enhancement for Claude/Codex (Opus 4.6).
- **Oracle:** Gemini-powered shared vision and visual QA service.
- **PTY:** Remains the primary, stable fallback for all users.

### Event Kernel (Phases 1-4 Complete)

- **Lane A (Interaction Kernel):** Contracts, state vector, injection/terminal/renderer events.
- **Lane B (Telemetry):** Ring buffer with query API, health strip.
- **Daemon Bridge:** `ui/modules/main/kernel-bridge.js` — event propagation between main process and daemon.
- **Transition Ledger:** `ui/modules/transition-ledger.js` — state transition tracking with evidence spec signals (21 tests). Spec: `docs/transition-ledger-spec.md`.
- **Compaction Gate:** Lexical evidence required for confirmed state, chunk-inactivity decay (5s quiet), MAX_COMPACTION_DEFER_MS=8s safety valve. Runtime validated S108: 122-727ms injection latency.
- **Bridge Tab:** `ui/modules/tabs/bridge.js` — user-facing dashboard with agent status, system metrics, live event stream.

### Evidence Ledger (Slice 1 COMPLETE, Slice 2 in progress)

- **Purpose:** Unified causal event log replacing prose handoffs with queryable evidence system.
- **Three views:** Pipeline trace graph (DevOps), investigation timeline (Analyst), session memory (Architect).
- **Storage:** SQLite WAL mode, single writer in daemon/main. Tables: events, edges, spans + Slice 2: incidents, assertions, verdicts, evidence bindings.
- **Spec:** `workspace/build/evidence-ledger-slice1-spec.md` (infra), `evidence-ledger-query-spec.md` (query), `evidence-ledger-slice2-spec.md` (analyst workspace).
- **Phasing:** Slice 1 (pipeline ledger) DONE → Slice 2 (analyst workspace) IN PROGRESS → Slice 3 (cross-session decision memory).

### Team Memory Runtime (Phases 0-3 complete, Phase 4 in progress)

- **Layer:** Claim-graph memory runtime used by agents for shared team knowledge and retrieval.
- **Code:** `ui/modules/team-memory/` (`store.js`, `worker.js`, `worker-client.js`, `claims.js`, `migrations.js`, `runtime.js`).
- **Entrypoints:** IPC handlers in `ui/modules/ipc/team-memory-handlers.js`; runtime integration in `ui/modules/main/hivemind-app.js`; CLI in `ui/scripts/hm-claim.js`.
- **Spec:** `docs/team-memory-spec.md`.
- **Storage:** `workspace/runtime/team-memory.sqlite` (SQLite WAL).
- **Current tables:** `claims`, `claim_scopes`, `claim_evidence`, `claim_status_history`, `decisions`, `decision_alternatives`, `consensus`, `belief_snapshots`, `belief_contradictions`, `patterns`, `guards`.

### Comms Reliability (v3, S111)

- **ACK-timeout-resend** with server-side dedup.
- **Trigger file fallback** when WebSocket goes stale (~60s idle).
- **Chunked PTY writes** with ack barrier before Enter dispatch (86c4ccd).
- **Active-typing deferral** — injection defers only on active typing, not focus alone (b7a7d73).
- **2-phase submit verification** — Enter dispatch → acceptance verification with retry+backoff (0c1a452).

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
| PTY | node-pty | 1.1.0 |
| CLIs | Native (Claude/Codex) | - |
| Daemon | Node.js | 18+ |
| File Watching | chokidar | 3.6 |
| Testing | Jest | 30 (108 suites, 3300 tests) |
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
