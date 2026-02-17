# Hivemind

Hivemind is a working multi-agent engineering system where one person directs 3 persistent AI agents, plus 2 internal teammates, that coordinate, recover from failures, and build shared institutional memory over time.

This is not a chatbot wrapper. It is a live orchestration runtime for team intelligence.

## Why This Matters

Most AI tools still treat memory as chat history. Hivemind treats memory as a team system:

- Layer 1 (floor): durable cross-channel transcript via Comms Journal (`comms_journal`)
- Layer 2: tagged claim extraction into Team Memory (`DECISION:`, `TASK:`, `FINDING:`, `BLOCKER:`)
- Layer 3: deterministic session handoff + startup brief for fast continuity
- Executable evidence via isolated experiments

It is a working proof that one person can run a real AI engineering team with production-level coordination.

## What Is Running Today

### Core Runtime
- **PTY-only architecture** - one runtime path, no mode split
- **3 persistent panes** - Architect (Director), Builder, Oracle
- **2 internal teammates** - Frontend + Reviewer under Architect
- **WebSocket-first comms** - ACK/timeout/retry + fallback triggers

### Reliability + Recovery
- **Self-healing loop** - dead/stuck/stale detection, auto-restart, auto-nudge
- **Submit verification pipeline** - injection checks, retry backoff, guardrails
- **Daemon isolation** - terminal lifecycle survives app restarts

### Intelligence Layers
- **Event Kernel (Phases 1-4 complete)** - interaction contracts, telemetry, bridge
- **Evidence Ledger (runtime active)** - causal event history + Comms Journal (`comms_journal`) in SQLite WAL
- **Auto-Handoff Materializer (runtime active)** - deterministic `.hivemind/handoffs/session.md` from journal rows (mirrored to `workspace/handoffs/session.md`)
- **Team Memory Runtime (fully shipped)** - Claim Graph -> Search -> Consensus -> Pattern Engine -> Control Plane
- **Layer 2 Tagged Extraction (runtime active)** - async claim extraction from journal tags into Team Memory
- **Experiment Engine (Phase 6 shipped)** - isolated PTY execution that attaches tamper-evident results back to claims

### Notification Channels
- **Telegram bot (two-way)** - inbound polling + auto-reply routing via `hm-send user/telegram`
- **SMS poller** - inbound SMS relay to Architect pane
- **Image generation** - Recraft V3 (primary) + OpenAI gpt-image-1 (fallback), accessible via CLI and Oracle tab

### Developer Experience
- **Quality gates** - ESLint, Jest, pre-commit gates, review gate
- **Current test count** - see latest CI/Jest output (changes frequently)
- **Session continuity** - communication journal + context snapshots + startup briefing

## Agent Roles

| Pane | Role | Bundle | Sub-roles |
|------|------|--------|-----------|
| 1 | Architect (+ Frontend + Reviewer teammates) | Director | Architect, Data Engineer, Reviewer, Release Manager, UX Researcher, Memory Steward |
| 2 | Builder | Builder | Frontend, Backend, DevOps, SRE, Tester, Validator, Security, Context Optimizer |
| 5 | Oracle | Oracle | Investigator, Docs, Eval/Benchmark |

Model/CLI assignment is runtime-configurable via `ui/settings.json` (`paneCommands`).

## How Messaging Works

Agents communicate through WebSocket messaging (primary) with trigger-file fallback.

**WebSocket (preferred):**
```bash
# Send to an agent
node ui/scripts/hm-send.js <target> "(ROLE #N): message"

# Send to user via Telegram (explicit)
node ui/scripts/hm-send.js telegram "message"

# Send to user (auto-routes to Telegram if recent inbound, 5min window)
node ui/scripts/hm-send.js user "message"
```

**Telegram (standalone):**
```bash
node ui/scripts/hm-telegram.js "message"
```

**Trigger files (fallback):**

| File | Target |
|------|--------|
| `.hivemind/triggers/architect.txt` | Architect (pane 1) |
| `.hivemind/triggers/builder.txt` | Builder (pane 2) |
| `.hivemind/triggers/oracle.txt` | Oracle (pane 5) |
| `.hivemind/triggers/workers.txt` | Builder |
| `.hivemind/triggers/all.txt` | Everyone |

## Tech Stack

- **Electron 28**
- **Node.js 18+**
- **xterm.js 6.0**
- **node-pty 1.1.0**
- **SQLite (WAL mode)** for evidence + team memory runtimes
- **WebSocket (`ws`)** for low-latency agent messaging
- **Telegram Bot API** for two-way mobile notifications
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

Telegram integration requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`.
Image generation requires `RECRAFT_API_TOKEN` and/or `OPENAI_API_KEY` in `.env`.

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
│   │   ├── telegram-poller.js
│   │   ├── sms-poller.js
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
│   │   ├── evidence-ledger/        # spread across main/ and ipc/
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
│   │   ├── hm-telegram.js
│   │   ├── hm-sms.js
│   │   ├── hm-claim.js
│   │   ├── hm-memory.js
│   │   ├── hm-search.js
│   │   ├── hm-investigate.js
│   │   ├── hm-experiment.js
│   │   ├── hm-promotion.js
│   │   ├── hm-transition.js
│   │   ├── hm-github.js
│   │   ├── hm-pane.js
│   │   ├── hm-screenshot.js
│   │   └── hm-image-gen.js
│   └── __tests__/
├── .hivemind/
│   ├── app-status.json
│   ├── handoffs/
│   │   └── session.md
│   ├── triggers/
│   ├── build/
│   ├── context-snapshots/
│   ├── runtime/
│   │   ├── evidence-ledger.db
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
8. `ui/modules/main/auto-handoff-materializer.js` - deterministic session handoff generation
9. `ui/modules/team-memory/runtime.js` - Team Memory runtime lifecycle
10. `ui/modules/experiment/runtime.js` - Experiment execution runtime
11. `docs/team-memory-spec.md` - Claim graph + experiment architecture (with runtime addendum)

## Platform

Windows-first (other platforms not yet fully validated).

## Security Notes

This is a development tool, not a hardened production web app.

- `contextIsolation: false` is intentionally used for direct terminal integration.
- AI CLIs run with permissive flags in trusted local environments.
- The local daemon pipe is accessible to local processes.

## License

MIT
