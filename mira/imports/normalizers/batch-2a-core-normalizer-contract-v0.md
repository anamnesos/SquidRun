# Batch 2a Core Normalizer Contract v0

Status: contract and dry-run report shape only. No normalizer execution, import
apply, state write, receipt write, queue mutation, runtime load, Telegram, bridge,
or UI change exists in this commit.

Source of truth: Oracle #17.

## Scope

Batch 2a is normalized core state only:

- `mira_self_profile`
- `james_relationship_state`
- `relationship_presence_permissions`

The batch must produce normalized Mira-owned state, not raw copies of the
SquidRun seed files. The dry-run report may inspect source existence and top-level
schema names, but it must not write under `MIRA_STATE_ROOT`.

## Output Destinations

- `continuity/core/mira-self-profile.normalized.json`
- `continuity/core/james-relationship-state.normalized.json`
- `permissions/core/relationship-presence-permissions.normalized.json`

## Explicit Exclusions

Growth/event history is not part of batch 2a:

- `relationship_growth_history`
- `relationship_growth_audit`

Those records may become a later batch 2b only after explicit approval.

## Normalization Boundaries

- Keep current identity, relationship, boundary, and permission fields only.
- Preserve provenance as structured references, not as a claim that runtime
  continuity is loaded.
- Exclude growth event streams and transcript evidence.
- Do not copy raw source JSON wholesale.
- Do not mutate review queue status or import reports.
- Do not allow runtime `/session` to claim full continuity from this dry-run.
