# Mira Import Executor Semantics v0

Status: executor exists at `mira/tools/execute-reviewed-import.js`.
Apply/import execution is supported only for an explicitly approved marker and
must write a receipt.

This contract defines how a future reviewed import executor must behave before
any Mira continuity, acceptance, permission, or conversation evidence is copied
into `MIRA_STATE_ROOT`.

## Command Shape

Executor name:

```text
node mira/tools/execute-reviewed-import.js --report mira/imports/reports/first-batch-dry-run-v1.json
```

V0 is dry-run first. `--apply` is available only when a matching explicit
`--approval` marker is supplied, and it must remain copy-only.

## Batch Gate

The executor must be report-gated:

- It must read exactly one report path supplied by `--report`.
- It must read exactly one approval marker supplied by `--approval`.
- It must consider only records listed in that report.
- It must not scan or import the full review queue.
- It must not infer approval from memory, recall, runtime health, or file
  presence.
- It must require explicit batch approval before any apply mode can exist.

For the current report, `requires_explicit_approval_before_import=true` and
`status=review_only`, so the only allowed behavior with a matching approval
marker is dry-run planning.

## Required Verification

Before any future write, every record in the report must be checked against
`mira/imports/review-queue.json`:

- report record id exists in the queue;
- source path matches the queue source path;
- destination path matches the queue destination path;
- queue status is `not_imported`;
- source exists on disk;
- destination resolves under `MIRA_STATE_ROOT`;
- destination does not already exist;
- report mutation flags are all false.
- approval marker id list exactly matches the report record ids;
- approval marker mutation limits allow copy only and deny move, delete, queue
  mutation, report mutation, and runtime loading.

Any mismatch fails the whole batch before any write.

## Dry-Run Behavior

Default execution must emit a plan only:

- `applied=false`
- `would_copy=[...]`
- `copied=false`
- `moved=false`
- `deleted=false`
- `queue_mutated=false`
- `status_mutated=false`

Dry-run must create no directories, copy no files, write no receipts, and mutate
no report or queue status.

## Apply Behavior

Apply mode must follow these minimum rules:

- copy selected files with exclusive-create/no-overwrite semantics;
- fail the entire batch before writing if any destination exists;
- write import receipts under `imports/receipts/`;
- keep queue status mutation as a separate reviewed lane;
- do not cause runtime to auto-load imported continuity.

## Non-Scope

- No queue status mutation.
- No relationship memory or transcript batch approval.
- No runtime auto-load of imported continuity.
- No bridge, UI, or Telegram route work.
