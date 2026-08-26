# SquidRun

Local-first multi-agent orchestration for Claude Code, Codex CLI, and Gemini CLI.

[Website](https://squidrun.com) · [Install guide](docs/guide/install.md) · [Quickstart](docs/guide/quickstart.md) · [Protocol](docs/protocol-spec.md) · [Architecture](ARCHITECTURE.md)

> **Alpha / source release 0.1.34:** SquidRun is a developer preview with sharp edges. There is no current published binary release. Clone the repository and run it from source.

## What it is

SquidRun is a standalone Electron desktop app for one person running three AI coding agents against the same local project:

- **Architect** coordinates the work.
- **Builder** implements and tests it.
- **Oracle** investigates and checks the result.

The role is attached to the pane, not the model. You can assign Claude Code, Codex CLI, or Gemini CLI to any pane in Settings, including the same CLI in more than one pane.

## What is implemented

- A persistent three-pane terminal workspace backed by real local CLI processes.
- Per-pane CLI selection and project workspace selection.
- Addressed agent-to-agent messages through `hm-send`.
- WebSocket delivery with trigger-file fallback.
- A durable SQLite communication journal queried through `hm-comms`.
- Per-pane session identity and restart-resume support.
- A browser-based Team Room where the human and all three seats share one
  durable project conversation.
- Project-local coordination state under `.squidrun/`.
- Optional Telegram ingress for a private bot you configure yourself.

This is not a code editor, IDE extension, hosted agent service, or multi-human collaboration product. It runs beside your editor and gives local CLI agents a shared operating layer.

## Run from source

### Prerequisites

- Windows, macOS, or Linux
- Node.js 22.12 or newer
- npm
- At least one installed and authenticated CLI:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
  - [Codex CLI](https://github.com/openai/codex)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli)

### Install and start

```bash
git clone https://github.com/anamnesos/SquidRun.git
cd SquidRun/ui
npm ci
npm start
```

On first launch, open Settings and assign a CLI command to each pane. Select the project directory the agents should work in. SquidRun creates local coordination state in `<your-project>/.squidrun/`; that directory is runtime data, not part of this repository.

## Inspect the engineering

The repository is intentionally public so the difficult parts can be checked instead of taken on faith:

- [`ARCHITECTURE.md`](ARCHITECTURE.md) maps the Electron processes, panes, broker, and persistence boundaries.
- [`docs/protocol-spec.md`](docs/protocol-spec.md) defines message targets, delivery states, and receipts.
- [`ui/modules/cli-resume-invocation.js`](ui/modules/cli-resume-invocation.js) implements per-pane restart continuity.
- [`ui/modules/websocket-runtime.js`](ui/modules/websocket-runtime.js) implements the agent message transport.
- [`ui/modules/main/team-room-runtime.js`](ui/modules/main/team-room-runtime.js) owns Team Room lifecycle, pairing, delivery, and history.
- [`ui/__tests__/team-room-service-integration.test.js`](ui/__tests__/team-room-service-integration.test.js) exercises the real room boundary.
- [`ui/__tests__/websocket-delivery.test.js`](ui/__tests__/websocket-delivery.test.js) exercises delivery and failure paths.
- [`ui/__tests__/startup-source-of-truth.test.js`](ui/__tests__/startup-source-of-truth.test.js) checks restart state boundaries.

The codebase is larger than a demo and still evolving. Historical design notes remain where they explain current code, but runtime logs, user memory, private workspace state, credentials, and local agent configuration do not belong in the public repository.

## Validate a checkout

From `ui/`:

```bash
npm run typecheck
npm run lint
npm test
```

For a faster first pass:

```bash
node --no-warnings ./node_modules/jest/bin/jest.js --runInBand websocket-delivery.test.js startup-source-of-truth.test.js
```

## Security and data boundary

SquidRun launches tools that can read files and execute commands with your account's permissions. Use it only on projects and machines you trust. Provider traffic still goes to the provider behind each CLI, and optional integrations such as Telegram contact their own services. SquidRun does not make those external tools local.

Keep `.env`, `.squidrun/`, `workspace/`, model-specific config directories, and credentials out of commits. The repository `.gitignore` covers the standard local paths; review `git status` before publishing changes.

## Status

SquidRun is alpha software for technical users. Core orchestration is real and tested, but setup, error recovery, packaging, and platform parity are still being hardened. See [current limitations](docs/guide/limitations.md) before using it for important work.

## Contributing

Issues and focused pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
