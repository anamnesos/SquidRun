# Workflows

## Release Process
- Version bump in `ui/package.json`
- Build with `npx electron-builder` (`--win` from Windows, `--mac` from Mac). Note: Windows may require `--config.npmRebuild=false` if Spectre-mitigated libs are missing.
- Create GitHub release: `gh release create vX.Y.Z ui/dist/SquidRun-Setup-X.Y.Z.exe`
- Update site: bump `RELEASE_VERSION` in `squidrun-site/platform-download-button.tsx`, push to `master`, wait for Vercel deploy.

## Troubleshooting
- **hm-send Fallback (PowerShell):** When `hm-send` is not available on `PATH` in a Windows PowerShell session, use `node ui/scripts/hm-send.js <target> "(ROLE #N): message"`. Example: `node ui/scripts/hm-send.js architect "(BUILDER #1): Builder online. Standing by."`.
- **Capability check before denial:** Before saying SquidRun cannot do something, run a live capability lookup first. Default tool: `node ui/scripts/hm-capabilities.js search <term>` or `node ui/scripts/hm-capabilities.js verify "<claim>"`. Negative capability claims without a lookup are treated as a process failure, not a memory mistake.
- **Bridge `bridge_unavailable` triage:** test app bridge path first (`node ui/scripts/hm-send.js --list-devices --role architect`). If runtime discovery fails but direct relay connect works, inspect `workspace/logs/app.log` for rapid `Connected to relay`/`Relay disconnected` churn. Restart the Electron app after any main-process bridge code change.
- **Bridge flap fix pattern:** in `bridge-client.connect()`, treat `WebSocket.CLOSING` as an in-flight socket. Clear `this.socket` before creating a replacement socket. Ignore stale socket events (`open/message/error/close`) when `this.socket !== ws`.
- **Bridge health triage:** use the Bridge tab first. It now hydrates from `bridge:get-status` and shows relay lifecycle state, device ID, relay URL, last connected/disconnected timestamps, disconnect reason/code, flap count, reconnect schedule, and last remote dispatch details before you dive into logs.
- **Inject Path Invariant (truncation root cause, post-S298):** broker payload bytes are DATA, never terminal-control input. NO inject path may prepend ESC sequences (`\x1b[H` cursor-home, `\x1b[J` clear, etc.) to text destined for a Claude/Codex/Gemini pane. The recurring head-truncation regression cycle (commits c4bb18c, b9da1ae, e8dfc19, 88e6987, 6ea6c58, d0f2183, 702a0e9 — 8 cycles) was caused by the `homeResetBeforeWrite` flag living conditionally in `pane-host-renderer.js`, `injection-capabilities.js`, and `injection.js`. Each fix disabled it for one caller; refactors silently re-enabled it for sibling paths. The flag has been removed entirely. Do not reintroduce it. Tests in `ui/__tests__/pane-host-renderer.test.js` and `ui/__tests__/injection.test.js` now ASSERT no Home prefix anywhere — flipping them from "asserts present" to "asserts absent" is the structural guard against the next refactor.
- **PTY chunk SIZE on Windows must equal chunk THRESHOLD:** commit 88e6987 lowered the threshold to 256B because ConPTY/Claude-CLI's input handler drops chars on writes >256B, but it left chunk SIZE at 4096. Net: zero protection for messages 256–4096 bytes. `DEFAULT_CHUNK_SIZE_BYTES` is now `isDarwin ? 4096 : 256` in `ui/pane-host-renderer.js`, and `DEFAULT_HM_SEND_CHUNK_YIELD_EVERY_CHUNKS` is `isDarwin ? 0 : 1` so ConPTY's pipe buffer drains between chunks.
- **`delivered.verified` does NOT mean the model saw it:** the existing ack confirms delivery to the pane, not that HEAD and TAIL bytes reached the model's prompt transcript. When investigating "ack says delivered but agent didn't see X", the right diagnostic is to have the recipient agent quote the head of the inbound message, NOT to trust the ack.
- **Renderer black screen under multi-agent PTY load:** if the UI dies when several panes stream output at once, inspect `ui/modules/main/squidrun-app.js` first. The fix pattern is to batch `pty-data-*` IPC in the main process per pane on a short timer (about 16ms) and flush buffered output before pane exit or app shutdown instead of calling `webContents.send` for every PTY chunk.
- **Architect comms rule (`hm-send --file`):** Builder must use `node ui/scripts/hm-send.js <target> --file <path>` for every Architect-bound message, not just long ones. We hit repeated truncation and pane-render confusion in Session 234 when inline sends mixed with large payloads. Treat `--file` as the permanent default for agent-to-agent messaging.
- **Codex CLI shell arg truncation (Session 230):** Codex CLI can truncate long inline shell command args. The SquidRun pipeline (hm-send -> WebSocket -> evidence ledger -> injection -> PTY) is verified intact — messages land fully in the DB. The remaining failure mode is upstream payload truncation before `hm-send` runs, which is another reason to default to `--file`.
- **Packaged rebuild safety:** Do not package from a clean worktree that reuses the live `ui/node_modules` via junction/symlink. Electron Builder's dependency scan can leave the shared install in a broken state. Build from the real workspace install or use a fully separate dependency tree.
- **Supervisor/trading script path rule:** Runtime helpers that launch `ui/scripts/*` from packaged smoke builds must resolve those scripts from `path.join(getProjectRoot(), 'ui', 'scripts', ...)`, not from module `__dirname`. Using `__dirname` inside packaged `ui/modules/*` or `ui/supervisor-daemon.js` can incorrectly target `.../resources/app.asar/scripts/...` and break `hm-send.js` during end-of-day summaries or supervisor notifications.
- **Diagnostics bundle command:** run `node ui/scripts/hm-doctor.js` for a bug-report snapshot.
- **Runtime truth inspector:** use `node ui/scripts/hm-doctor.js` before manually reading individual state/config files; it is the primary one-command runtime truth check.
- **Telegram inbound photo triage:** If Telegram text works but photo messages do not surface, check the main-process logs for `Rejected inbound Telegram message from unauthorized chat`. The poller now accepts both `TELEGRAM_AUTHORIZED_CHAT_IDS` and `TELEGRAM_CHAT_ALLOWLIST`, and it also handles `message`, `edited_message`, `channel_post`, and `edited_channel_post` payload shapes. Downloaded inbound images are saved to `D:\projects\Korean Fraud\telegram-photos\` by default (override with `TELEGRAM_INBOUND_MEDIA_DIR`), mirrored to `.squidrun/screenshots/latest.png`, and injected into pane 1 with the saved file path inline. Restart the Electron app after changing `ui/modules/telegram-poller.js` or `ui/modules/main/squidrun-app.js`.
- **Eunbyeol window launch + routing:** On Windows, run `ui/scripts/create-eunbyeol-shortcut.ps1` once and then launch `Eunbyeol.lnk`, or start the app with `npm start -- --window=eunbyeol --solo-window` from `ui/`. The dedicated Eunbyeol window now carries its own startup bundle (case dashboard, handoff corrections, confirmed facts, recent Eunbyeol Telegram history, cognitive-memory recall), routes Telegram `chat_id 8754356993` into the Eunbyeol lane, and closing that window must not shut down the main SquidRun window.
- **Live-verification gate for restart-sensitive ships:** Green focused tests are not enough for startup/window-lifecycle claims. Any feature that changes cold boot, standalone launch, startup injection, or window-scoped shutdown must be labeled `NOT VERIFIED` until someone exercises the real running app path.
- **Tokenomist refresh + freshness policy:** Refresh the unlock snapshot with `node ui/scripts/hm-tokenomist-refresh.js --json`. The script uses Playwright against the Tokenomist unlock page, dismisses the builder modal, and rewrites `tokenomist-current.yml` in the same ARIA/YAML shape the parser expects. Freshness policy is `6h` warn / `12h` hard block. `spark-capture` suppresses unlock catalysts when the source is stale, and the supervisor-driven `hm-tokenomist-unlocks.js` CLI now refreshes before its scheduled 6-hour scans.

## Startup & Operations
- **Startup Health Pipeline:** On session startup, the system automatically runs `ui/scripts/hm-health-snapshot.js` and outputs codebase state to `.squidrun/build/startup-health.md`. This pipeline measures test coverage, module inventory, and daemon status, ingesting the factual state directly into `cognitive-memory.db` under the `system_health_state` and `codebase_inventory` categories to ground agent decision-making.
- **CI Monitoring:** Oracle checks CI status on startup using `ui/scripts/hm-ci-check.js`. Builder owns keeping CI green.
- **Deep research workflow (AI/dev-tools):** run 2-3 web passes with primary sources only, extract explicit reliability semantics and economics primitives. Send Architect a synthesis that separates hard facts from inference.
- **Codex self-audit workflow:** verify local install first with `codex --version` and `codex mcp list`. Validate actual machine reach with PowerShell probes.
- **Unified trading risk:** `ui/modules/trading/orchestrator.js` uses `portfolio-tracker.getPortfolioSnapshot()` for kill-switch/daily-pause checks so total equity spans IBKR, DeFi, and other tracked markets. Smart-money convergence inputs should be passed via `smartMoneySignals` or `smartMoneyScanner`, which auto-promote symbols into the dynamic watchlist with source `smart_money`.
- **Crypto consultation macro gate (S241):** Treat macro regime as a hard override on technical setups. If the live macro gate is `RED`, do not surface new long ideas even when intraday momentum looks clean; the runtime applies a `buyConfidenceMultiplier` and blocks BUY executions when the adjusted signal falls below threshold. Builder consultation replies should account for this before recommending new longs.
- **Cognitive Memory Operations:**
  - **API Integration:** Memory operations (ingest, retrieve, patch, salience) are fully integrated via IPC (`cognitive-memory-handlers.js`) and websocket routing for runtime access.
  - **Ingest:** Agents can manually push new knowledge to the vector store using `node ui/scripts/hm-memory-api.js ingest "<fact>" --category <category> --agent <agent-id> [--confidence <0..1>]`.
  - **Retrieve:** Query memory via `node ui/scripts/hm-memory-api.js retrieve "<query>" --agent <agent-id> --limit N`. Retrieval automatically applies time-decay scoring, tracks reactivation thresholds, and consults `transactive_meta` for agent expertise recommendations.
  - **Promote:** Auto-promote pending PRs via `node ui/scripts/hm-memory-promote.js approve --all` so staged facts flow into `workspace/knowledge/`.
  - **Immunity Layer:** Proven heuristics are automatically immune-protected via behavioral extraction to bypass recency penalties. To manually protect a node, use `node ui/scripts/hm-memory-api.js set-immune --id <node-id> [--value <0|1>]`.
  - **Lifecycle & Supervisor:** The Durable Supervisor (`ui/supervisor-daemon.js`) automatically handles background maintenance, including the Sleep Consolidator, memory lease janitor, and index synchronization.
- **JSDoc typecheck workflow:** Run `npm run typecheck` from `ui/` to execute the scoped `tsc -p jsconfig.json --noEmit` gate. The first slice intentionally targets the most bug-prone contract modules (message envelope + IPC surfaces) instead of the whole JS codebase; expand the `ui/jsconfig.json` include list only when a module is clean enough to be a reliable gate.
## Task Delegation Template (Architect -> Builder)
Structured envelopes for Builder delegation:
```
OBJECTIVE: <one-line goal>
SCOPE IN: <what to touch>
SCOPE OUT: <what NOT to touch>
REQUIRED EDITS: <file list>
VALIDATION: <commands to run>
ACCEPTANCE: <how to know it's done>
DELIVERABLE: <commit, PR, staged changes, etc.>
PRIORITY: <now / next / backlog>
```
Comms cadence: Builder sends initial ACK + plan, then delta updates only on state change. No noise.

## Builder Background Agent Slots
Builder manages up to 3 background agents (builder-bg-1..3). Track slot status:
- Slot, Owner, Objective, Status (running/blocked/done), Blocker reason, Handoff state

- **Spark Capture**: Verified spark-capture pipeline is running and pulling Upbit/Hyperliquid/Tokenomist events.
