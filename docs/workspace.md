# Shared Workspace

## Overview

The workspace is Hivemind's external memory—the single source of truth that all agents read from and write to. It persists state outside any individual agent's context window.

## Why a Shared Workspace?

Each agent call is stateless. When an agent finishes, its context is gone. The workspace solves this by:

1. **Persisting state** between agent calls
2. **Enabling communication** between agents without direct calls
3. **Creating audit trails** of all decisions and actions
4. **Supporting recovery** if the system restarts mid-task

## Workspace Structure

```
workspace/
├── tasks/
│   └── {task_id}/
│       ├── task.json         # Original task definition
│       ├── plan.json         # Current plan (versioned)
│       ├── state.json        # Execution state
│       ├── outputs/          # Worker outputs
│       │   ├── st_1.json
│       │   ├── st_2.json
│       │   └── ...
│       ├── reviews/          # Reviewer decisions
│       │   ├── plan_v1.json
│       │   ├── checkpoint_1.json
│       │   └── ...
│       └── events.log        # Event history
├── friction/
│   └── friction.json         # Friction log (cross-task)
└── config/
    └── agents.json           # Agent configurations
```

## Core Files

### task.json

Created when a new task is submitted. Immutable after creation.

```json
{
  "id": "task_abc123",
  "created_at": "2024-01-15T10:00:00Z",
  "description": "Build a REST API for user authentication",
  "context": "This is for a FastAPI backend, Python 3.11",
  "constraints": [
    "Must use JWT tokens",
    "Must include rate limiting"
  ],
  "priority": "normal",
  "submitted_by": "user"
}
```

### plan.json

Created by Orchestrator, may have multiple versions.

```json
{
  "id": "plan_xyz789",
  "task_id": "task_abc123",
  "version": 2,
  "created_at": "2024-01-15T10:05:00Z",
  "created_by": "orchestrator",
  "status": "approved",
  "summary": "Three-endpoint auth API with JWT",
  "subtasks": [
    {
      "id": "st_1",
      "description": "Set up project structure",
      "dependencies": [],
      "estimated_complexity": "low",
      "parallelizable": false,
      "status": "completed"
    }
  ],
  "checkpoints": [...],
  "worker_count": 3,
  "risks": [...],
  "assumptions": [...]
}
```

### state.json

Living document updated throughout execution.

```json
{
  "task_id": "task_abc123",
  "plan_id": "plan_xyz789",
  "status": "executing",
  "phase": "work_in_progress",
  "started_at": "2024-01-15T10:10:00Z",
  "last_updated": "2024-01-15T10:25:00Z",
  "subtasks": {
    "st_1": {"status": "completed", "worker": "worker_1", "completed_at": "..."},
    "st_2": {"status": "completed", "worker": "worker_2", "completed_at": "..."},
    "st_3": {"status": "in_progress", "worker": "worker_1", "started_at": "..."},
    "st_4": {"status": "in_progress", "worker": "worker_3", "started_at": "..."},
    "st_5": {"status": "pending"},
    "st_6": {"status": "blocked", "blocked_by": ["st_3", "st_4", "st_5"]}
  },
  "checkpoints": {
    "checkpoint_1": {"status": "approved", "reviewed_at": "..."}
  },
  "workers": {
    "worker_1": {"status": "busy", "current_task": "st_3"},
    "worker_2": {"status": "available"},
    "worker_3": {"status": "busy", "current_task": "st_4"}
  },
  "revision_count": 1,
  "errors": []
}
```

### Output Files (outputs/st_*.json)

One file per completed subtask.

```json
{
  "subtask_id": "st_1",
  "worker_id": "worker_1",
  "completed_at": "2024-01-15T10:15:00Z",
  "status": "completed",
  "summary": "Created FastAPI project structure with auth router",
  "files_created": [
    "src/api/__init__.py",
    "src/api/main.py",
    "src/api/auth.py"
  ],
  "files_modified": [],
  "decisions": [
    "Used src/ as root package name",
    "Added /api/v1 prefix for versioning"
  ],
  "code": {
    "src/api/main.py": "from fastapi import FastAPI\n..."
  }
}
```

### Review Files (reviews/*.json)

One file per review decision.

```json
{
  "id": "review_plan_v1",
  "type": "plan_review",
  "target": "plan_xyz789_v1",
  "reviewed_at": "2024-01-15T10:07:00Z",
  "verdict": "revision_needed",
  "issues": [
    {
      "severity": "high",
      "location": "subtask st_3",
      "problem": "Missing rate limiting requirement",
      "suggestion": "Add rate limiting to login endpoint"
    }
  ],
  "notes": "Good structure, needs security hardening"
}
```

## Workspace Operations

### Reading

Agents read workspace through a service layer:

```python
# Agent reads only what it needs
workspace.read_task(task_id)
workspace.read_plan(task_id)
workspace.read_state(task_id)
workspace.read_output(task_id, subtask_id)
```

### Writing

All writes include metadata:

```python
workspace.write_plan(task_id, plan_data, agent="orchestrator")
workspace.write_output(task_id, subtask_id, output_data, agent="worker_1")
workspace.update_state(task_id, state_updates, agent="coordinator")
```

### State.json Write Ownership

