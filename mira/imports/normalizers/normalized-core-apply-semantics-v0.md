# Normalized Core Apply Semantics v0

Status: design contract only. No normalized apply implementation, state write,
receipt write, queue mutation, report mutation, runtime load, Telegram, bridge,
or UI change exists in this commit.

## Scope

The future batch 2a apply lane may materialize only the normalized preview output
for:

- `mira_self_profile`
- `james_relationship_state`
- `relationship_presence_permissions`

It must use:

- report `mira/imports/reports/batch-2a-normalized-core-dry-run-v1.json`;
- approval marker `mira/imports/approvals/batch-2a-normalized-core-approval-v1.json`;
- dry-run builder `mira/tools/normalize-core-dry-run.js`.

## Preconditions

The apply lane must fail before writing anything unless all of these are true:

- `MIRA_STATE_ROOT` resolves outside `.squidrun`;
- the normalized-core approval marker matches the report and contract;
- the approved record ids exactly match the three batch 2a records;
- the normalizer dry-run succeeds with zero errors;
- every destination resolves inside `MIRA_STATE_ROOT`;
- no destination file already exists;
- the caveats in the approval marker are preserved.

## Write Rules

If later implemented, apply must:

- write only normalized JSON outputs, never raw source JSON;
- create destination files with exclusive-create/no-overwrite behavior;
- write `continuity/core/*.normalized.json` and
  `permissions/core/*.normalized.json` only;
- hash source text and normalized destination text;
- write a normalized receipt only after every destination hash matches the
  preview hash;
- leave review queue, dry-run report, approval marker, source files, and runtime
  session state unchanged.

## Receipt Shape

The future receipt must use schema `mira.normalized_core_receipt.v0` and include:

- receipt id;
- batch id, report id, approval id, and contract id;
- tool name/version;
- normalized timestamp;
- mutation flags proving normalized writes only;
- source path and source sha256 for each record;
- preview normalized sha256 for each record, copied from the dry-run preview;
- destination relative path and destination sha256 for each record;
- normalized output schema for each record;
- preserved caveat flags.

Each approved record id must be constrained to its exact destination relative
path and normalized output schema; hash-shaped values are not enough if they are
attached to the wrong destination or schema.

## Non-Scope

- No implementation in this commit.
- No state write.
- No receipt write.
- No queue/report/approval mutation.
- No runtime continuity load.
- No raw import.
- No growth/event batch 2b.
- No Telegram, bridge, or UI work.
