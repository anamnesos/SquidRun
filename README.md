# Hivemind

Hivemind is a local-first Electron app that runs **Claude, Codex, and Gemini simultaneously** as a coordinated coding team on your machine.

You can run it with a single model, but it's designed — and recommended — to run **different models from different companies** in each role:

- `Architect` (pane 1): coordination, task decomposition, code review
- `Builder` (pane 2): implementation, testing, infrastructure
- `Oracle` (pane 5): investigation, documentation, benchmarking

For example, Claude architects the solution, Codex builds it, and Gemini cross-checks it. Each model brings its own reasoning style and blind spots — when they collaborate, they catch things a single model misses. They communicate through a structured message protocol, not copy-paste.

## Why Hivemind Is Different

### Multi-Model, Not Just Multi-Agent

Other multi-agent tools run multiple instances of the same model. Hivemind can run **different models from different providers** as a single team — and that's the recommended setup. Each model has different strengths, and cross-model collaboration catches errors that any single model would miss. You assign any model to any role through a single settings panel, or run one model across all panes if you prefer.

### Subscription-First, Not API-First

Most multi-agent coding tools require API keys and charge per token. That adds up fast — running three agents on API billing can cost hundreds of dollars a day for heavy use.

**Hivemind runs on your existing CLI subscriptions instead.** It orchestrates the official CLI tools you already have:

| CLI | Subscription | What's Included |
|-----|-------------|-----------------|
| [Claude Code](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan) | Claude Pro ($20/mo) or Max ($100-200/mo) | CLI usage included in your plan — "access to both Claude on the web and Claude Code in your terminal with one unified subscription" |
| [Codex CLI](https://developers.openai.com/codex/pricing/) | ChatGPT Plus ($20/mo) or Pro ($200/mo) | CLI usage included — "anyone with a ChatGPT Plus, Pro, Business, Enterprise or Edu subscription can use Codex across the CLI" |
| [Gemini CLI](https://google-gemini.github.io/gemini-cli/docs/quota-and-pricing.html) | Free with Google account | 1,000 requests/day free — no subscription required |

Each pane in Hivemind runs a real CLI process — the same tool you'd use in your terminal. No API keys needed for core agent work. Your subscription limits apply per-CLI, so running all three in parallel gives you the combined capacity of all your subscriptions.

**API keys are optional — they're a backup.** The settings panel has API key fields that serve as a fallback if you hit your subscription limits, plus supplementary features like image generation (Recraft, OpenAI DALL-E). Your subscriptions cover the core workflow; API keys are there if you need overflow capacity or extra features.

**This is just running official CLIs on your machine.** Hivemind launches and manages the same CLI tools you'd run in separate terminal windows — it just orchestrates them. Each provider explicitly includes CLI usage in their subscription plans (see links above). There's no API key scraping, no token proxying, no terms of service gray area.

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

**What requires a subscription:** The core multi-model workflow. Just have at least one CLI installed and logged in to your subscription.

**What API keys are for (optional):** API keys act as overflow capacity if you hit your subscription limits, plus they enable supplementary features like image generation (Recraft or OpenAI) and Telegram bot integration. Configure them in `.env` — they're there when you need them, but not required to get started.

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
