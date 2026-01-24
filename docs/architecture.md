# Architecture Overview

## Core Concept

Hivemind spawns multiple Claude Code instances running in background terminals. Each instance has a specific role defined by a system prompt. They coordinate through the file system—reading and writing to a shared workspace that all instances can access.

**This is not a wrapper around Claude.** Each agent IS Claude Code, with full ability to read files, write code, run commands, and build things.

## System Design

```
┌─────────────────────────────────────────────────────────────────┐
│                           Frontend                               │
│              (Task Input / Status View / Clean UI)               │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ HTTP/WebSocket
┌─────────────────────────────────▼───────────────────────────────┐
│                      Orchestration Layer                         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                  Terminal Manager                        │    │
│  │   - Spawns headless Claude Code processes               │    │
│  │   - Passes role configs as system prompts               │    │
│  │   - Monitors process completion                         │    │
│  │   - Triggers next agent in sequence                     │    │
│  └─────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                  File System Watcher                     │    │
│  │   - Monitors workspace for state changes                │    │
│  │   - Detects agent outputs                               │    │
│  │   - Triggers events based on file changes               │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ spawns
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│   Terminal 1     │ │   Terminal 2     │ │   Terminal N     │
│  (Orchestrator)  │ │    (Worker)      │ │    (Worker)      │
│                  │ │                  │ │                  │
│  Claude Code     │ │  Claude Code     │ │  Claude Code     │
│  + Role Prompt   │ │  + Role Prompt   │ │  + Role Prompt   │
└────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
         │                    │                    │
         │         reads/writes                    │
         └────────────────────┼────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Shared File System                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  workspace/                                              │    │
│  │  ├── task.md           (current task definition)        │    │
│  │  ├── plan.md           (execution plan)                 │    │
│  │  ├── state.json        (current status)                 │    │
│  │  ├── reviews/          (reviewer feedback)              │    │
│  │  └── outputs/          (agent outputs)                  │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## How It Works

### 1. Task Submission

User submits task through UI → Backend writes `workspace/task.md` → Spawns Orchestrator terminal

### 2. Agent Execution

```
Orchestrator spawned
       │
       │ Claude Code reads task.md
       │ Claude Code writes plan.md
       │ Claude Code writes to state.json: "status": "plan_ready"
       │ Process exits
       │
       ▼
File watcher detects state change
       │
       ▼
Orchestration layer spawns Reviewer terminal
       │
       │ Claude Code reads plan.md
       │ Claude Code evaluates plan
       │ Claude Code writes reviews/plan_review.md
       │ Claude Code updates state.json: "status": "plan_approved" (or "revision_needed")
       │ Process exits
       │
       ▼
File watcher detects state change
       │
       ├── If approved: spawn Coordinator
       └── If revision needed: re-spawn Orchestrator with feedback
```

### 3. Parallel Worker Execution

```
Coordinator reads plan, determines parallelizable tasks
       │
       │ Writes assignments to workspace/assignments/
       │ Updates state.json with worker assignments
       │ Process exits
       │
       ▼
Orchestration layer spawns multiple Worker terminals simultaneously
       │
       ├── Worker 1: reads assignment, executes, writes output
       ├── Worker 2: reads assignment, executes, writes output
       └── Worker N: reads assignment, executes, writes output
       │
       ▼
All workers complete → checkpoint review → continue or finish
```

## Terminal Spawning

### Claude Code Invocation

Each agent is a Claude Code process with:
- A role-specific system prompt (from config)
- A task instruction (what to do now)
- Access to the shared workspace

```bash
# Actual Claude Code invocation
claude --print \
       --system-prompt "$(cat roles/orchestrator.md)" \
       --permission-mode bypassPermissions \
       --output-format text \
       "Read workspace/task.md and create an execution plan"

