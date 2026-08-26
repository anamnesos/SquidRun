# SquidRun architecture

SquidRun is a local Electron application that runs three AI command-line tools
as an addressed team. The desktop shell owns their terminals, routes messages,
persists coordination state, and makes recovery observable.

## System shape

```text
Human
  |
  +-- Electron renderer ---------------- Team Room (paired browser)
  |          |                                     |
  |          +--------------- IPC -----------------+
  |                              |
  |                      Electron main process
  |                       /        |        \
  |              message router  lifecycle  persistence
  |                       |        |        /
  |                 hidden pane hosts + PTY daemon
  |                      /          |          \
  +--------------- Architect     Builder      Oracle
                       CLI          CLI          CLI
```

The role belongs to the pane, not to a provider. Claude Code, Codex CLI, or
Gemini CLI can occupy any pane.

## Process boundaries

### Electron main process

[`ui/main.js`](ui/main.js) starts Electron, applies the single-instance policy,
and constructs [`SquidRunApp`](ui/modules/main/squidrun-app.js). The application
object owns top-level windows, startup state, message routing, and coordinated
shutdown.

Main-process services are split into small modules under `ui/modules/main/`.
The important boundaries include:

- `pane-host-window-manager.js`: one hidden BrowserWindow per agent pane.
- `websocket-startup-lifecycle.js`: local addressed-message transport startup.
- `team-room-runtime.js`: Team Room server, pairing, history, and delivery.
- `telegram-ingress-*`: optional bot ingress, admission, durable spool, and drain.
- `restart-launch-probe.js`: restart/relaunch acceptance without user guesswork.

### Renderer and preload

[`ui/index.html`](ui/index.html) and [`ui/renderer.js`](ui/renderer.js) render the
three-pane desktop workspace. [`ui/preload.js`](ui/preload.js) exposes a bounded,
context-isolated API; renderer code does not receive unrestricted Node access.

### Terminal daemon

[`ui/terminal-daemon.js`](ui/terminal-daemon.js) owns the real PTY processes.
[`ui/daemon-client.js`](ui/daemon-client.js) reconnects Electron to those
processes and maintains terminal identity across window reloads. The daemon is
why a renderer refresh does not automatically destroy a working agent session.

### Hidden pane hosts

Visible panes are presentation surfaces. Hidden pane hosts provide a stable
injection and acknowledgement path even when a visible renderer is loading or
backgrounded. Delivery flows through
[`ui/pane-host-renderer.js`](ui/pane-host-renderer.js) and returns an explicit
outcome to main.

## Message path

1. A sender addresses `architect`, `builder`, or `oracle` through
   [`ui/scripts/hm-send.js`](ui/scripts/hm-send.js).
2. The local WebSocket runtime validates and journals the envelope.
3. Main routes the message to the target pane host and waits for delivery
   evidence.
4. File triggers under `.squidrun/triggers/` remain a fallback path.
5. [`ui/scripts/hm-comms.js`](ui/scripts/hm-comms.js) queries the durable
   communication journal.

An accepted send is deliberately different from a processed message. The
protocol and state transitions are documented in
[`docs/protocol-spec.md`](docs/protocol-spec.md).

## Team Room

Team Room is the human-facing shared conversation for a project. The main
process serves the room, stores history in SQLite, pairs browser clients, and
delivers each room activation to the configured agent seats. The browser UI is
implemented by `ui/team-room.*`; the trusted service boundary lives under
`ui/modules/main/team-room-*`.

Team Room is local by default. Remote reachability is an operator-managed
network decision, not a hosted SquidRun service.

## State and continuity

Runtime state lives under the active project's `.squidrun/` directory and is
never public source. It includes session and pane identity, message journals,
delivery evidence, handoffs, context snapshots, Team Room history, pairing
state, and supervisor artifacts.

Startup restores saved terminal sessions when it can prove their identity.
Shutdown and restart paths target the selected app or pane instead of treating
every Electron process on the machine as interchangeable.

## Security boundaries

- Provider credentials stay in the user's CLI or local `.env` configuration.
- Preload exposes an allowlisted IPC surface under context isolation.
- Message envelopes carry explicit target, profile, and window metadata.
- Destructive lifecycle actions are arbitrated in the main process.
- Installed packages pin their own data root and network settings.
- Runtime memory, logs, credentials, and workspace files are ignored by Git.

SquidRun launches tools with the user's operating-system permissions. The
application is therefore a local trust boundary, not a sandbox for untrusted
repositories or prompts.

## Verification map

Useful boundary tests include:

- `ui/__tests__/websocket-delivery.test.js` — addressed transport and failures.
- `ui/__tests__/startup-source-of-truth.test.js` — restart identity and state.
- `ui/__tests__/team-room-service-integration.test.js` — room lifecycle.
- `ui/__tests__/team-room-pane-delivery.test.js` — room-to-pane delivery.
- `ui/__tests__/postinstall-electron-rebuild.test.js` — native rebuild command
  safety, including Windows paths containing spaces.
- `ui/__tests__/squidrun-app.test.js` — main-process orchestration and lifecycle.

Run the complete validation gate from `ui/`:

```bash
npm ci
npm run typecheck
npm run lint
npm test -- --runInBand
```
