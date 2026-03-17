# Workflows

## Release Process
- Version bump in `ui/package.json`
- Build with `npx electron-builder` (`--win` from Windows, `--mac` from Mac). Note: Windows may require `--config.npmRebuild=false` if Spectre-mitigated libs are missing.
- Create GitHub release: `gh release create vX.Y.Z ui/dist/SquidRun-Setup-X.Y.Z.exe`
- Update site: bump `RELEASE_VERSION` in `squidrun-site/platform-download-button.tsx`, push to `master`, wait for Vercel deploy.

## Troubleshooting
- **hm-send Fallback (PowerShell):** When `hm-send` is not available on `PATH` in a Windows PowerShell session, use `node ui/scripts/hm-send.js <target> "(ROLE #N): message"`. Example: `node ui/scripts/hm-send.js architect "(BUILDER #1): Builder online. Standing by."`.
- **Bridge `bridge_unavailable` triage:** test app bridge path first (`node ui/scripts/hm-send.js --list-devices --role architect`). If runtime discovery fails but direct relay connect works, inspect `workspace/logs/app.log` for rapid `Connected to relay`/`Relay disconnected` churn. Restart the Electron app after any main-process bridge code change.
- **Bridge flap fix pattern:** in `bridge-client.connect()`, treat `WebSocket.CLOSING` as an in-flight socket. Clear `this.socket` before creating a replacement socket. Ignore stale socket events (`open/message/error/close`) when `this.socket !== ws`.
- **Bridge health triage:** use the Bridge tab first. It now hydrates from `bridge:get-status` and shows relay lifecycle state, device ID, relay URL, last connected/disconnected timestamps, disconnect reason/code, flap count, reconnect schedule, and last remote dispatch details before you dive into logs.
- **PTY truncation hardening:** chunk payloads >=1KB for Claude and >=256B for hm-send fast-path on Windows. Pace chunk submission before Enter dispatch.
- **Renderer black screen under multi-agent PTY load:** if the UI dies when several panes stream output at once, inspect `ui/modules/main/squidrun-app.js` first. The fix pattern is to batch `pty-data-*` IPC in the main process per pane on a short timer (about 16ms) and flush buffered output before pane exit or app shutdown instead of calling `webContents.send` for every PTY chunk.
- **Architect comms rule (`hm-send --file`):** Builder must use `node ui/scripts/hm-send.js <target> --file <path>` for every Architect-bound message, not just long ones. We hit repeated truncation and pane-render confusion in Session 234 when inline sends mixed with large payloads. Treat `--file` as the permanent default for agent-to-agent messaging.
- **Codex CLI shell arg truncation (Session 230):** Codex CLI can truncate long inline shell command args. The SquidRun pipeline (hm-send -> WebSocket -> evidence ledger -> injection -> PTY) is verified intact — messages land fully in the DB. The remaining failure mode is upstream payload truncation before `hm-send` runs, which is another reason to default to `--file`.
- **Diagnostics bundle command:** run `node ui/scripts/hm-doctor.js` for a bug-report snapshot.

## Startup & Operations
- **Startup Health Pipeline:** On session startup, the system automatically runs `ui/scripts/hm-health-snapshot.js` and outputs codebase state to `.squidrun/build/startup-health.md`. This pipeline measures test coverage, module inventory, and daemon status, ingesting the factual state directly into `cognitive-memory.db` under the `system_health_state` and `codebase_inventory` categories to ground agent decision-making.
- **CI Monitoring:** Oracle checks CI status on startup using `ui/scripts/hm-ci-check.js`. Builder owns keeping CI green.
- **Deep research workflow (AI/dev-tools):** run 2-3 web passes with primary sources only, extract explicit reliability semantics and economics primitives. Send Architect a synthesis that separates hard facts from inference.
- **Codex self-audit workflow:** verify local install first with `codex --version` and `codex mcp list`. Validate actual machine reach with PowerShell probes.
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
