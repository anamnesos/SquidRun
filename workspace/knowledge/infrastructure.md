# Infrastructure

- Vercel: team `anamnesos`, project `squidrun-site`.
- GitHub: `anamnesos/SquidRun`.
- Relay: hosted on Railway (`wss://relay-production-2c27.up.railway.app`).
- Telegram bot: configured via `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `.env`.

## How restarts ACTUALLY happen (READ THIS BEFORE STAGING ANY RESTART)

The Architect **cannot** restart the SquidRun app from its own pane, and staging
`.squidrun/coord/restart-request.json` (via `hm-restart-request.js`) is **NOT enough** on its own —
that is the wrong box. James has had to explain this repeatedly; do not make him say it again.

**The real model (from James, S396):**
- **Codex Desktop is a separate desktop app** (ChatGPT/Codex with **computer-use**), running alongside SquidRun.
- It is the actor that physically restarts the SquidRun Electron app.
- It runs an **automation that polls its OWN inbox every ~5 minutes**.
- **Empty inbox = no restart.** If nothing is in the Codex inbox, Codex Desktop does nothing, no matter how clean your `coord/` restart-request is.

**The Codex inbox = the codex-attention-bridge**, managed by `ui/scripts/hm-codex-attention.js`:
- View it: `node ui/scripts/hm-codex-attention.js` → check `active_count` / `active_request_ids`.
- Put a restart request IN it:
  ```
  node ui/scripts/hm-codex-attention.js create --requested-by architect \
    --target-window squidrun-main --work-item-id <id> \
    --reason "<why restart + HEAD + gate status>" \
    --check "Restart main SquidRun Electron (main profile, not side profile)" \
    --check "Confirm fresh app-status.json session > <current> with new timestamp" \
    --check "Confirm loaded HEAD is <commit> on <branch>" \
    --check "Return PASS only if relaunched at that HEAD; BLOCKED if cannot launch/inspect"
  ```
- After creating, verify `active_count` went to ≥1 so you KNOW it is queued (don't assume).

**Restart proof = continuity test.** If you still remember the prior session's conversation, the restart did
NOT happen — a real restart spawns a fresh Architect with no memory of it. Don't dig through logs to answer
"did it restart"; you'd be a new Architect if it had.

**Why `coord/restart-request.json` still matters:** it is the staged record (HEAD, clean-tree, reason) that
the executor/Codex reads as the source of truth for *what* to load. Keep it fresh (clean tree, real HEAD) AND
put the trigger in the Codex inbox. Both. The transport that would let the app push a visible message directly
into Codex Desktop is unsupported (`hm-codex-desktop-transport.js` reports `can_inject_visible_message:false`,
`can_summon_workspace:true`), which is why the inbox-poll is the path.
