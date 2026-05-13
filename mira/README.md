# Mira Product Root

Mira is being extracted as a product, not added back as another SquidRun tab.

This root is the first implementation-facing boundary for that extraction. It
does not move runtime code, copy live state, create a new UI, or change any
Telegram route. It records what starts Mira as Mira, what must be preserved, and
what becomes deletable only after the independent runtime and bridge reach
parity.

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

The first foundation commit is documentation plus a manifest:

- `mira/README.md`
- `mira/import-disposition-manifest.json`

The manifest is the source of truth for the next extraction commits. Future
deletion should follow the manifest after replacement code and tests prove
parity, not by manually guessing which old Mira Lab files are stale.

## Explicit Non-Scope

- No Telegram route work.
- No primary Telegram ownership change.
- No new UI surface.
- No runtime move.
- No live data copy.
- No live data delete.
