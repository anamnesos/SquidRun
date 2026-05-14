# Mira Runtime

Mira runtime is the independent local Node/TypeScript service boundary for Mira.
It owns runtime state visibility under `MIRA_STATE_ROOT` and must not borrow
SquidRun private state as continuity.

## State Root

Set `MIRA_STATE_ROOT` to a Mira-owned directory outside `.squidrun`. The current
development root is gitignored:

```powershell
$env:MIRA_STATE_ROOT = "D:\projects\squidrun\mira\.state-dev"
```

The runtime rejects `.squidrun` roots and keeps broad continuity claims false
until explicitly approved.

## Status

Build the runtime TypeScript with the repo-local compiler, then inspect status:

```powershell
node ..\ui\node_modules\typescript\bin\tsc -p tsconfig.json
npm run status -- --json
```

From the repository root:

```powershell
$env:MIRA_STATE_ROOT = "D:\projects\squidrun\mira\.state-dev"
node ui\node_modules\typescript\bin\tsc -p mira\runtime\tsconfig.json
node mira\runtime\dist\status.js --json
```

The status command reports:

- state-root readiness;
- import receipt count and record count;
- read-only acceptance continuity summary for the approved first batch;
- `continuityLoaded=false`;
- `liveDataImported=false`.

It does not read SquidRun memory databases, transcripts, Telegram routes, UI
state, or any second import batch.

## Current Loader Scope

The only runtime loader currently implemented is the read-only acceptance
continuity summary. It is receipt-gated to
`acceptance-permission-contracts-v1` and may read only these files under
`MIRA_STATE_ROOT/acceptance/`:

- `mira-presence-runtime-acceptance-v0.md`
- `mira-north-star-acceptance.md`
- `mira-pc-embodiment-permission-v0.md`

This loader exposes acceptance context, not identity or relationship continuity.
Second-batch identity/relationship import is blocked until Oracle confirms exact
source IDs, risk, and whether the target should remain raw docs or become
normalized Mira-owned state.
