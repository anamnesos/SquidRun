# Workflows

- Release process: version bump in `ui/package.json`, `npx electron-builder` (`--win` from Windows, `--mac` from Mac), `gh release create`, bump `RELEASE_VERSION` in `squidrun-site/platform-download-button.tsx`, push to deploy.
- GitHub Releases are immutable in this repo once published. Do not create an empty release and then upload assets. Use one atomic command that creates the release with all files attached (for example: `gh release create vX.Y.Z <all-artifact-paths> --title "vX.Y.Z" --generate-notes`).
- Site deployment: `squidrun-site/` is Next.js on Vercel (project: `squidrun-site`, team: `anamnesos`), domains: `squidrun.com` + `www.squidrun.com`. Push to `master` triggers auto-deploy.
- Cross-device messaging: Architect-to-Architect only, by design. The bridge is NOT for reaching remote Builder/Oracle directly. Each Architect routes to its own local team via `hm-send`. Target format: `@<device>-architect` (e.g. `@macbook-architect`). Enforced by `bridge_architect_only` gate in `squidrun-app.js:1900`. Requires `SQUIDRUN_CROSS_DEVICE=1`, `SQUIDRUN_DEVICE_ID`, `SQUIDRUN_RELAY_URL`, `SQUIDRUN_RELAY_SECRET` in `.env`. Config resolution: `.squidrun/devices.json` takes priority over `.env` — stale secrets in `devices.json` will silently break relay auth.

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
