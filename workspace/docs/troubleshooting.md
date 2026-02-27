# Troubleshooting

SquidRun is an alpha product orchestrating complex background processes. When things go wrong, here is how to diagnose and fix them.

## General Diagnostics

If you encounter issues, start by checking the application logs located at `workspace/logs/app.log`. This file contains the primary orchestration events and error stack traces.

You can also test the local broker by running the following command from your project root:

```bash
node ui/scripts/hm-send.js --list-devices --role architect
```

## Common Issues

### 1. Agents Are Unresponsive / Messages Not Delivering

**Symptom:** You send a message using `hm-send.js`, but the target agent never acknowledges it, or the terminal panes appear frozen.
**Cause:** The target pane might be stuck waiting for interactive input, or the local websocket broker has dropped the connection.
**Fix:** 
1. Check the panes to see if a CLI prompt is waiting for a `[y/N]` confirmation. 
2. Restart the app. SquidRun's auto-handoff system will read the `.squidrun/handoffs/session.md` file and pick up right where it left off.

### 2. Cross-Device Bridge Flapping or Unavailable

**Symptom:** `workspace/logs/app.log` shows rapid "Connected to relay" and "Relay disconnected" messages, or logs say `status=replaced_by_new_connection`.
**Cause:** Network topology (aggressive NATs) or duplicate connection attempts overriding each other.
**Fix:** 
1. Ensure you have updated to `v0.1.28` or later, which patches a known self-replacement flap.
2. Run `node ui/scripts/hm-send.js --list-devices --role architect` to test local bridge discovery.
3. If cross-device mode is not critical for your current session, disable it in Settings to stabilize the local loop.

### 3. Telegram Bot Not Responding

**Symptom:** You message your bot on Telegram, but the Architect doesn't reply.
**Cause:** Invalid token, incorrect chat ID, or the Architect process has crashed.
**Fix:** 
1. Verify `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in your `.env` file.
2. Check the Architect's terminal pane for fetch errors or connection refused logs.

### 4. Experimental Warning Cluttering Output

**Symptom:** `(node:XXXXX) ExperimentalWarning: SQLite is an experimental feature...`
**Cause:** Node.js 22/24 marks the built-in `node:sqlite` driver as experimental. SquidRun uses this for the zero-dependency Evidence Ledger.
**Fix:** This is purely cosmetic and completely harmless. No action required.

## Where to find logs

- Application logs: `workspace/logs/app.log`
- Coordination state: `.squidrun/runtime/`
- Evidence Ledger: `.squidrun/runtime/evidence-ledger.db`
