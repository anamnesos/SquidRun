# SquidRun Troubleshooting

SquidRun is an alpha product orchestrating complex background processes. When things go wrong, here is how to diagnose and fix them.

## General Diagnostics

Run the built-in diagnostic tool from the project root:

```bash
node ui/scripts/hm-doctor.js
```

This will output your platform/Node versions, check `app-status.json`, redact your `.env` keys, print the latest `app.log` tail, test WS connectivity, show pane status, and count `evidence-ledger` rows.

If you are experiencing issues, start here and check the application logs located at `workspace/logs/app.log`.

## Common Issues

### 1) Agent Stuck / Unresponsive

- **Symptom:** An agent pane stops progressing, appears frozen, or does not respond to new instructions.
- **Likely Cause:** The CLI process is waiting on an interactive prompt, or PTY input/output flow got stalled.
- **Exact Fix:**
  1. In the stuck pane header, press "Interrupt (ESC)" once.
  2. If no change, press "Send Enter" once.
  3. Wait 5-10 seconds for output.
  4. If still stuck, restart that pane's agent.
  5. If still stuck after restart, restart SquidRun.

Quick diagnostic command:
```bash
node ui/scripts/hm-comms.js history --last 20
```
If this command shows recent messages but pane output is still frozen, treat it as a PTY/CLI interaction stall and restart the pane.

### 2) `hm-send: command not found`

- **Symptom:** Running `hm-send ...` fails with `command not found`.
- **Likely Cause:** `.squidrun/bin` launchers are not in your current PATH, or project bootstrap did not fully initialize command shims.
- **Exact Fix:**
  Try running from the project root directly:
  ```bash
  ./.squidrun/bin/hm-send --help
  ```
  If the above works, use full paths or add `.squidrun/bin` to your PATH. If even full-path launchers fail, re-open project selection in SquidRun so bootstrap can regenerate `.squidrun/bin`.

### 3) Node Version Mismatch

- **Symptom:** `hm-send` / `hm-comms` errors mention `node:sqlite`, unsupported runtime, or missing APIs.
- **Likely Cause:** System `node` is too old for CLI tooling.
- **Exact Fix:**
  Ensure you are using Node `22+`. 
  ```bash
  node -v
  which node
  ```
  If SquidRun app launches but CLI tools fail, this is expected under old system Node: the app uses bundled Node 18, while CLI tools use your system Node.

### 4) Bridge Not Connected (Cross-Device)

- **Symptom:** Cross-device target delivery fails, rapid "Connected to relay" and "Relay disconnected" messages in `app.log`, or device discovery returns empty.
- **Likely Cause:** Relay config missing/invalid, network topology (aggressive NATs), or duplicate connection attempts overriding each other.
- **Exact Fix:**
  1. Ensure you have updated to `v0.1.28` or later, which patches a known self-replacement flap.
  2. Run `node ui/scripts/hm-send.js --list-devices --role architect` to test local bridge discovery.
  3. Confirm both devices are online and running SquidRun.
  4. Retry message to architect target format only: `hm-send @<DEVICE>-architect "(ARCHITECT #N): test"`

### 5) Manual Enter Needed on Mac (Claude Pane)

- **Symptom:** On macOS, pane 1 (Claude) sometimes shows message text typed but not submitted until you manually press Enter.
- **Likely Cause:** Known macOS-specific PTY submit timing issue on Claude path.
- **Exact Fix:**
  Press Enter once in pane 1 to submit buffered text. If this repeats, use pane header "Send Enter" after large injected messages.

### 6) Telegram Bot Not Responding

- **Symptom:** You message your bot on Telegram, but the Architect doesn't reply.
- **Likely Cause:** Invalid token, incorrect chat ID, or the Architect process has crashed.
- **Fix:**
  Verify `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in your `.env` file. Check the Architect's terminal pane for fetch errors or connection refused logs.

### 7) Experimental Warning Cluttering Output

- **Symptom:** `(node:XXXXX) ExperimentalWarning: SQLite is an experimental feature...`
- **Cause:** Node.js 22/24 marks the built-in `node:sqlite` driver as experimental. SquidRun uses this for the zero-dependency Evidence Ledger.
- **Fix:** This is purely cosmetic and completely harmless. No action required.

## When to Collect Diagnostics

Collect diagnostics before reporting an issue if any problem persists after the fixes above.

Suggested quick capture:
```bash
node ui/scripts/hm-doctor.js
node ui/scripts/hm-comms.js history --last 50
```
Include your OS, whether the issue is macOS/Windows-only, pane affected, and exact error text.