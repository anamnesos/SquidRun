# Development Guide

## Prerequisites

- Python 3.11+
- Node.js 18+ (for frontend)
- Claude Code CLI installed and authenticated
- Git

## Architecture Overview

Hivemind runs Claude Code instances in background terminals. The Python backend:
1. Manages terminal processes
2. Watches the file system for state changes
3. Triggers the next agent when one completes
4. Serves the frontend API

**Key insight:** We don't wrap Claude's API. We spawn Claude Code processes that do real work.

## Project Structure

```
hivemind/
├── src/
│   ├── api/                  # FastAPI routes
│   │   ├── main.py           # App entry point
│   │   ├── routes/
│   │   │   ├── tasks.py      # Task submission
│   │   │   └── status.py     # Status queries
│   │   └── websocket.py      # Real-time updates
│   │
│   ├── orchestration/        # Core orchestration logic
│   │   ├── terminal.py       # Claude Code process spawning
│   │   ├── watcher.py        # File system monitoring
│   │   ├── state_machine.py  # State transitions
│   │   └── scheduler.py      # Agent scheduling
│   │
│   ├── models/               # Pydantic models
│   │   ├── task.py
│   │   ├── state.py
│   │   └── events.py
│   │
│   └── config/
│       └── settings.py       # App configuration
│
├── roles/                    # Agent role definitions
│   ├── orchestrator.md       # Planning agent prompt
│   ├── coordinator.md        # Assignment agent prompt
│   ├── worker.md             # Execution agent prompt
│   └── reviewer.md           # Review agent prompt
│
├── workspace/                # Shared workspace (created per task)
│   └── .gitkeep
│
├── frontend/                 # React UI
│
├── tests/
├── docs/
├── requirements.txt
├── pyproject.toml
└── .env.example
```

## Initial Setup

### 1. Clone and Enter Project

```bash
cd D:\projects\hivemind
```

### 2. Verify Claude Code

```bash
# Check Claude Code is installed and authenticated
claude --version
claude --help
```

### 3. Create Virtual Environment

```bash
python -m venv venv

# Windows
venv\Scripts\activate

# Unix/Mac
source venv/bin/activate
```

### 4. Install Dependencies

```bash
pip install -r requirements.txt
```

### 5. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:
```
DEBUG=true
LOG_LEVEL=INFO
WORKSPACE_PATH=./workspace
MAX_WORKERS=3
AGENT_TIMEOUT=300
```

### 6. Run the Backend

```bash
python -m uvicorn src.api.main:app --reload --port 8000
```

### 7. Run the Frontend (separate terminal)

```bash
cd frontend
npm install
npm run dev
```

## Core Components

### Terminal Manager

Spawns and manages Claude Code processes:

```python
# src/orchestration/terminal.py

class TerminalManager:
    async def spawn_agent(
        self,
        role: str,           # "orchestrator", "worker", etc.
        instruction: str,    # What to do now
        workspace: Path,     # Working directory
        worker_id: str = None
    ) -> Process:
        """Spawn a Claude Code process with a role."""

        role_prompt = self.load_role(role)

        # Build the command
        cmd = [
            "claude",
            "--print",           # Non-interactive mode
            "--output-format", "text",
            "--system-prompt", role_prompt,
            "--message", instruction,
        ]

        # Spawn process
        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=workspace,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        return process
```

### File System Watcher

Monitors workspace for state changes:

```python
# src/orchestration/watcher.py

class WorkspaceWatcher:
    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.callbacks = {}

    async def watch(self):
        """Watch for file changes and trigger callbacks."""
        async for changes in awatch(self.workspace):
            for change_type, path in changes:
                if path.name == "state.json":
                    await self.on_state_change(path)

    async def on_state_change(self, path: Path):
        """Handle state.json updates."""
        state = json.loads(path.read_text())
        status = state.get("status")

        if status in self.callbacks:
            await self.callbacks[status](state)
```

### State Machine

Determines what happens next:

```python
# src/orchestration/state_machine.py

STATE_TRANSITIONS = {
    "task_created": ("orchestrator", "Create plan from task.md"),
    "plan_ready": ("reviewer", "Review the plan in plan.md"),
    "plan_approved": ("coordinator", "Create worker assignments"),
    "revision_needed": ("orchestrator", "Revise plan based on reviews/"),
    "assignments_ready": ("workers", "Execute assigned subtasks"),
    "checkpoint_reached": ("reviewer", "Review checkpoint progress"),
    "work_complete": ("reviewer", "Final review of all outputs"),
}

async def handle_state_change(state: dict, terminal_manager: TerminalManager):
    """Trigger the appropriate agent based on state."""
    status = state.get("status")

    if status not in STATE_TRANSITIONS:
        return

    agent, instruction = STATE_TRANSITIONS[status]

    if agent == "workers":
        # Spawn multiple workers
        await spawn_workers(state, terminal_manager)
    else:
        await terminal_manager.spawn_agent(agent, instruction)
```

