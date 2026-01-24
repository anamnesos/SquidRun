# Agent Overview

## What Agents Are

In Hivemind, agents are **role configurations**, not code. Each agent is a markdown file containing a system prompt that gets passed to a Claude Code instance when it's spawned.

```
roles/
├── orchestrator.md      # Planning agent
├── coordinator.md       # Task assignment agent
├── worker.md            # Execution agent
└── reviewer.md          # Adversarial review agent
```

When the orchestration layer needs to run an agent, it:
1. Reads the role file
2. Spawns a Claude Code process with that system prompt
3. Gives it a specific instruction for the current task
4. Waits for it to complete

## Why Config-Based Agents?

### Claude Code Does the Work
We don't need Python classes that call an API and parse responses. Claude Code already knows how to read files, write code, and execute commands. We just need to tell it what role to play.

### Easy to Modify
Changing agent behavior = editing a markdown file. No code changes, no redeployment.

### Transparent
Anyone can read the role files and understand exactly what each agent is instructed to do.

### Version Controllable
Role prompts are just text files. Track changes with git, experiment with variations, roll back if needed.

## Agent Execution Model

```
┌─────────────────────────────────────────────┐
│           Orchestration Layer               │
│                                             │
│  "state.json says plan_ready..."            │
│  "I need to spawn the Reviewer"             │
│                                             │
└─────────────────────┬───────────────────────┘
                      │
                      │ 1. Read roles/reviewer.md
                      │ 2. Spawn claude-code process
                      │ 3. Pass: system prompt + instruction
                      │
                      ▼
┌─────────────────────────────────────────────┐
│         Claude Code Terminal                 │
│                                             │
│  System: [contents of reviewer.md]          │
│  User: "Review workspace/plan.md and..."    │
│                                             │
│  Claude Code executes:                      │
│  - Reads plan.md                            │
│  - Evaluates against criteria               │
│  - Writes reviews/plan_v1.md                │
│  - Updates state.json                       │
│  - Exits                                    │
│                                             │
└─────────────────────────────────────────────┘
```

## Role File Structure

Each role file follows this pattern:

```markdown
# [Agent Name]

## Identity
You are the [Role] agent in Hivemind, a multi-agent system.
[Core purpose in one sentence]

## Responsibilities
- [What this agent does]
- [What this agent does]

## Workspace
You operate in a shared workspace. Key files:
- `task.md` - The original task from the user
- `plan.md` - The execution plan
- `state.json` - Current system state
- [Other relevant files]

## Your Task
When activated, you will:
1. Read [specific files]
2. [Do your work]
3. Write [specific outputs]
4. Update state.json with [specific status]

## Constraints
- [What you must NOT do]
- [Boundaries]

## Output Format
[How to structure your outputs]
```

## Agent Summaries

| Agent | Spawned When | Reads | Writes | Sets Status |
|-------|--------------|-------|--------|-------------|
| **Orchestrator** | Task created, revision needed | task.md | plan.md | `plan_ready` |
| **Reviewer** | Plan ready, checkpoint reached | plan.md, outputs/ | reviews/*.md | `plan_approved` or `revision_needed` |
| **Coordinator** | Plan approved | plan.md | assignments/*.md | `assignments_ready` |
| **Worker** | Assignment ready | assignments/*.md | outputs/*/ | `subtask_complete` |

## Detailed Role Documentation

- [Orchestrator](./orchestrator.md) - Creates execution plans from tasks
- [Coordinator](./coordinator.md) - Assigns work and prevents conflicts
- [Worker](./worker.md) - Executes specific subtasks
- [Reviewer](./reviewer.md) - Adversarial quality assurance

## Customizing Agents

### Adjusting Behavior

Edit the role file directly:

```markdown
## Constraints
- Maximum 5 subtasks per plan (was 10)
- Always include security checkpoint (new)
```

### Creating Variants

For different project types, create role variants:

```
roles/
├── orchestrator.md           # Default
├── orchestrator-frontend.md  # Frontend-focused planning
├── orchestrator-api.md       # API-focused planning
└── orchestrator-minimal.md   # Quick/simple tasks
```

The orchestration layer can select variants based on task classification.

### A/B Testing

Run experiments by swapping role files:
1. Copy `reviewer.md` to `reviewer-v2.md`
2. Modify the review criteria
3. Configure orchestration to use v2 for some tasks
4. Compare outcomes in friction log

## Adding New Agents

To add a specialized agent:

1. **Create role file**: `roles/researcher.md`
2. **Define triggers**: When should this agent run?
3. **Update state machine**: Add new status values
4. **Update orchestration**: Teach it when to spawn

Example - Adding a Researcher agent:

```markdown
# Researcher

## Identity
You are the Researcher agent in Hivemind.
You gather information before planning begins.

## Responsibilities
- Search for relevant documentation
- Analyze existing codebases
- Identify potential approaches
- Summarize findings for the Orchestrator

## Your Task
1. Read task.md
2. Research the problem space
3. Write research/findings.md
4. Update state.json: "status": "research_complete"
```

## Agent Communication Protocol

Agents never communicate directly. All coordination happens through files:

### Writing State
```json
// Agent updates state.json before exiting
{
  "status": "plan_ready",
  "updated_by": "orchestrator",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### Reading Others' Output
```
Reviewer reads: workspace/plan.md (written by Orchestrator)
Worker reads: workspace/assignments/worker_1.md (written by Coordinator)
```

### Signaling Completion
When an agent finishes, it:
1. Writes its outputs
2. Updates state.json with new status
3. Exits the process

The file watcher detects the state change and triggers the next agent.

## Debugging Agents

### View What an Agent Saw
Check the workspace files at the time of execution.

### View What an Agent Did
Check the files it created/modified and state.json.

### Re-run an Agent
Reset state.json to previous status, let orchestration re-spawn.

### Test a Role Prompt
Run Claude Code manually with the role:
```bash
claude-code --system-prompt "$(cat roles/reviewer.md)" \
            --message "Review this plan: [paste plan]"
```
