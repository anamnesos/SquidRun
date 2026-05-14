# Mira Import Receipt Semantics v0

Status: receipt design only. No apply code, approval marker, copy, import, or
queue mutation is introduced by this milestone.

A future approved import apply lane must write an import receipt under:

```text
<MIRA_STATE_ROOT>/imports/receipts/<receipt_id>.json
```

## Purpose

Receipts are the audit proof that an approved batch copied only reviewed files
into Mira-owned state. A receipt is not approval by itself, and it must not be
used to mutate the review queue.

## Required Evidence

Each receipt must include:

- schema `mira.import_receipt.v0`;
- receipt id;
- batch id and report id;
- tool name and version;
- copy timestamp;
- mutation flags proving only copy occurred;
- queue status before copy for every record;
- source path and source `sha256`;
- destination relative path and destination `sha256`;
- destination-created proof for every record.

## Write Rules For Future Apply Lane

A future apply lane must:

- fail the whole batch before writing if any destination already exists;
- copy with exclusive-create/no-overwrite behavior;
- hash source before copy and destination after copy;
- write the receipt only after all destination hashes match source hashes;
- leave queue and report files unchanged;
- leave runtime continuity loading unchanged.

## Non-Scope

- No apply/import execution.
- No approval marker.
- No queue status mutation.
- No runtime auto-load of imported continuity.
- No bridge, UI, or Telegram route work.
