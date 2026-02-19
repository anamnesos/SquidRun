# Hivemind

Hivemind is a local-first Electron app for running a persistent multi-agent coding team on your own machine.

Instead of one chat that forgets context, Hivemind keeps three role-based agents alive in parallel:
- `Architect` (pane 1): coordination, decomposition, review
- `Builder` (pane 2): implementation, testing, infra work
- `Oracle` (pane 5): investigation, documentation, benchmarking

The goal is practical: make solo AI-assisted development feel like an actual engineering team with continuity.

## Why Hivemind Is Different: Subscription-First, Not API-First

Most multi-agent coding tools require API keys and charge per token. That adds up fast — running three agents on API billing can cost hundreds of dollars a day for heavy use.

**Hivemind runs on your existing CLI subscriptions instead.** It orchestrates the official CLI tools you already have:

| CLI | Subscription | Included Limits |
|-----|-------------|-----------------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Claude Pro / Max plan | Generous daily usage included |
| [Codex CLI](https://github.com/openai/codex) | ChatGPT Pro / Plus plan | Generous daily usage included |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Gemini Pro / free tier | Generous daily usage included |

Each pane in Hivemind runs a real CLI process — the same tool you'd use in your terminal. No API keys needed for core agent work. Your subscription limits apply per-CLI, so running all three in parallel gives you the combined capacity of all your subscriptions.

**API keys are optional.** The settings panel has API key fields for supplementary features like image generation (Recraft, OpenAI DALL-E). These are not required for the core multi-agent workflow.

**No ToS concerns.** Hivemind simply launches and manages the official CLI tools on your local machine. You're using your own subscriptions through their intended interfaces — exactly the same as running them in separate terminal windows, just orchestrated.

## Key Features

- Persistent 3-pane runtime with role boundaries
- **Subscription-powered** — uses your existing CLI plans, not pay-per-token API calls
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
- At least one coding CLI installed and authenticated with your subscription:
  - `claude` — requires [Claude Pro or Max](https://claude.ai/upgrade) subscription
  - `codex` — requires [ChatGPT Plus or Pro](https://chatgpt.com/) subscription
  - `gemini` — works with [free tier](https://ai.google.dev/) or Google One AI Premium
- For the full 3-agent experience, install all three (each runs in its own pane)

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

1. Start the app once to generate/update runtime settings (including `ui/settings.json`).
2. In Settings, assign each pane's CLI command (`paneCommands`) to the tool you want — for example `claude`, `codex --full-auto`, or `gemini`.
3. (Optional) Copy `.env.example` to `.env` for supplementary features.

**What requires a subscription (free):** The core multi-agent workflow. Just have at least one CLI installed and logged in to your subscription.

**What requires API keys (optional):** Image generation (Recraft or OpenAI), Telegram bot integration, and other external tooling configured via `.env`.

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
