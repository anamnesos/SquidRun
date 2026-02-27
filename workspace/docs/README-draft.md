# SquidRun Technical Preview

**SquidRun is a persistent, multi-model, cross-device agent OS that runs locally as a desktop app.** 

It is designed for a **solo developer** who wants a full AI coding team working in parallel on their own machine, powered by existing AI CLI subscriptions (Claude Pro, ChatGPT Plus, Gemini).

> **Alpha Warning:** This is an early technical preview built for developers and tinkerers. It requires comfort with terminal environments, reading logs, and configuring `.env` variables. Expect sharp edges, network topology quirks, and minor setup friction.

## What is SquidRun?

It is **NOT** a code editor, IDE plugin, or cloud service. It runs alongside your editor.
It does **NOT** charge per-token. It orchestrates the official CLI tools you already pay for.

SquidRun provides a persistent 3-pane runtime where each pane runs a dedicated agent:
- **Architect (Pane 1):** Coordinates work, decomposes tasks, reviews code, and holds system memory.
- **Builder (Pane 2):** Implements code, runs tests, and manages infrastructure. Spawns background agents for parallel work.
- **Oracle (Pane 3):** Investigates root causes, maintains documentation, and runs benchmarks.

You can mix and match models from different companies across these roles (e.g., Claude for Architect, Codex for Builder, Gemini for Oracle). They collaborate via a structured message protocol, sharing context and cross-checking each other.

## 90-Second Mental Model

Imagine opening three terminal windows on your laptop. In window 1, you run Claude. In window 2, you run ChatGPT. In window 3, you run Gemini.

SquidRun automates those three terminal windows. It wraps them in an Electron shell, gives them a shared SQLite database to track their conversations across restarts (the Evidence Ledger), and provides them a websocket-based communication bus so they can assign tasks to one another. 

When you leave your desk, you can text the Architect via a Telegram bot, and it will keep managing the Builder and Oracle while you're away.

## Next Steps

1. Read the [Install Guide](install-guide.md) to get your environment ready.
2. Follow the [Quickstart](quickstart.md) for your first 10 minutes.
3. Check [Limitations](limitations.md) before using it on critical projects.
4. Stuck? See [Troubleshooting](troubleshooting.md).
