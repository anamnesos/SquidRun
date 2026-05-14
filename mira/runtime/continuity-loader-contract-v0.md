# Mira Runtime Continuity Loader Contract v0

Status: design contract only. No runtime continuity loader is wired to
`/session`, `/health`, model behavior, bridge behavior, Telegram, or UI in this
commit.

## Purpose

The first continuity-loader lane may read only the reviewed acceptance batch that
has already been copied into a Mira-owned state root:

- `acceptance/mira-presence-runtime-acceptance-v0.md`
- `acceptance/mira-north-star-acceptance.md`
- `acceptance/mira-pc-embodiment-permission-v0.md`

The loader exists to expose a small, auditable acceptance-context summary for
future runtime use. It must not claim conversational continuity, identity memory,
relationship memory, or model behavior migration.

## Required Preconditions

- `MIRA_STATE_ROOT` resolves outside `.squidrun`.
- At least one import receipt exists under
  `<MIRA_STATE_ROOT>/imports/receipts/`.
- The receipt proves `batch_id=acceptance-permission-contracts-v1`.
- Every file read is under `<MIRA_STATE_ROOT>/acceptance/`.
- The loaded relative paths exactly match the approved first-batch acceptance
  destinations.

## Loader Output Shape

The loader design output is:

```json
{
  "loaded": false,
  "scope": "acceptance_docs_only",
  "batch_id": "acceptance-permission-contracts-v1",
  "document_count": 0,
  "documents": [],
  "continuity_loaded": false,
  "runtime_session_claim_allowed": false,
  "error": null
}
```

When implemented, `loaded` may become `true` only for this acceptance-doc summary.
`continuity_loaded` and `runtime_session_claim_allowed` must remain `false` until
a later approved commit explicitly changes the session contract.

## Non-Scope

- No SquidRun memory DB reads.
- No transcript/evidence loading.
- No queue, report, or receipt mutation.
- No second import batch.
- No runtime `/session` continuity claim.
- No Telegram route, bridge behavior, UI, or model behavior changes.
