# Hivemind

Hivemind is a local-first Electron app that runs **Claude, Codex, and Gemini simultaneously** as a coordinated coding team on your machine.

This isn't three copies of the same model — it's three different AI models from three different companies (Anthropic, OpenAI, Google), each assigned a role, talking to each other, and working on your codebase in parallel:

- `Architect` (pane 1): coordination, task decomposition, code review — powered by whichever model you choose
- `Builder` (pane 2): implementation, testing, infrastructure — a different model with different strengths
- `Oracle` (pane 5): investigation, documentation, benchmarking — a third model cross-checking the others

Each model brings its own reasoning style, blind spots, and strengths. When they collaborate, they catch things a single model misses. The Architect delegates, the Builder implements, the Oracle verifies — and they communicate through a structured message protocol, not copy-paste.

## Why Hivemind Is Different

### Multi-Model, Not Just Multi-Agent

Other multi-agent tools run multiple instances of the same model. Hivemind runs **different models from different providers** as a single team. Claude might architect the solution, Codex builds it, and Gemini reviews it — each model contributing what it's best at. You assign any model to any role through a single settings panel.

### Subscription-First, Not API-First

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

### Talk To Your Team From Anywhere Via Telegram

Hivemind integrates with Telegram so you can communicate with your agent team from your phone. Walk away from your desk, and your Architect agent keeps working — you can check status, give new instructions, or review progress from the field. The Architect relays your messages to Builder and Oracle, and sends you updates, screenshots, and results right in the chat.

This turns Hivemind into an always-available development team you can manage from anywhere with a phone signal.

## Key Features

- **Multi-model orchestration** — run Claude, Codex, and Gemini as one team, not three copies of the same model
- **Subscription-powered** — uses your existing CLI plans, not pay-per-token API calls
- **Telegram integration** — manage your agent team from your phone, anywhere
- Persistent 3-pane runtime with role boundaries
- Mix and match any model to any role through a single settings panel
- WebSocket-first agent messaging (`hm-send`) with fallback triggers
- Hidden pane hosts for reliable background PTY execution and injection
- Durable communication history in SQLite via `comms_journal`
- Auto-materialized session handoff for continuity across restarts
- Screenshot capture with remote delivery for monitoring agent progress

## Architecture Overview

```text
    You (Telegram / local UI)
                |
                v
    +--------------------------------------+
    |           Electron App               |
    |      (window + orchestration)        |
    +------------------+-------------------+
                       |
                       v
    +-----------------------------------------------------------+
    |  3-pane multi-model runtime                               |
    |                                                           |
    |  Pane 1: Architect    Pane 2: Builder    Pane 5: Oracle   |
    |  (e.g. Claude)        (e.g. Codex)       (e.g. Gemini)   |
    +-----------------------------------------------------------+
                       |
                       v
    WebSocket broker (hm-send) + trigger-file fallback
                       |
          +------------+------------+
          |                         |
          v                         v
    comms_journal SQLite      Telegram / SMS
    (all messages logged)     (remote access)
          |
          v
    Auto-handoff (workspace/handoffs/session.md)
    Session continuity across restarts
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

Hivemind is actively used for real multi-model coding sessions — the entire app was built by its own agent team. It is still early-stage and evolving rapidly.

It is designed for trusted local environments and developer workflows, not hardened multi-tenant production use.

## Contributing

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
