# Hivemind

Hivemind is a local-first Electron app for running a persistent multi-agent coding team on your own machine.

Instead of one chat that forgets context, Hivemind keeps three role-based agents alive in parallel:
- `Architect` (pane 1): coordination, decomposition, review
- `Builder` (pane 2): implementation, testing, infra work
- `Oracle` (pane 5): investigation, documentation, benchmarking

The goal is practical: make solo AI-assisted development feel like an actual engineering team with continuity.

## Key Features

- Persistent 3-pane runtime with role boundaries
- CLI-agnostic model routing per pane (`Codex`, `Claude Code`, `Gemini`, etc.)
- WebSocket-first agent messaging (`hm-send`) with fallback triggers
- Hidden pane hosts for more reliable background PTY execution and injection flows
- Durable communication history in SQLite via `comms_journal`
- Auto-materialized session handoff at `workspace/handoffs/session.md`
- Runtime context snapshots in `.hivemind/context-snapshots/`

## Architecture Overview

```text
                +--------------------------------------+
                |           Electron App               |
                |      (window + orchestration)        |
                +------------------+-------------------+
                                   |
                                   v
        +-----------------------------------------------------------+
        |  Visible 3-pane team runtime                              |
        |  Pane 1: Architect | Pane 2: Builder | Pane 5: Oracle     |
        +-----------------------------------------------------------+
                                   |
                                   v
                 Hidden pane hosts (non-visible mirror windows)
               for resilient background terminal/runtime operations
                                   |
                                   v
              WebSocket broker (`hm-send`) + trigger-file fallback
                                   |
                                   v
    Evidence Ledger SQLite (`.hivemind/runtime/evidence-ledger.db`)
                     -> `comms_journal` (team communication log)
                                   |
                                   v
         Handoff + continuity artifacts (`workspace/handoffs/session.md`,
                `.hivemind/context-snapshots/[pane].md`, etc.)
```

Core implementation lives in `ui/modules/`, `ui/modules/main/`, and `ui/scripts/`.

## Setup And Install

### Prerequisites

- Node.js 18+
- npm
- At least one coding CLI installed locally (for example `codex`, `claude`, or `gemini`)

### Install

```bash
git clone <repo-url>
cd hivemind/ui
npm install
```

### Start

From repo root on Windows:

```bat
start-hivemind.bat
```

Or cross-platform from `ui/`:

```bash
npm start
```

## Configuration

1. Copy `.env.example` to `.env` (optional but recommended).
2. Start the app once to generate/update runtime settings (including `ui/settings.json`).
3. In Settings, assign each pane command/model (`paneCommands`) to the CLI you want.

Optional integrations from `.env.example` include Telegram and other external tooling.

## Usage Basics

1. Launch Hivemind and wait for panes to initialize.
2. Confirm all three roles are online (`Architect`, `Builder`, `Oracle`).
3. Send agent-to-agent messages through `hm-send` (not terminal text):

```bash
node ui/scripts/hm-send.js <target> "(ROLE #N): message"
```

Examples:

```bash
node ui/scripts/hm-send.js architect "(BUILDER #1): Ready for review."
node ui/scripts/hm-send.js builder "(ARCHITECT #2): Implement with tests."
node ui/scripts/hm-send.js oracle "(ARCHITECT #3): Investigate root cause."
```

Useful commands:
- `npm run doctor` (from `ui/`) for runtime/environment checks
- `npm test` for Jest tests
- `npm run lint` for linting

## Project Layout

```text
hivemind/
├── ui/          # Electron app + runtime orchestration
├── docs/        # Specifications and operational docs
├── scripts/     # Project-level utility scripts
├── workspace/   # Compatibility mirrors and session artifacts
├── AGENTS.md    # Multi-agent operating instructions
└── ROLES.md     # Role definitions and startup baseline
```

## Current Status And Scope

Hivemind is actively used for real multi-agent coding sessions, but it is still early-stage.

It is designed for trusted local environments and developer workflows, not hardened multi-tenant production use.

## Contributing

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
