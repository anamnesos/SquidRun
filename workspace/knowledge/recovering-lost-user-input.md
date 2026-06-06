# Recovering Lost User Input

Use this when James reports that a long typed or pasted pane message reached the agent as only a fragment.

1. Search `.squidrun/runtime/user-input-shadow.jsonl` for entries near the suspected loss time.

   ```powershell
   Get-Content .squidrun\runtime\user-input-shadow.jsonl | Select-String "2026-04-26T09:"
   ```

2. Compare `byteLen` for the same pane/text at `source: "ipc-handler"` and `source: "pty-write"`. For long inputs that the IPC handler chunks, compare the `ipc-handler` row against the sum of the adjacent `pty-write` rows in the same burst.
   - If `ipc-handler` is larger than `pty-write`, bytes were dropped between Electron IPC and the terminal daemon.
   - If they match, the app handed the same bytes to the daemon.

3. If both sources match but the agent received less text, the drop is downstream of SquidRun's IPC/daemon path: PTY, shell, or the Claude/Codex/Gemini CLI input layer.

4. If entries are missing entirely, the renderer never made it to `pty-write` IPC. Investigate typing, paste, broadcast-input, or renderer dispatch handlers.

The shadow log intentionally stores the exact text locally and does not redact. It is local forensic evidence only; do not send it externally unless James explicitly asks.

## Lost Telegram inbound (wedged poller)

Use this when James says a **Telegram** message "didn't go through" or replies stopped coming.

Root mechanism (seen 2026-06-04 → 06): the inbound poller `ui/modules/main/telegram-poller-worker.js` can wedge — the process stays alive while `getUpdates` silently stops advancing. Process-existence checks (e.g. `isMainTelegramWorkerAlive()`) pass forever on a wedged-but-alive worker, so nothing detects it. Outbound still works (replies send fine), which masks the outage.

Diagnose:
1. Check freshness of `.squidrun/runtime/telegram-poller-state.json` — its `updatedAt` / cursor `updatedAt`. If it's far older than now while the app is up, inbound is wedged.
2. Confirm the worker: `Get-CimInstance Win32_Process -Filter "Name='electron.exe'"` filtered to `telegram-poller-worker\.js`. NOTE: greping the broad process list for the literal string "telegram-poller-worker" also matches your *own* shell command — filter to `electron.exe` to avoid false positives.

Recover:
1. Kill the wedged worker PID (the `electron.exe ...telegram-poller-worker.js`). The app does **not** reliably auto-respawn it.
2. With no main worker running, the standalone lane's 409 guard now passes: `node ui/scripts/hm-telegram-poller-lane.js start`. Verify with `... status` (`running:true`) and that `telegram-poller-state.json` mtime advances; backlogged messages (<24h, Telegram's getUpdates retention) redeliver as `[Telegram from …]`.
3. Only one consumer may long-poll `getUpdates` at a time (else Telegram 409). Don't run the app worker and the standalone lane simultaneously.

Auto-heal: a freshness-based detector + auto-recovery was dispatched into `hm-startup-health.js` (S405). If it exists, prefer fixing/extending it over manual recovery.

Gotcha: `node ui/scripts/hm-telegram.js status` is NOT a status subcommand — `hm-telegram.js` treats unrecognized args as message text and **sends them to James's chat**. Use `hm-telegram-poller-lane.js status` for poller state instead.
