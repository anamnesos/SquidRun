# Instance Folders - Name Mapping

## Current Architecture (3-Pane, Session 79+)

Instance directories (`arch/`, `devops/`, `ana/`) were removed in S128 (workspace simplification).
Model and role instruction files now live at the project root:

| File | Purpose |
|------|---------|
| `ROLES.md` | Canonical role definitions and startup baseline |
| `CLAUDE.md` | Claude-specific shim |
| `CODEX.md` | Codex-specific shim |
| `GEMINI.md` | Gemini-specific shim |
| `AGENTS.md` | Shared agent instructions (identity, comms, startup) |

**NOTE:** Models are runtime config. Check `ui/settings.json` → `paneCommands` for current CLI assignments. Any pane can run any CLI.

## Legacy Folders (removed, kept for history)

| Folder | Former Role | Removed In |
|--------|-------------|------------|
| `arch/` | Architect | Session 128 (workspace simplification) |
| `devops/` | DevOps | Session 128 (workspace simplification) |
| `ana/` | Analyst | Session 128 (workspace simplification) |
| `front/` | Frontend | Session 77 (migrated to Agent Teams teammate of Architect) |
| `back/` | Backend | Session 79 (merged into DevOps) |
| `rev/` | Reviewer | Session 77 (migrated to Agent Teams teammate of Architect) |

## For New Agents

- Read `ROLES.md` first for your role definition and startup baseline
- Read the model-specific shim (`CLAUDE.md`, `CODEX.md`, or `GEMINI.md`) for CLI quirks
- Use your **role name** (Architect, DevOps, Analyst) in messages, not folder name
- Trigger files and WebSocket targets use role names: `architect`, `devops`, `analyst`
