# Instance Folders - Name Mapping

## Current Architecture (3-Pane, Session 79+)

Instance directories (`arch/`, `devops/`, `ana/`) were removed in S128 (workspace simplification).
Model and role instruction files now live at the project root:

| File | Purpose |
|------|---------|
| `ROLES.md` | Shared technical-lane, safety, and startup contract |
| `CLAUDE.md` | Claude-specific shim |
| `CODEX.md` | Codex-specific shim |
| `GEMINI.md` | Gemini-specific shim |
| `AGENTS.md` | Shared runtime-address, comms, and startup instructions |

**NOTE:** Models are runtime config. Check `ui/settings.json` → `paneCommands` for current CLI assignments. Any pane can run any CLI.

Runtime fallback pane paths use canonical names (`instances/architect`, `instances/builder`, `instances/oracle`).

## Legacy Folders (removed, kept for history)

| Folder | Former Role | Removed In |
|--------|-------------|------------|
| `arch/` | Architect | Session 128 (workspace simplification) |
| `devops/` | Builder (was DevOps) | Session 128 (workspace simplification) |
| `ana/` | Oracle (was Analyst) | Session 128 (workspace simplification) |
| `front/` | Frontend | Session 77 (merged into Architect) |
| `back/` | Backend | Session 79 (merged into Builder) |
| `rev/` | Reviewer | Session 77 (merged into Architect) |

## For New Agents

- Read `ROLES.md` first for the shared technical-lane, safety, and startup contract
- Read the model-specific shim (`CLAUDE.md`, `CODEX.md`, or `GEMINI.md`) for CLI quirks
- Use your **runtime address** (Architect, Builder, Oracle) in routed messages, not the folder name; this does not define personal identity
- Trigger files and WebSocket targets use runtime addresses: `architect`, `builder`, `oracle`
