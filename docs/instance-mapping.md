# Instance Folders - Name Mapping

## Current Architecture (3-Pane, Session 79+)

| Folder | Role | Model | Pane | Status |
|--------|------|-------|------|--------|
| `arch/` | **Architect** | Claude | 1 | Active |
| `infra/` | **DevOps** | Codex | 2 | Active (folder name is legacy — role is DevOps) |
| `ana/` | **Analyst** | Gemini | 5 | Active |

**Note:** The `infra/` folder name predates the DevOps rename (Session 79 merged Infra + Backend). The folder retains the old name but the role is DevOps.

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