**CRITICAL: Only the orchestration backend writes to state.json.**

Agents do NOT modify state.json directly. The flow is:

1. Agent completes work → writes to their output file
2. Agent signals done → creates `.done` marker file
3. Backend detects `.done` → reads output, validates, updates state.json

This prevents race conditions from multiple agents writing simultaneously.

```python
# Agent completion flow (what agents do)
class AgentCompletion:
    @staticmethod
    def signal_done(workspace: Path, agent_id: str, output_file: str):
        """Agent signals completion - does NOT write state.json."""
        done_marker = workspace / f".done.{agent_id}"
        done_marker.write_text(json.dumps({
            "agent_id": agent_id,
            "output_file": output_file,
            "completed_at": datetime.utcnow().isoformat()
        }))

# Backend completion flow (what orchestrator does)
class BackendStateManager:
    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.state_file = workspace / "state.json"
        self._lock = asyncio.Lock()

    async def update_state(self, updates: dict):
        """Only the backend calls this - single writer pattern."""
        async with self._lock:
            state = json.loads(self.state_file.read_text())
            state.update(updates)
            state["last_updated"] = datetime.utcnow().isoformat()

            # Write to temp, then atomic rename
            temp_file = self.state_file.with_suffix(".tmp")
            temp_file.write_text(json.dumps(state, indent=2))
            temp_file.rename(self.state_file)
```

### Locking

Prevents race conditions during parallel execution:

```python
with workspace.lock(task_id, "state.json", agent="coordinator"):
    state = workspace.read_state(task_id)
    state["subtasks"]["st_3"]["status"] = "completed"
    workspace.write_state(task_id, state)
```

Lock timeout: 30 seconds. Stale locks auto-release.

### State Backup

State.json is backed up before every write:

```python
def backup_state(self):
    """Keep rolling backups of state.json."""
    backups_dir = self.workspace / "backups"
    backups_dir.mkdir(exist_ok=True)

    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    backup_file = backups_dir / f"state_{timestamp}.json"
    shutil.copy(self.state_file, backup_file)

    # Keep only last 10 backups
    backups = sorted(backups_dir.glob("state_*.json"))
    for old_backup in backups[:-10]:
        old_backup.unlink()
```

If state.json becomes corrupted, the backend can restore from the most recent valid backup.

## Friction Log

The friction log captures patterns of problems across all tasks:

```json
{
  "entries": [
    {
      "id": "friction_001",
      "timestamp": "2024-01-15T11:00:00Z",
      "type": "repeated_revision",
      "description": "Orchestrator consistently underestimates complexity of auth tasks",
      "occurrences": 3,
      "affected_tasks": ["task_abc", "task_def", "task_ghi"],
      "suggested_action": "Update Orchestrator prompt to be more conservative on auth complexity",
      "status": "pending"
    },
    {
      "id": "friction_002",
      "timestamp": "2024-01-14T15:00:00Z",
      "type": "reviewer_pattern",
      "description": "Reviewer flags same security issues repeatedly",
      "pattern": "Missing input validation",
      "suggested_action": "Add input validation checklist to Worker prompt",
      "status": "applied"
    }
  ]
}
```

Friction types:
- `repeated_revision` - Same feedback given multiple times
- `reviewer_pattern` - Reviewer catches same issues repeatedly
- `worker_failure` - Worker tasks failing for similar reasons
- `timeout` - Tasks taking longer than estimates
- `escalation` - Tasks requiring human intervention

## Storage Backends

### JSON (Default)

- Simple file-based storage
- Good for local development
- Each task gets a directory

```python
class JSONWorkspace:
    def __init__(self, base_path: str):
        self.base_path = Path(base_path)
```

### SQLite (Intermediate)

- Single file database
- Better for concurrent access
- Query capabilities

```python
class SQLiteWorkspace:
    def __init__(self, db_path: str):
        self.conn = sqlite3.connect(db_path)
```

### PostgreSQL (Production)

- Full database features
- Horizontal scaling
- Robust locking

```python
class PostgresWorkspace:
    def __init__(self, connection_string: str):
        self.pool = asyncpg.create_pool(connection_string)
```

The workspace interface is the same regardless of backend.

## Event Integration

When workspace changes, events fire:

| Write Operation | Event Emitted |
|----------------|---------------|
| Create task | `task_created` |
| Write plan | `plan_ready` |
| Update plan status to approved | `plan_approved` |
| Write output | `work_completed` |
| Update checkpoint status | `checkpoint_reached` |

Events are stored in `events.log` for replay/debugging:

```
2024-01-15T10:00:00Z task_created task_abc123
2024-01-15T10:05:00Z plan_ready task_abc123 plan_xyz789
2024-01-15T10:08:00Z plan_revision_needed task_abc123 plan_xyz789
2024-01-15T10:12:00Z plan_approved task_abc123 plan_xyz789_v2
2024-01-15T10:12:00Z work_assigned task_abc123 st_1 worker_1
```

## Cleanup and Retention

Completed tasks are retained for:
- **7 days** - Full workspace (all files)
- **30 days** - Summary only (task.json, final state, friction entries)
- **Forever** - Friction log entries (anonymized)

Cleanup runs daily or on-demand:

```python
workspace.cleanup(retention_days=7)
```
