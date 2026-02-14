# Instance Folders - Name Mapping

## Current Architecture (3-Pane, Session 79+)

| Folder | Role | Pane | Status |
|--------|------|------|--------|
| `arch/` | **Architect** | 1 | Active |
| `devops/` | **DevOps** | 2 | Active |
| `ana/` | **Analyst** | 5 | Active |

**NOTE:** Models are runtime config. Check `ui/settings.json` → `paneCommands` for current CLI assignments. Any pane can run any CLI.

**Note:** The folder was renamed from `infra/` to `devops/` to match the role name.

## Legacy Folders (kept for history, not active)

| Folder | Former Role | Removed In |
|--------|-------------|------------|
| `front/` | Frontend | Session 77 (migrated to Agent Teams teammate of Architect) |
| `back/` | Backend | Session 79 (merged into DevOps) |
| `rev/` | Reviewer | Session 77 (migrated to Agent Teams teammate of Architect) |

## For New Agents

- Your folder contains a `CLAUDE.md` (or `AGENTS.md` / `GEMINI.md`) with role-specific instructions
- Follow those instructions — they define your identity and responsibilities
- Use your **role name** (Architect, DevOps, Analyst) in messages, not folder name
- Trigger files and WebSocket targets use role names: `architect`, `devops`, `analyst`
