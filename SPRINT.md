# Hivemind Build Sprint

## Instance Roles

| Instance | Role | Responsibilities |
|----------|------|------------------|
| **Instance 1** | Lead | Coordination, conflict resolution, integration, this doc |
| **Instance 2** | Worker A | Core orchestration: spawner, state machine |
| **Instance 3** | Worker B | Workspace management: watcher, file ops, logging |
| **Instance 4** | Reviewer | Code review, type checking, integration testing |

## Communication Protocol

All instances read/write to `workspace/build/` for coordination:

```
workspace/build/
├── status.md          # Current sprint status (Lead updates)
├── blockers.md        # Blockers and questions (anyone writes, Lead resolves)
├── reviews/           # Reviewer feedback
│   └── {component}.md
└── integration/       # Integration notes
    └── notes.md
```

### When You're Done With a Task
1. Write your code
2. Add entry to `workspace/build/status.md` under your section
3. If you have questions, write to `blockers.md`
4. Wait for Reviewer feedback before moving to next task

### When You Hit a Conflict
1. STOP - don't modify files you don't own
2. Write to `blockers.md` describing the issue
3. Lead will resolve and update assignments

---

## File Ownership

### Worker A (Instance 2) - Owns:
```
src/orchestration/
├── __init__.py
├── spawner.py         # Claude Code process spawning
├── state_machine.py   # State transitions and agent dispatch
└── manager.py         # Main orchestration loop

src/config/
├── __init__.py
└── settings.py        # Pydantic settings
```

### Worker B (Instance 3) - Owns:
```
src/orchestration/
├── watcher.py         # File system watcher
├── heartbeat.py       # Heartbeat monitoring
└── logging.py         # Structured JSON logging

src/workspace/
├── __init__.py
├── manager.py         # Workspace read/write operations
├── locking.py         # File locking
└── backup.py          # State backup/restore
```

### Lead (Instance 1) - Owns:
```
src/
├── __init__.py
├── main.py            # Entry point

src/models/
├── __init__.py
├── state.py           # State models
├── task.py            # Task models
└── agent.py           # Agent models

src/api/               # If we get to API this sprint
├── __init__.py
└── routes/
```

### Reviewer (Instance 4) - Owns:
```
tests/                 # All test files
workspace/build/reviews/
```

---

## Sprint Tasks

### Phase 1: Foundation (Do First)

#### Worker A Tasks:
1. **[A1] Create settings.py** - Pydantic settings with all config from .env.example
2. **[A2] Create spawner.py** - `spawn_claude()` function that invokes Claude CLI
3. **[A3] Create state_machine.py** - Status enum, transitions dict, `get_next_action()`

#### Worker B Tasks:
1. **[B1] Create watcher.py** - Watch workspace for .done files and state changes
2. **[B2] Create logging.py** - JSON log handler, setup_logging(), event logger
3. **[B3] Create locking.py** - File lock context manager with timeout

#### Lead Tasks:
1. **[L1] Create models** - State, Task, Agent, Subtask Pydantic models
2. **[L2] Create src/__init__.py and main.py stub** - Basic entry point
3. **[L3] Integrate Phase 1** - Wire components together, verify imports work

#### Reviewer Tasks:
1. **[R1] Review A1, B1, L1** as they complete
2. **[R2] Run type checks** - `mypy src/`
3. **[R3] Verify imports** - `python -c "from src.orchestration import spawner"`

### Phase 2: Core Loop (After Phase 1)

#### Worker A Tasks:
4. **[A4] Create manager.py** - `HivemindOrchestrator` class, main loop
5. **[A5] Implement spawn_with_timeout()** - Timeout and retry logic
6. **[A6] Implement parallel worker spawning** - Multiple workers at once

#### Worker B Tasks:
4. **[B4] Create workspace/manager.py** - Read/write operations with metadata
5. **[B5] Create heartbeat.py** - Heartbeat writer and monitor
6. **[B6] Create backup.py** - State backup before writes

#### Lead Tasks:
4. **[L4] Create agent.py models** - AgentResult, AgentError models
5. **[L5] Integration test** - Manual test of spawning a simple agent
6. **[L6] Create cancellation flow** - Watch for cancellation status

### Phase 3: Polish (If Time)

- Error recovery implementation
- Basic CLI interface
- Simple status display

---

## Task Details

### [A1] settings.py

```python
# src/config/settings.py
from pydantic_settings import BaseSettings
from pathlib import Path

class Settings(BaseSettings):
    # Copy all settings from docs/orchestration.md Configuration section
    # Add model_config for env file

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

settings = Settings()
```

### [A2] spawner.py

```python
# src/orchestration/spawner.py
# Implement spawn_claude() from docs/orchestration.md
# Key: use --permission-mode bypassPermissions
# Return (returncode, stdout, stderr)
```

### [A3] state_machine.py

```python
# src/orchestration/state_machine.py
# Copy Status enum from docs/orchestration.md
# Copy TRANSITIONS dict
# Implement get_next_action(state: dict) -> Transition | None
```

### [B1] watcher.py

```python
# src/orchestration/watcher.py
# Use watchfiles library
# Watch for: state.json changes, .done.* files
# Implement DebouncedWatcher from docs
```

### [B2] logging.py

```python
# src/orchestration/logging.py
# Implement JSONLogHandler from docs/orchestration.md
# Implement setup_logging(workspace: Path)
# Create events and errors loggers
```

### [B3] locking.py

```python
# src/workspace/locking.py
# Implement file locking with timeout
# Use fcntl on Unix, msvcrt on Windows
# Context manager interface
```

### [L1] models

```python
# src/models/state.py
from pydantic import BaseModel
from enum import Enum
from datetime import datetime

class Status(str, Enum):
    TASK_CREATED = "task_created"
    # ... all statuses

class WorkerStatus(BaseModel):
    status: str  # running, completed, failed
    current_task: str | None
    started_at: datetime | None

class State(BaseModel):
    task_id: str
    status: Status
    # ... full state model matching workspace.md
```

---

## Coordination Rules

1. **Don't edit files you don't own** - If you need something from another file, write to blockers.md
2. **Keep imports clean** - Use relative imports within packages
3. **Match the docs** - The architecture docs are the spec, follow them
4. **Type everything** - Full type hints, Reviewer will check
5. **No circular imports** - If you hit one, write to blockers.md

## Starting Instructions

### For Worker A (Instance 2):
```
Read this file (SPRINT.md) and docs/orchestration.md.
Start with task [A1] - create src/config/settings.py.
When done, update workspace/build/status.md and move to [A2].
```

### For Worker B (Instance 3):
```
Read this file (SPRINT.md) and docs/workspace.md.
Start with task [B1] - create src/orchestration/watcher.py.
When done, update workspace/build/status.md and move to [B2].
```

### For Reviewer (Instance 4):
```
Read this file (SPRINT.md) and all role files in roles/.
Watch for status.md updates.
When a task is marked done, review it and write feedback to workspace/build/reviews/.
Run: mypy src/ and python -c "import src" to verify.
```

---

## Status Tracking

### Phase 1 Status

| Task | Assignee | Status | Review |
|------|----------|--------|--------|
| A1 - settings.py | Worker A | pending | - |
| A2 - spawner.py | Worker A | pending | - |
| A3 - state_machine.py | Worker A | pending | - |
| B1 - watcher.py | Worker B | pending | - |
| B2 - logging.py | Worker B | pending | - |
| B3 - locking.py | Worker B | pending | - |
| L1 - models | Lead | pending | - |
| L2 - main.py stub | Lead | pending | - |
| L3 - integration | Lead | pending | - |

*Update this table as tasks complete*
