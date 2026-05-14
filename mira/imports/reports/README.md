# Mira Import Reports

Reports in this directory are reviewed dry-run artifacts. They may propose an
import batch, but they do not copy, move, delete, or mutate queue status.

An import executor must not treat a report as approval by itself. A later lane
must explicitly approve a report batch before any data moves into
`MIRA_STATE_ROOT`.
