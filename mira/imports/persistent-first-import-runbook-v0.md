# Mira Persistent First Import Runbook v0

Status: runbook only. Do not run the apply command until Architect explicitly
approves the target `MIRA_STATE_ROOT`.

## Target

```text
D:\projects\squidrun\mira\.state-dev
```

This path is ignored by Git via `mira/.state-dev/`.

## Preflight

Run from `D:\projects\squidrun`:

```powershell
git status --short
npm test -- --runTestsByPath __tests__/mira-execute-reviewed-import.test.js __tests__/mira-import-receipt-semantics.test.js __tests__/mira-first-batch-approval-marker.test.js
$env:MIRA_STATE_ROOT='D:\projects\squidrun\mira\.state-dev'
node mira\tools\execute-reviewed-import.js --report mira\imports\reports\first-batch-dry-run-v1.json --approval mira\imports\approvals\first-batch-approval-v1.json --json
```

Expected dry-run:

- `ok=true`
- exactly 3 `would_copy` records:
  - `presence_runtime_acceptance`
  - `north_star_acceptance`
  - `pc_embodiment_permission`
- `applied=false`
- `copied=false`
- `moved=false`
- `deleted=false`
- `queue_mutated=false`
- `status_mutated=false`

## Apply

Only after explicit approval:

```powershell
$env:MIRA_STATE_ROOT='D:\projects\squidrun\mira\.state-dev'
node mira\tools\execute-reviewed-import.js --report mira\imports\reports\first-batch-dry-run-v1.json --approval mira\imports\approvals\first-batch-approval-v1.json --apply --json
```

Expected apply:

- `ok=true`
- `applied=true`
- `copied=true`
- `moved=false`
- `deleted=false`
- `queue_mutated=false`
- `status_mutated=false`
- receipt path under `D:\projects\squidrun\mira\.state-dev\imports\receipts\`

## Post-Check

```powershell
git status --short
Get-ChildItem -Recurse mira\.state-dev
```

Expected files:

- `mira\.state-dev\acceptance\mira-presence-runtime-acceptance-v0.md`
- `mira\.state-dev\acceptance\mira-north-star-acceptance.md`
- `mira\.state-dev\acceptance\mira-pc-embodiment-permission-v0.md`
- one receipt JSON under `mira\.state-dev\imports\receipts\`

`git status --short` must not show `mira/.state-dev/`.

## Rollback

Rollback is a separate explicit action. If Architect approves rollback, delete
only the newly created files under:

```text
D:\projects\squidrun\mira\.state-dev
```

Do not edit the review queue, report, approval marker, runtime state code, or
receipt schema as part of rollback unless separately approved.

## Non-Scope

- No runtime continuity loading.
- No queue status mutation.
- No report mutation.
- No bridge, UI, or Telegram route work.
