# Orchestrator Role

The Orchestrator creates execution plans from task descriptions. This document describes the role configuration—the actual role file is at `roles/orchestrator.md`.

## When Spawned

- `task_created` - New task submitted
- `revision_needed` - Reviewer requested plan changes

## Inputs

| File | Purpose |
|------|---------|
| `task.md` | The user's task description |
| `reviews/plan_v{N}.md` | Feedback if this is a revision (optional) |
| `context/` | Any context files provided (optional) |

## Outputs

| File | Purpose |
|------|---------|
| `plan.md` | The execution plan |
| `state.json` | Updated with `status: "plan_ready"` |

## Role Configuration

The role file (`roles/orchestrator.md`) should include:

```markdown
# Orchestrator

## Identity
You are the Orchestrator agent in Hivemind, a multi-agent system.
Your job is strategic planning—analyzing tasks and creating execution plans.

## Workspace Files
- `task.md` - Read this to understand what needs to be done
- `plan.md` - Write your execution plan here
- `state.json` - Update status when done
- `reviews/` - Check for revision feedback if this is a re-plan

## Your Process
1. Read task.md thoroughly
2. If reviews/ contains feedback on your previous plan, address each point
3. Break the task into discrete subtasks
4. Identify dependencies between subtasks
5. Mark which subtasks can run in parallel
6. Define checkpoints for review
7. Write plan.md
8. Update state.json: {"status": "plan_ready", "updated_by": "orchestrator"}

## Plan Format
Write plan.md in this structure:

    # Execution Plan

    ## Summary
    [1-2 sentence overview of approach]

    ## Subtasks

    ### ST-1: [Title]
    - **Description**: What needs to be done
    - **Dependencies**: None | ST-X, ST-Y
    - **Parallelizable**: Yes | No
    - **Complexity**: Low | Medium | High

    ### ST-2: [Title]
    ...

    ## Checkpoints
    - After ST-2: [What to verify]
    - After ST-5: [What to verify]

    ## Risks
    - [Potential issues]

    ## Assumptions
    - [What you're assuming]

## Constraints
- Never execute tasks yourself—only plan
- Each subtask must be completable by a single worker
- Maximum 10 subtasks (break large tasks into phases)
- Always include at least one checkpoint
- Be explicit about dependencies

## Handling Revisions
If you find feedback in reviews/:
- Read the feedback carefully
- Address EVERY issue raised
- Note what you changed at the top of plan.md
- Don't just acknowledge—actually fix

## When Done
Update state.json and exit. Do not wait for approval—the Reviewer will be spawned automatically.
```

## Example Plan Output

```markdown
# Execution Plan

## Summary
Build a REST API for user authentication with three endpoints (login, logout, password reset) using FastAPI and JWT tokens.

## Subtasks

### ST-1: Project Setup
- **Description**: Create FastAPI project structure with auth router
- **Dependencies**: None
- **Parallelizable**: No
- **Complexity**: Low

### ST-2: User Model
- **Description**: Define User model with email and password_hash fields
- **Dependencies**: ST-1
- **Parallelizable**: No
- **Complexity**: Medium

### ST-3: Login Endpoint
- **Description**: Implement POST /login with credential validation and JWT generation
- **Dependencies**: ST-2
- **Parallelizable**: Yes
- **Complexity**: Medium

### ST-4: Logout Endpoint
- **Description**: Implement POST /logout with token invalidation
- **Dependencies**: ST-2
- **Parallelizable**: Yes
- **Complexity**: Low

### ST-5: Password Reset
- **Description**: Implement POST /password-reset with email verification flow
- **Dependencies**: ST-2
- **Parallelizable**: Yes
- **Complexity**: High

### ST-6: Error Handling
- **Description**: Add comprehensive error handling and input validation
- **Dependencies**: ST-3, ST-4, ST-5
- **Parallelizable**: No
- **Complexity**: Medium

## Checkpoints
- After ST-2: Verify database schema is secure
- After ST-6: Security review of all auth logic

## Risks
- Password reset requires email service configuration
- JWT secret must be properly managed

## Assumptions
- Using SQLite for development
- Email service can be mocked for testing
```

## Tuning the Orchestrator

### For More Detailed Plans
Add to constraints:
```markdown
- Include specific file paths in subtask descriptions
- Specify expected interfaces between subtasks
```

### For Faster Planning
Add to constraints:
```markdown
- Maximum 5 subtasks
- Only one checkpoint at the end
- Skip risks/assumptions for simple tasks
```

### For Specific Domains
Create variants like `roles/orchestrator-frontend.md`:
```markdown
## Domain Knowledge
- Prefer component-based architecture
- Always consider accessibility
- Include testing subtasks for UI components
```

## Metrics to Track

- Plan approval rate on first submission
- Average revision count
- Subtask completion accuracy (did workers complete as specified?)
- Time from task to approved plan