# Run from workspace directory (use cwd in subprocess)
```

### Process Lifecycle

1. **Spawn**: Orchestration layer starts terminal process
2. **Execute**: Claude Code runs with role + instruction
3. **Complete**: Process writes outputs, updates state, exits
4. **Detect**: File watcher sees state change
5. **Next**: Orchestration layer determines and spawns next agent

## Role Configurations

Agents are defined as configuration files, not Python classes:

```
roles/
├── orchestrator.md      # System prompt for planning
├── coordinator.md       # System prompt for task assignment
├── worker.md            # System prompt for execution
└── reviewer.md          # System prompt for adversarial review
```

Each role file contains:
- The agent's identity and purpose
- What files it should read
- What files it should write
- Constraints and guidelines
- Output format expectations

## State Management

### state.json

The orchestration layer watches this file to know what to do next:

```json
{
  "task_id": "task_001",
  "status": "workers_executing",
  "phase": "execution",
  "plan_version": 2,
  "plan_approved": true,
  "workers": {
    "worker_1": {"status": "running", "subtask": "st_1"},
    "worker_2": {"status": "completed", "subtask": "st_2"},
    "worker_3": {"status": "running", "subtask": "st_3"}
  },
  "checkpoints_passed": ["checkpoint_1"],
  "next_checkpoint": "checkpoint_2",
  "errors": []
}
```

### State Transitions

| Current Status | Trigger | Next Action |
|---------------|---------|-------------|
| `task_created` | task.md written | Spawn Orchestrator |
| `plan_ready` | plan.md written | Spawn Reviewer |
| `plan_approved` | reviewer approves | Spawn Coordinator |
| `revision_needed` | reviewer rejects | Re-spawn Orchestrator |
| `assignments_ready` | coordinator done | Spawn Workers |
| `workers_executing` | worker completes | Check if all done |
| `checkpoint_reached` | milestone hit | Spawn Reviewer |
| `completed` | all work done | Notify user |

## File System as Communication

All agent communication happens through files:

### Orchestrator → Reviewer
```
Orchestrator writes: workspace/plan.md
Reviewer reads: workspace/plan.md
Reviewer writes: workspace/reviews/plan_v1.md
```

### Coordinator → Workers
```
Coordinator writes: workspace/assignments/worker_1.md
Worker 1 reads: workspace/assignments/worker_1.md
Worker 1 writes: workspace/outputs/st_1/
```

### Any Agent → State
```
Agent updates: workspace/state.json
Watcher detects change
Orchestration layer reacts
```

## Advantages of This Approach

### 1. Full Claude Code Capabilities
Each agent can use all Claude Code features:
- File read/write
- Code execution
- Git operations
- Terminal commands
- Web search (if enabled)

### 2. Natural Workspace
No serialization/deserialization. Agents work with real files that persist and can be inspected.

### 3. Debuggability
- View any agent's workspace state at any time
- Replay by restoring workspace to previous state
- Logs are just files

### 4. Simplicity
- No API response parsing
- No tool call simulation
- Claude Code already handles the hard parts

### 5. Scalability
- Terminals are independent processes
- Can run on different machines (future)
- No shared memory concerns

## Security Considerations

### Sandboxing
- Each terminal runs in the workspace directory
- Consider using Claude Code's sandbox mode
- Limit file system access to workspace

### Resource Limits
- Set timeouts for each agent
- Limit concurrent terminals
- Monitor for runaway processes

### API Key Management
- Claude Code uses its own authentication
- No API keys in workspace files
- Orchestration layer handles spawning securely

## Error Handling

### Agent Timeout
```
Agent doesn't complete within timeout
→ Kill process
→ Log error to workspace/errors/
→ Update state.json with error
→ Retry or escalate based on config
```

### Agent Crash
```
Process exits with error
→ Capture stderr
→ Log to workspace/errors/
→ Update state.json
→ Determine retry strategy
```

### Infinite Loop Prevention
```
Same state persists too long
→ File watcher detects no progress
→ Escalate to human attention
→ Pause further spawning
```

## Robustness & Safety

### State.json Write Ownership

**Critical Rule**: Only the orchestration backend writes to `state.json`.

Agents do NOT write directly to state.json. Instead:
1. Agents write to their output files (plan.md, reviews/*.md, outputs/*.md)
2. Agents signal completion via a `.done` marker file
3. Backend detects completion, reads agent output, updates state.json

This prevents race conditions and corruption from multiple agents writing simultaneously.

```
Agent completes work
    │
    ├── Writes: outputs/st_1.md (their work)
    └── Writes: outputs/st_1.done (completion signal)
           │
           ▼
