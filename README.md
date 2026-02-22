# SquidRun

**SquidRun is not a code editor, IDE plugin, or cloud service.** It is a standalone, local-first Electron app that gives a **solo developer** a full AI coding team — running **Claude Code, Codex CLI, and Gemini CLI simultaneously** on your own machine, powered by your existing subscriptions.

One person. Three different AI models. Three specialized roles. All running in parallel, talking to each other, and working on your codebase at the same time:

- `Architect` (pane 1): coordination, task decomposition, code review
- `Builder` (pane 2): implementation, testing, infrastructure
- `Oracle` (Pane 3): investigation, documentation, benchmarking

For example, Claude Code architects the solution, Codex CLI builds it, and Gemini CLI cross-checks it. Each model brings its own reasoning style and blind spots — when they collaborate, they catch things a single model misses. They communicate through a structured message protocol, not copy-paste.

You can run it with a single model, but it's designed — and recommended — to run **different models from different companies** in each role.

## What SquidRun Is NOT

- **Not a code editor or IDE.** It doesn't replace VS Code, Cursor, or any editor. It runs alongside your editor.
- **Not a VS Code / JetBrains extension.** It's a standalone Electron app.
- **Not a cloud service.** Everything runs locally on your machine. No data leaves your computer (beyond what each CLI sends to its own provider).
- **Not a team collaboration tool for multiple humans.** The "team" is AI agents. SquidRun is designed for a **solo developer** managing multiple AI models.
- **Not built on Continue, Copilot, or any other AI coding tool.** It's built from scratch — the orchestration layer, message routing, session persistence, all of it.

## Why SquidRun Is Different

### Multi-Model, Not Just Multi-Agent

Other multi-agent tools run multiple instances of the same model. SquidRun runs **different CLI tools from different providers** as a single team — and that's the recommended setup. Each model has different strengths, and cross-model collaboration catches errors that any single model would miss. You assign any model to any role through a single settings panel, or run one model across all panes if you prefer.

### Subscription-First, Not API-First

Most multi-agent coding tools require API keys and charge per token. That adds up fast — running three agents on API billing can cost hundreds of dollars a day for heavy use.

**SquidRun runs on your existing CLI subscriptions instead.** It orchestrates the official CLI tools you already have:

