# Mira State Root

Mira-owned state is resolved from `MIRA_STATE_ROOT`.

This directory documents the contract only. It is not the live state root, and it
must not receive copied SquidRun runtime data during the extraction planning
phase.

Rules:

- `MIRA_STATE_ROOT` is required for live Mira runtime state.
- `.squidrun` is never a Mira durable state destination.
- SquidRun cognitive memory is not a Mira-owned continuity store.
- Imports begin as `not_imported` review records.
- A reviewed import may name a destination under the Mira state root, but this
  tooling does not copy, delete, or move live data.
