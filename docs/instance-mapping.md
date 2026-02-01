# Instance Folders - Name Mapping

## Current Folder → Role Mapping

| Folder Name | Current Role | Model | Pane |
|-------------|--------------|-------|------|
| `lead/` | **Architect** | Claude | 1 |
| `orchestrator/` | **Infra** | Codex | 2 |
| `worker-a/` | **Frontend** | Claude | 3 |
| `worker-b/` | **Backend** | Codex | 4 |
| `investigator/` | **Analyst** | Codex | 5 |
| `reviewer/` | **Reviewer** | Claude | 6 |

## Why the Mismatch?

The folder names are legacy from an earlier 4-role architecture. The codebase was later expanded to 6 roles with clearer names, but renaming the folders requires updating 30+ source and test files.

**Current status:** Folder names are technical debt. The CLAUDE.md and AGENTS.md files inside each folder use the correct role names.

## For New Agents

- Your folder name doesn't match your role name - that's expected
- Follow the instructions in your `CLAUDE.md` or `AGENTS.md` file
- Use your **role name** (Architect, Infra, Frontend, etc.) in messages, not folder name
- Trigger files use role names: `architect.txt`, `infra.txt`, `frontend.txt`, etc.

## Future

Full rename planned for future sprint. See `workspace/build/blockers.md` for status.
