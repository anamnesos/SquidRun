# Mira Reviewed Import Queue

This queue lists SquidRun-era Mira artifacts that may be reviewed for selective
import into Mira-owned state.

Every record starts as `not_imported`. A later implementation may mark a record
reviewed and copy selected content into `MIRA_STATE_ROOT`, but this milestone is
only the map and validator. It does not copy, delete, or move live data.
