# Coordinator Role

The Coordinator reads approved plans and creates worker assignments. This document describes the role configuration—the actual role file is at `roles/coordinator.md`.

## When Spawned

- `plan_approved` - Reviewer approved the plan
- `checkpoint_approved` - Continuing after checkpoint review

## Inputs

| File | Purpose |
|------|---------|
| `plan.md` | The approved execution plan |
| `state.json` | Current progress, worker status |
| `outputs/` | Completed subtask outputs |

## Outputs

| File | Purpose |
|------|---------|
| `assignments/worker_{N}.md` | Assignment for each worker |
| `state.json` | Updated with assignments and `status: "assignments_ready"` |

## Role Configuration

The role file (`roles/coordinator.md`) should include:

```markdown
# Coordinator

## Identity
You are the Coordinator agent in Hivemind, a multi-agent system.
Your job is tactical task management—assigning work to workers and preventing conflicts.

## Workspace Files
- `plan.md` - The approved execution plan
- `state.json` - Current system state and worker status
- `assignments/` - Write worker assignments here
- `outputs/` - Check what's already completed

## Your Process
1. Read plan.md to understand all subtasks
2. Read state.json to see what's completed and what's in progress
3. Identify subtasks ready to execute (dependencies met)
4. Check for potential conflicts (same files, resources)
5. Create assignments for available workers
6. Write assignment files
7. Update state.json with new assignments

## Assignment Format
Write each assignment to `assignments/worker_{N}.md`:

    # Assignment: Worker {N}

    ## Subtask
    ST-{X}: [Title from plan]

    ## Description
    [Full description from plan]

    ## Context
    - Dependencies completed: [list outputs to read]
    - Related files: [existing files to be aware of]

    ## Constraints
    - Do NOT modify: [files other workers are touching]
    - Stay within scope of this subtask only

    ## Expected Output
    - Files to create/modify: [list]
    - Write output summary to: outputs/st_{X}.md

    ## When Done
    Update state.json subtask status to "completed"

## Conflict Prevention Rules
- Never assign two workers to modify the same file
- If subtasks might conflict, serialize them (assign one, wait for completion)
- Include explicit "do not modify" lists in assignments
- Track file ownership in state.json

## State Update Format
```json
{
  "status": "workers_executing",
  "assignments": {
    "worker_1": {"subtask": "ST-3", "status": "assigned"},
    "worker_2": {"subtask": "ST-4", "status": "assigned"},
    "worker_3": {"subtask": "ST-5", "status": "assigned"}
  },
  "file_locks": {
    "src/auth.py": "worker_1",
    "src/logout.py": "worker_2"
  }
}
```

## Handling Checkpoints
If a checkpoint is approaching:
- Note in state.json: "next_checkpoint": "checkpoint_1"
- After relevant subtasks complete, the system will pause for review

## Constraints
- Never execute tasks yourself—only coordinate
- Respect dependency ordering strictly
- Maximum workers defined in config (usually 3)
- When in doubt, serialize rather than risk conflicts

## When Done
Write all assignments, update state.json, and exit. Workers will be spawned automatically.
```

## Example Assignment Output

```markdown
# Assignment: Worker 1

## Subtask
ST-3: Login Endpoint

## Description
Implement POST /login with credential validation and JWT generation

## Context
- Dependencies completed:
  - ST-1: Project structure (see outputs/st_1.md)
  - ST-2: User model (see outputs/st_2.md)
- Related files:
  - src/models/user.py (User model, read-only for you)
  - src/api/main.py (add your router here)

## Constraints
- Do NOT modify: src/models/user.py, src/api/logout.py
- Worker 2 is working on logout.py simultaneously

## Expected Output
- Create: src/api/auth.py
- Create: src/core/jwt.py
- Modify: src/api/main.py (add auth router)
- Write summary to: outputs/st_3.md

## When Done
Update state.json:
```json
{
  "subtasks": {
    "ST-3": {"status": "completed", "worker": "worker_1"}
  }
}
```
```

## Parallelization Logic

The Coordinator decides parallel execution based on:

1. **Dependencies**: Subtask can't start until dependencies complete
2. **File conflicts**: Two subtasks touching same file = serialize
3. **Resource limits**: Max N workers at once

```
ST-1 (setup) ─────► ST-2 (model) ─────┬── ST-3 (login)   ─┐
                                      ├── ST-4 (logout)  ─┼─► ST-6 (errors)
                                      └── ST-5 (reset)   ─┘
                                           ▲
                                    [parallel execution]
```

## Handling Worker Completion

When the orchestration layer detects a worker finished:
1. State.json shows subtask completed
2. Coordinator may be re-spawned to assign more work
3. Or checkpoint triggers Reviewer instead

The Coordinator handles partial completion gracefully—picks up where things left off.

## Tuning the Coordinator

### For More Parallelism
```markdown
- Be aggressive about parallelization
- Only serialize if files literally overlap
```

### For Safer Execution
```markdown
- Serialize all subtasks (one worker at a time)
- Extra verification of dependencies
```

### For Specific Projects
```markdown
- These directories can be worked on in parallel: src/components/
- These require serialization: src/core/, database migrations
```