## Development Workflow

### Running Tests

```bash
# All tests
pytest

# Specific module
pytest tests/test_orchestration/

# With coverage
pytest --cov=src
```

### Testing Individual Components

#### Test Terminal Spawning
```python
# tests/test_terminal.py

async def test_spawn_orchestrator():
    manager = TerminalManager()
    process = await manager.spawn_agent(
        role="orchestrator",
        instruction="Read task.md and create a plan",
        workspace=Path("./test_workspace")
    )
    await process.wait()
    assert process.returncode == 0
```

#### Test State Transitions
```python
# tests/test_state_machine.py

def test_plan_ready_triggers_reviewer():
    state = {"status": "plan_ready"}
    agent, instruction = STATE_TRANSITIONS[state["status"]]
    assert agent == "reviewer"
```

### Manual Testing

#### Test a Role Manually
```bash
# Run Claude Code with a role prompt directly
claude --system-prompt "$(cat roles/orchestrator.md)" \
       --message "Create a plan for: Build a hello world API"
```

#### Simulate Full Flow
```bash
# 1. Create test workspace
mkdir test_workspace
cd test_workspace

# 2. Create task file
echo "Build a simple REST API with one GET endpoint" > task.md
echo '{"status": "task_created"}' > state.json

# 3. Run orchestrator manually
claude --system-prompt "$(cat ../roles/orchestrator.md)" \
       --message "Read task.md and create plan.md"

# 4. Check outputs
cat plan.md
cat state.json
```

### Debugging

#### View Process Output
```python
# Enable verbose logging in terminal.py
process = await asyncio.create_subprocess_exec(
    *cmd,
    stdout=asyncio.subprocess.PIPE,
    stderr=asyncio.subprocess.PIPE,
)
stdout, stderr = await process.communicate()
logger.debug(f"Agent output: {stdout.decode()}")
```

#### Inspect Workspace State
```bash
# Watch state changes
watch -n 1 cat workspace/state.json

# View all workspace files
tree workspace/
```

#### Re-run Failed Agent
```bash
# Reset state and re-trigger
echo '{"status": "plan_ready"}' > workspace/state.json
# Watcher will trigger reviewer
```

## Adding a New Agent

### 1. Create Role File

```markdown
# roles/researcher.md

# Researcher

## Identity
You are the Researcher agent in Hivemind.
Your job is to gather information before planning begins.

## Your Process
1. Read task.md
2. Research relevant approaches
3. Write research/findings.md
4. Update state.json: {"status": "research_complete"}
...
```

### 2. Update State Machine

```python
# src/orchestration/state_machine.py

STATE_TRANSITIONS = {
    "task_created": ("researcher", "Research the task"),  # Changed
    "research_complete": ("orchestrator", "Create plan using research"),  # New
    ...
}
```

### 3. Add Tests

```python
async def test_researcher_produces_findings():
    # Setup workspace with task
    # Spawn researcher
    # Assert research/findings.md exists
```

## Code Style

```bash
# Format
black src/ tests/

# Sort imports
isort src/ tests/

# Type check
mypy src/

# Lint
ruff src/ tests/
```

## Common Tasks

### Reset Workspace
```bash
rm -rf workspace/*
echo '{}' > workspace/state.json
```

### View Active Processes
```bash
# List Claude Code processes
ps aux | grep claude
```

### Kill Stuck Agent
```python
# In Python
process.kill()
await process.wait()
```

### Export Task History
```bash
# Copy entire workspace
cp -r workspace/ task_backup_$(date +%Y%m%d)/
```

## Troubleshooting

### Agent Not Spawning
- Check Claude Code is authenticated: `claude --version`
- Verify role file exists: `cat roles/orchestrator.md`
- Check file watcher is running

### Agent Hangs
- Default timeout is 5 minutes
- Check if waiting for user input (shouldn't happen in print mode)
- Kill and retry: `process.kill()`

### State Not Updating
- Verify agent has write permission to workspace
- Check state.json is valid JSON
- Look for errors in agent stderr

### File Watcher Missing Events
- Some editors write to temp file then rename (may miss)
- Ensure atomic writes to state.json
- Consider polling fallback for reliability
