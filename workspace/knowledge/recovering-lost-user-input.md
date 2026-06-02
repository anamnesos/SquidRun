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
