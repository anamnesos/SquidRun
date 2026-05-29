# Mira Product Root

Mira is being extracted as a product, not added back as another SquidRun tab.

This root is the implementation-facing boundary for that extraction. It does
not move live SquidRun runtime code, copy live state, create a new SquidRun UI,
or change any Telegram route. It records what starts Mira as Mira, what must be
preserved, and what becomes deletable only after the independent runtime and
bridge reach parity.

## V1 Direction

- Runtime: Node/TypeScript local service first, because the current Mira surface,
  core modules, tests, and SquidRun bridge seams are already JavaScript/Node.
- Python: sidecars only when earned for ML, audio, vision, vector search, evals,
  or other workloads that clearly benefit from Python.
- UI: independent web/PWA surface after the runtime/bridge contract exists. Do
  not create a temporary duplicate Mira UI in SquidRun.
- State: Mira-owned state under `MIRA_STATE_ROOT`, outside `.squidrun` and not
  borrowed from SquidRun runtime memory. Development may use a gitignored local
  Mira state root.
- Bridge: SquidRun connects to Mira through a narrow bridge protocol for pane
  messages, session context, capabilities, health, and evidence metadata.

## Current Boundary

The manifest remains the import and cleanup source of truth, but the tree is now
past the first foundation commit. Current real surfaces include:

- `mira/README.md`
- `mira/import-disposition-manifest.json`
- `mira/runtime/` Node/TypeScript local service
- `mira/bridge/` SquidRun pane bridge docs and CLIs
- `mira/state/`, `mira/imports/`, `mira/tools/`, `mira/ui/`, and `mira/voice/`

The first runtime bridge parity increment is `POST /bridge/pane-messages` plus
`GET /bridge/pane-messages`: Mira runtime can receive an internal pane message,
record the roundtrip under `MIRA_STATE_ROOT/bridge/pane-roundtrips`, and return a
manual reply plan without executing `hm-send`.

Future deletion should follow the manifest after replacement code and tests
prove parity, not by manually guessing which old Mira Lab files are stale.

## Explicit Non-Scope

- No Telegram route work.
- No primary Telegram ownership change.
- No new UI surface.
- No runtime move.
- No live data copy.
- No live data delete.
