# SquidRun Installation Guide

> **Note:** SquidRun is in Technical Preview (Alpha). We highly recommend running from source so you have full access to logs and diagnostic tools.

## Prerequisites

Regardless of your platform, you will need:
- **Node.js 18+** (Node 24 is known to show `node:sqlite` experimental warnings, which are harmless).
- **npm** (comes with Node).
- **At least one official coding CLI** installed globally and authenticated in your terminal:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`)

*Make sure you run your chosen CLI at least once in your standard terminal to sign in and accept any terms of service before launching SquidRun.*

## 1. Clone and Install (All Platforms)

Open your terminal and run:

```bash
git clone https://github.com/anamnesos/squidrun.git
cd squidrun/ui
npm install
```

## 2. First Launch

You can launch SquidRun directly from the repository.

**Windows:**
```bat
cd ..
start-squidrun.bat
```

**macOS / Linux:**
```bash
# from the ui/ directory
npm start
```

## Known Caveats

- **macOS Gatekeeper:** If you decide to build and use the packaged Electron app (`npx electron-builder --mac`), macOS will flag it as an unsigned application. You will need to Right-click -> Open to bypass Gatekeeper. The app also uses App Translocation, so it looks for `.env` at the fallback location `~/SquidRun/.env`.
- **Windows Build Libs:** If you attempt to package the app on Windows and encounter missing Spectre-mitigated libraries, use the flag `--config.npmRebuild=false` with electron-builder.
- **Node SQLite Warnings:** You may see `(node:XXXXX) ExperimentalWarning: SQLite is an experimental feature...` in your terminal. This is expected and does not impact functionality. SquidRun uses `node:sqlite` for its Evidence Ledger.