| CLI | Subscription | What's Included |
|-----|-------------|-----------------|
| [Claude Code](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan) | Claude Pro ($20/mo) or Max ($100-200/mo) | CLI usage included in your plan — "access to both Claude on the web and Claude Code in your terminal with one unified subscription" |
| [Codex CLI](https://developers.openai.com/codex/pricing/) | ChatGPT Plus ($20/mo) or Pro ($200/mo) | CLI usage included — "anyone with a ChatGPT Plus, Pro, Business, Enterprise or Edu subscription can use Codex across the CLI" |
| [Gemini CLI](https://google-gemini.github.io/gemini-cli/docs/quota-and-pricing.html) | Free with Google account | 1,000 requests/day free — no subscription required |

Each pane in SquidRun runs a real CLI process — the same tool you'd use in your terminal. No API keys needed for core agent work. Your subscription limits apply per-CLI, so running all three in parallel gives you the combined capacity of all your subscriptions.

**API keys are optional — they're a backup.** The settings panel has API key fields that serve as a fallback if you hit your subscription limits, plus supplementary features like image generation (Recraft, OpenAI DALL-E). Your subscriptions cover the core workflow; API keys are there if you need overflow capacity or extra features.

**This is just running official CLIs on your machine.** SquidRun launches and manages the same CLI tools you'd run in separate terminal windows — it just orchestrates them. Each provider explicitly includes CLI usage in their subscription plans (see links above). There's no API key scraping, no token proxying, no terms of service gray area.

> Subscription details and pricing as of February 2026. Check each provider's links above for current terms.

### Talk To Your Team From Anywhere Via Telegram

SquidRun integrates with Telegram so you can communicate with your agent team from your phone. Walk away from your desk, and your Architect agent keeps working — you can check status, give new instructions, or review progress from the field. The Architect relays your messages to Builder and Oracle, and sends you updates, screenshots, and results right in the chat.

This turns SquidRun into an always-available development team you can manage from anywhere with a phone signal.

**Quick setup:**
1. Create a Telegram bot via [@BotFather](https://t.me/botfather) and copy your bot token
2. Add `TELEGRAM_BOT_TOKEN=<your-token>` and `TELEGRAM_CHAT_ID=<your-chat-id>` to your `.env` file
3. Start SquidRun — the Architect will automatically pick up messages from Telegram and reply in the same channel

**Note:** Telegram messages can trigger real actions on your local machine (file edits, commands, git operations). Only use your own bot token and chat ID.

## Key Features

- **Multi-model orchestration** — run Claude Code, Codex CLI, and Gemini CLI as one team, not three copies of the same model
- **Subscription-powered** — uses your existing CLI plans, not pay-per-token API calls
- **Telegram integration** — manage your agent team from your phone, anywhere
- Persistent 3-pane runtime with role boundaries
- Mix and match any model to any role through a single settings panel
- WebSocket-first agent messaging (`hm-send`) with fallback triggers
- Hidden pane hosts for reliable background PTY execution and injection
- Durable communication history in SQLite via `comms_journal`
- Auto-materialized session handoff for continuity across restarts
- Screenshot capture with remote delivery for monitoring agent progress

## Quickstart (5 Minutes)

```bash
# 1. Clone and install
git clone https://github.com/anamnesos/squidrun.git
cd squidrun/ui && npm install

# 2. Make sure your CLIs are authenticated (run whichever you have)
claude --version    # Sign in if prompted
codex --version     # Sign in if prompted
gemini --version    # Sign in with Google if prompted

# 3. Launch
npm start

# 4. In Settings, assign each pane's CLI (e.g. pane 1 = claude, pane 2 = codex, Pane 3 = gemini)
# 5. You're running a multi-model agent team
```

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
    |  Pane 1: Architect    Pane 2: Builder    Pane 3: Oracle   |
    |  (e.g. Claude Code)   (e.g. Codex CLI)   (e.g. Gemini CLI)|
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
    Auto-handoff (.squidrun/handoffs/session.md)
    Session continuity across restarts
```

Core implementation lives in `ui/modules/`, `ui/modules/main/`, and `ui/scripts/`.

## Detailed Setup

### macOS Installation (Packaged App)

If you downloaded the packaged application from the releases page:

1. **Download the right version:** Choose `arm64` for Apple Silicon (M-series) Macs, or `x64` for Intel Macs.
2. **Bypass Gatekeeper:** Because this is an open-source, unsigned application, macOS will block it by default. 
   - To open it, **Right-click (or Control-click)** the SquidRun app and select **Open**. You will see a warning, but you can now click **Open** to bypass it.
   - Alternatively, go to **System Settings > Privacy & Security**, scroll down, and click **Open Anyway** next to SquidRun.
3. **Host Requirements:** The packaged app orchestrates tools on your local machine. You must have the following installed on your system:
   - **Node.js 18+**
   - **At least one coding CLI** (Claude Code, Codex CLI, or Gemini CLI) installed globally and available in your `PATH`. Make sure you run it once in your terminal to authenticate before launching SquidRun.

### Run from Source

#### Prerequisites

- Node.js 18+
- npm
- At least one coding CLI installed and authenticated:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — requires [Claude Pro or Max](https://claude.ai/upgrade) subscription → run `claude` and sign in
  - [Codex CLI](https://github.com/openai/codex) — requires [ChatGPT Plus, Pro, Business, or Enterprise](https://chatgpt.com/) subscription → run `codex` and sign in
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) — free with any [Google account](https://ai.google.dev/) (1,000 requests/day) → run `gemini` and sign in with Google
- For the full multi-model experience, install all three (each runs in its own pane)

### Install

```bash
git clone https://github.com/anamnesos/squidrun.git
cd squidrun/ui
npm install
```

### Start

From repo root on Windows:

```bat
start-squidrun.bat
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

1. Launch SquidRun and wait for panes to initialize.
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
<repo-root>/
├── ui/          # Electron app + runtime orchestration
├── docs/        # Specifications and operational docs
├── scripts/     # Project-level utility scripts
├── workspace/   # Compatibility mirrors and session artifacts
├── AGENTS.md    # Multi-agent operating instructions
└── ROLES.md     # Role definitions and startup baseline
```

## Security Practices

- **Local-first, no cloud dependency.** Everything runs on your machine. SquidRun itself does not send data to any external service — each CLI handles its own authentication and communication with its provider directly.
- **No telemetry.** SquidRun does not phone home, collect analytics, or transmit usage data.
- **Credentials stay local.** API keys and bot tokens live in your `.env` file, which is `.gitignore`d by default. SquidRun never stores or transmits your credentials — the CLIs manage their own auth.
- **Git history audited.** Before open-sourcing, the full 702-commit history was audited for secrets — zero real credentials found. Runtime artifacts (session files, databases) are excluded from version control.
- **Pre-commit quality gates.** Standard commit workflows run automated checks including ESLint (targeted `npm run lint` scope plus hook linting), Jest tests (3,200+ tests), IPC handler validation, trigger path enforcement, and review sign-off verification.
- **Telegram security note.** If you enable Telegram integration, messages from your bot can trigger real local actions (file edits, git operations, shell commands). Use your own private bot token and chat ID — do not share them.

## Current Status And Scope

SquidRun is actively used for real multi-model coding sessions. The codebase has 3,200+ tests across 166 test suites (`npx jest --listTests --json`), with quality gates such as ESLint, Jest, IPC validation, and trigger path enforcement in standard commit workflows. It is still early-stage and evolving rapidly.

It is designed for trusted local environments and developer workflows, not hardened multi-tenant production use.

## Contributing

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