Backend detects .done file
    │
    ├── Reads agent output
    ├── Validates output
    └── Updates state.json (single writer)
```

### Files Touched Declaration

Every subtask in plan.md MUST declare which files it will create/modify:

```markdown
### ST-1: Set up auth router
- **Files touched**:
  - CREATE: src/api/auth.py
  - CREATE: src/api/models/user.py
  - MODIFY: src/api/main.py
```

The Coordinator uses this to:
- Detect file conflicts before assigning parallel workers
- Serialize tasks that touch the same files
- Validate worker output matches declared intent

### Heartbeat Mechanism

Long-running agents write a heartbeat to detect hung processes:

```
workspace/heartbeats/{agent_id}.heartbeat
```

Contents: Unix timestamp, updated every 30 seconds.

Backend monitors heartbeats:
- No update for 60s → warning logged
- No update for 120s → process considered hung, killed and retried

### Graceful Cancellation

Users can cancel execution at any time:

1. Set `state.json` status to `cancelling` (via API or manual edit)
2. Backend detects cancellation request
3. Sends SIGTERM to all running agent processes
4. Waits up to 10s for graceful shutdown
5. Sends SIGKILL if processes don't exit
6. Sets final status to `cancelled`

Agents should check for cancellation periodically on long tasks.

### Infinite Loop Prevention

Multiple safeguards prevent runaway revision loops:

1. **MAX_REVISION_CYCLES** (default: 3) - Hard limit on Orchestrator↔Reviewer cycles
2. **Disagreement escalation** - After max cycles, pause and notify human with:
   - Summary of each revision attempt
   - Points of persistent disagreement
   - Suggested resolution options
3. **Friction logging** - Repeated disagreements logged for prompt improvement

### Structured Logging

All events logged to `workspace/logs/` in JSON format:

```json
{
  "timestamp": "2024-01-15T10:05:00Z",
  "event": "agent_spawned",
  "agent": "orchestrator",
  "task_id": "task_001",
  "details": {
    "role_file": "roles/orchestrator.md",
    "instruction": "Read task.md and create execution plan"
  }
}
```

Log files:
- `events.jsonl` - All state transitions and agent spawns
- `agents/{agent_id}.log` - Stdout/stderr from each agent process
- `errors.jsonl` - All errors with stack traces

### Error Recovery Matrix

| Error Type | Detection | Recovery |
|-----------|-----------|----------|
| Agent timeout | No completion in N seconds | Kill, retry up to MAX_RETRIES |
| Agent crash | Non-zero exit code | Log stderr, retry with backoff |
| Hung process | Heartbeat stale >120s | Kill, retry |
| State corruption | JSON parse error | Restore from last valid backup |
| File conflict | Two agents touch same file | Kill later agent, re-coordinate |
| Max retries exceeded | Retry count >= MAX_RETRIES | Escalate to human |
| Max revisions exceeded | Revision count >= MAX_REVISION_CYCLES | Escalate with summary |

Backoff schedule: 5s, 15s, 45s (exponential)

## Future Extensions

### Remote Execution
Spawn terminals on remote machines for distributed execution.

### Custom Models
Different agents could use different models (Claude Opus for Reviewer, Claude Sonnet for Workers).

### Persistent Sessions
Keep some terminals alive between tasks for faster startup.

### Real-time Streaming
Stream terminal output to frontend for live progress view.
