# Install SquidRun (Prerequisites)

This page explains what you need to install before using SquidRun, and why.

> **Note:** SquidRun is in Technical Preview (Alpha). We highly recommend running from source so you have full access to logs and diagnostic tools.

## Node Versions: The Dual-Node Reality

SquidRun uses two different Node runtimes:

1. Electron app runtime (bundled)
- SquidRun ships with its own embedded Node runtime (`v18.18.2`).
- The app-side runtime uses `better-sqlite3` internally.
- This works out of the box. You do not need to install Node for this part.

2. CLI tools runtime (system Node)
- `hm-send` and `hm-comms` run through your system `node` binary from `PATH`.
- These tools use `node:sqlite`.
- `node:sqlite` support for this workflow requires Node `22+` on your system.

## What You Need To Install

Regardless of your platform, you will need:
- **Node.js 22+** (Node 24 is known to show `node:sqlite` experimental warnings, which are harmless).
- **At least one official coding CLI** installed globally and authenticated in your terminal:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`)

*Make sure you run your chosen CLI at least once in your standard terminal to sign in and accept any terms of service before launching SquidRun.*

## macOS Notes

Common Node install paths on macOS:

- Apple Silicon (Homebrew): `/opt/homebrew/bin/node`
- Intel (Homebrew): `/usr/local/bin/node`
- nvm-managed Node: `~/.nvm/versions/node/<version>/bin/node`

### Install options

1. Homebrew (recommended for most users)

```bash
brew install node@22
```

2. nvm (if you manage multiple Node versions)

```bash
nvm install 22
nvm use 22
```

3. Direct installer (nodejs.org)
- Install current Node 22+ LTS package.

### PATH caveat

If Node is installed but `hm-send` still fails, confirm the shell PATH resolves the expected binary:

```bash
which node
node -v
```

On macOS, GUI-launched apps can inherit a different environment than your interactive shell. If needed, ensure a stable Node 22+ binary is available in a standard path (`/opt/homebrew/bin` or `/usr/local/bin`).

**Gatekeeper & Packaged Apps:**
If you build and use the packaged Electron app (`npx electron-builder --mac`), macOS will flag it as an unsigned application. You will need to Right-click -> Open to bypass Gatekeeper. The app also uses App Translocation, so it looks for `.env` at the fallback location `~/SquidRun/.env`.

## Windows Notes

Install Node 22+ from nodejs.org or your package manager, then verify:

```powershell
node -v
where.exe node
```

**Windows Build Libs:** If you attempt to package the app on Windows using `electron-builder` and encounter missing Spectre-mitigated libraries, use the flag `--config.npmRebuild=false`.

## Minimum Preflight

Before first serious run, verify:

1. `node -v` is `22+`
2. `hm-send --help` prints usage
3. `hm-comms --help` prints usage

If all three pass, Node prerequisites are correctly configured.