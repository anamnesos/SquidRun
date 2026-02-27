# Workflows

- Release process: version bump in `ui/package.json`, `npx electron-builder` (`--win` from Windows, `--mac` from Mac), `gh release create`, bump `RELEASE_VERSION` in `squidrun-site/platform-download-button.tsx`, push to deploy.
- GitHub Releases are immutable in this repo once published. Do not create an empty release and then upload assets. Use one atomic command that creates the release with all files attached (for example: `gh release create vX.Y.Z <all-artifact-paths> --title "vX.Y.Z" --generate-notes`).
- Site deployment: `squidrun-site/` is Next.js on Vercel (project: `squidrun-site`, team: `anamnesos`), domains: `squidrun.com` + `www.squidrun.com`. Push to `master` triggers auto-deploy.
- Cross-device messaging: Architect-to-Architect only, by design. The bridge is NOT for reaching remote Builder/Oracle directly. Each Architect routes to its own local team via `hm-send`. Target format: `@<device>-architect` (e.g. `@macbook-architect`). Enforced by `bridge_architect_only` gate in `squidrun-app.js:1900`. Requires `SQUIDRUN_CROSS_DEVICE=1`, `SQUIDRUN_DEVICE_ID`, `SQUIDRUN_RELAY_URL`, `SQUIDRUN_RELAY_SECRET` in `.env`. Config resolution: `.squidrun/devices.json` takes priority over `.env` — stale secrets in `devices.json` will silently break relay auth.
- Bridge `bridge_unavailable` triage: test the app bridge path first (`node ui/scripts/hm-send.js --list-devices --role architect` and/or WS `bridge-discovery` request to `ws://127.0.0.1:9900`). If runtime discovery fails but direct relay connect works, inspect `workspace/logs/app.log` for rapid `Connected to relay`/`Relay disconnected` churn and close reasons. For send reliability, ensure bridge sends wait for `bridgeClient.isReady()` (not just `startBridgeClient()`), and restart the Electron app after any main-process bridge code change.
- Bridge self-replacement flap fix pattern: in `bridge-client.connect()` treat `WebSocket.CLOSING` as an in-flight socket (do not open a new socket), clear `this.socket` before creating a replacement socket, and ignore stale socket events (`open/message/error/close`) when `this.socket !== ws`. For stale `close`, do not mutate connection state or schedule reconnect; only the active socket may trigger reconnect.
- PTY long-message truncation hardening: for any write path that can carry agent messages, chunk payloads >=1KB instead of single `pty-write` bursts. In hidden pane hosts, force chunking for long `hm-send` traces and pace chunk submission before Enter dispatch. Validate with a live 2000+ char cross-agent send using explicit start/end markers.
- Diagnostics bundle command: run `node ui/scripts/hm-doctor.js` for a bug-report snapshot that includes platform + Node info, `.squidrun/app-status.json`, redacted `.env` keys, recent `workspace/logs/app.log` tail, local WebSocket health check, daemon pane status from the named pipe, and `comms_journal` row count from `.squidrun/runtime/evidence-ledger.db`.
- CI Monitoring: Oracle checks CI status on startup using `ui/scripts/hm-ci-check.js`. Builder owns keeping CI green. If CI is red, Oracle escalates to Architect who blocks new work until it's fixed.

## Task Delegation Template (Architect -> Builder)

Structured envelopes for Builder delegation. Both VIGIL and MacBook Builders confirmed this reduces back-and-forth and scope creep.

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
- Future: live slot ledger for visibility (JSON heartbeat + comms console surfacing — prototype ready when James prioritizes)
