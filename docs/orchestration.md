# Terminal Orchestration

This document covers how Hivemind spawns and manages Claude Code terminals.

## Overview

The orchestration layer is responsible for:
1. Spawning Claude Code processes with role-specific prompts
2. Monitoring the file system for state changes
3. Determining which agent to run next
4. Managing parallel worker execution
5. Handling timeouts and failures

## Spawning Claude Code

### Basic Invocation

```bash
claude --print \
       --output-format text \
       --system-prompt "[role prompt]" \
       --permission-mode bypassPermissions \
       "[instruction]"
```

Flags explained:
- `--print` / `-p`: Non-interactive mode, prints response and exits
- `--output-format text`: Plain text output (vs JSON or stream-json)
- `--system-prompt`: The agent's role definition
- `--permission-mode bypassPermissions`: Skip permission prompts (critical for automation)
- Final positional argument: The instruction/prompt

**Permission Modes:**
- `default`: Normal permission prompts
- `bypassPermissions`: Skip all permission checks (use in trusted/sandboxed environments)
- `dontAsk`: Deny instead of prompting (safer but agents may fail)
- `acceptEdits`: Auto-accept edit operations only

For Hivemind, use `bypassPermissions` since the review loop catches mistakes.

### From Python

```python
import asyncio
from pathlib import Path

async def spawn_claude(
    role_file: Path,
    instruction: str,
    workspace: Path
) -> tuple[int, str, str]:
    """Spawn Claude Code and wait for completion."""

    role_prompt = role_file.read_text()

    process = await asyncio.create_subprocess_exec(
        "claude",
        "--print",
        "--output-format", "text",
        "--system-prompt", role_prompt,
        "--permission-mode", "bypassPermissions",
        instruction,  # Positional argument, not --message flag
        cwd=workspace,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    stdout, stderr = await process.communicate()

    return process.returncode, stdout.decode(), stderr.decode()
```

### With Timeout

```python
async def spawn_with_timeout(
    role: str,
    instruction: str,
    workspace: Path,
    timeout: int = 300  # 5 minutes
) -> tuple[int, str, str]:
    """Spawn with timeout protection."""

    process = await spawn_claude(role, instruction, workspace)

    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(),
            timeout=timeout
        )
        return process.returncode, stdout.decode(), stderr.decode()

    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise AgentTimeoutError(f"{role} timed out after {timeout}s")
```

## File System Watching

### Using watchfiles

```python
from watchfiles import awatch
from pathlib import Path

async def watch_workspace(workspace: Path, callback):
    """Watch workspace for changes."""

    async for changes in awatch(workspace):
        for change_type, changed_path in changes:
            changed_path = Path(changed_path)

            # Only react to state.json changes
            if changed_path.name == "state.json":
                state = json.loads(changed_path.read_text())
                await callback(state)
```

### Debouncing

Rapid writes can trigger multiple events. Debounce to handle:

```python
import asyncio

class DebouncedWatcher:
    def __init__(self, delay: float = 0.5):
        self.delay = delay
        self.pending = None

    async def on_change(self, state: dict, callback):
        """Debounce state changes."""

        if self.pending:
            self.pending.cancel()

        self.pending = asyncio.create_task(
            self._delayed_callback(state, callback)
        )

    async def _delayed_callback(self, state, callback):
        await asyncio.sleep(self.delay)
        await callback(state)
        self.pending = None
```

## State Machine

### State Transitions

```python
from enum import Enum
from dataclasses import dataclass

class Status(Enum):
    TASK_CREATED = "task_created"
    PLAN_READY = "plan_ready"
    PLAN_APPROVED = "plan_approved"
    REVISION_NEEDED = "revision_needed"
    ASSIGNMENTS_READY = "assignments_ready"
    WORKERS_EXECUTING = "workers_executing"
    CHECKPOINT_REACHED = "checkpoint_reached"
    CHECKPOINT_APPROVED = "checkpoint_approved"
    WORK_COMPLETE = "work_complete"
    COMPLETED = "completed"
    ERROR = "error"

@dataclass
class Transition:
    agent: str
    instruction: str
    parallel: bool = False

TRANSITIONS: dict[Status, Transition] = {
    Status.TASK_CREATED: Transition(
        "orchestrator",
        "Read task.md and create an execution plan in plan.md"
    ),
    Status.PLAN_READY: Transition(
        "reviewer",
        "Review plan.md against task.md requirements"
    ),
    Status.PLAN_APPROVED: Transition(
        "coordinator",
        "Create worker assignments from approved plan"
    ),
    Status.REVISION_NEEDED: Transition(
        "orchestrator",
        "Revise plan.md addressing feedback in reviews/"
    ),
    Status.ASSIGNMENTS_READY: Transition(
        "worker",
        "Execute your assignment",
        parallel=True
    ),
    Status.CHECKPOINT_REACHED: Transition(
        "reviewer",
        "Review checkpoint progress in outputs/"
    ),
    Status.WORK_COMPLETE: Transition(
        "reviewer",
        "Final review of all work in outputs/"
    ),
}
```

### Handling Transitions

```python
class Orchestrator:
    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.terminal = TerminalManager()
        self.active_workers: dict[str, asyncio.subprocess.Process] = {}

    async def handle_state(self, state: dict):
        """React to state changes."""

        status = Status(state.get("status"))

        if status not in TRANSITIONS:
            return

        transition = TRANSITIONS[status]

        if transition.parallel:
            await self.spawn_workers(state)
        else:
            await self.spawn_single(transition)

    async def spawn_single(self, transition: Transition):
        """Spawn a single agent."""

        await self.terminal.spawn_agent(
            role=transition.agent,
            instruction=transition.instruction,
            workspace=self.workspace
        )

    async def spawn_workers(self, state: dict):
        """Spawn multiple workers in parallel."""

        assignments = list((self.workspace / "assignments").glob("worker_*.md"))

        tasks = []
        for assignment in assignments:
            worker_id = assignment.stem  # "worker_1"
            task = self.terminal.spawn_agent(
                role="worker",
                instruction=f"Execute your assignment in {assignment.name}",
                workspace=self.workspace,
                worker_id=worker_id
            )
            tasks.append(task)

        # Run all workers concurrently
        self.active_workers = dict(zip(
            [a.stem for a in assignments],
            await asyncio.gather(*tasks)
        ))
```

## Parallel Worker Management

### Tracking Workers

```python
class WorkerManager:
    def __init__(self):
        self.workers: dict[str, asyncio.subprocess.Process] = {}
        self.results: dict[str, tuple[int, str, str]] = {}

    async def spawn_all(self, assignments: list[Path], workspace: Path):
        """Spawn all workers and track them."""

        for assignment in assignments:
            worker_id = assignment.stem
            process = await spawn_claude(
                Path("roles/worker.md"),
                f"Execute assignment in {assignment.name}",
                workspace
            )
            self.workers[worker_id] = process

    async def wait_all(self) -> dict[str, bool]:
        """Wait for all workers to complete."""

        results = {}
        for worker_id, process in self.workers.items():
            stdout, stderr = await process.communicate()
            results[worker_id] = process.returncode == 0
            self.results[worker_id] = (process.returncode, stdout, stderr)

        return results

    async def wait_any(self) -> str:
        """Wait for any worker to complete, return its ID."""

        done, pending = await asyncio.wait(
            {asyncio.create_task(p.wait()): wid
             for wid, p in self.workers.items()},
            return_when=asyncio.FIRST_COMPLETED
        )

        for task in done:
            return task.get_name()  # worker_id
```

### Handling Worker Completion

```python
async def on_worker_complete(self, worker_id: str, state: dict):
    """Handle a single worker completing."""

    # Update state
    state["workers"][worker_id]["status"] = "completed"

    # Check if all workers done
    all_done = all(
        w["status"] == "completed"
        for w in state["workers"].values()
    )

    if all_done:
        # Check for checkpoint
        if self.checkpoint_reached(state):
            state["status"] = "checkpoint_reached"
        else:
            state["status"] = "work_complete"

    self.write_state(state)
```

## Error Handling

### Timeout Handling

```python
async def spawn_with_retry(
    self,
    role: str,
    instruction: str,
    max_retries: int = 2,
    timeout: int = 300
):
    """Spawn with retry on timeout."""

    for attempt in range(max_retries + 1):
        try:
            return await self.spawn_with_timeout(
                role, instruction, timeout
            )
        except AgentTimeoutError:
            if attempt == max_retries:
                await self.escalate_error(
                    f"{role} timed out after {max_retries + 1} attempts"
                )
                raise
            await asyncio.sleep(5)  # Brief pause before retry
```

### Process Failure

```python
async def handle_failure(self, role: str, returncode: int, stderr: str):
    """Handle agent process failure."""

    error_file = self.workspace / "errors" / f"{role}_{timestamp()}.txt"
    error_file.parent.mkdir(exist_ok=True)
    error_file.write_text(f"Exit code: {returncode}\n\n{stderr}")

    state = self.read_state()
    state["status"] = "error"
    state["error"] = {
        "agent": role,
        "code": returncode,
        "file": str(error_file)
    }
    self.write_state(state)
```

### Stuck Detection

```python
class StuckDetector:
    def __init__(self, threshold: int = 600):  # 10 minutes
        self.threshold = threshold
        self.last_change = time.time()
        self.last_status = None

    def on_state_change(self, state: dict):
        """Track state changes for stuck detection."""

        status = state.get("status")
        if status != self.last_status:
            self.last_change = time.time()
            self.last_status = status

    def is_stuck(self) -> bool:
        """Check if system appears stuck."""

        return time.time() - self.last_change > self.threshold

    async def check_loop(self, escalate_callback):
        """Periodically check for stuck state."""

        while True:
            await asyncio.sleep(60)
            if self.is_stuck():
                await escalate_callback(
                    f"No progress in {self.threshold}s, status: {self.last_status}"
                )
```

## Complete Orchestration Loop

```python
class HivemindOrchestrator:
    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.terminal = TerminalManager()
        self.worker_manager = WorkerManager()
        self.stuck_detector = StuckDetector()

    async def run(self):
        """Main orchestration loop."""

        # Start stuck detection
        asyncio.create_task(
            self.stuck_detector.check_loop(self.escalate)
        )

        # Watch for state changes
        async for changes in awatch(self.workspace):
            for change_type, path in changes:
                if Path(path).name == "state.json":
                    state = json.loads(Path(path).read_text())
                    self.stuck_detector.on_state_change(state)
                    await self.handle_state(state)

    async def handle_state(self, state: dict):
        """Process state change."""

        status = state.get("status")

        try:
            if status == "task_created":
                await self.run_orchestrator()
            elif status == "plan_ready":
                await self.run_reviewer("plan")
            elif status == "plan_approved":
                await self.run_coordinator()
            elif status == "revision_needed":
                await self.run_orchestrator(revision=True)
            elif status == "assignments_ready":
                await self.run_workers(state)
            elif status == "checkpoint_reached":
                await self.run_reviewer("checkpoint")
            elif status == "work_complete":
                await self.run_reviewer("final")
            elif status == "completed":
                await self.notify_complete()

        except AgentTimeoutError as e:
            await self.handle_timeout(e)
        except Exception as e:
            await self.handle_error(e)

    async def escalate(self, message: str):
        """Escalate to human attention."""

        state = self.read_state()
        state["status"] = "needs_attention"
        state["escalation"] = message
        self.write_state(state)

        # Notify via websocket
        await self.notify_escalation(message)
```

## Configuration

```python
# src/config/settings.py

from pydantic_settings import BaseSettings

class OrchestratorSettings(BaseSettings):
    # Timeouts
    agent_timeout: int = 300          # 5 minutes per agent
    worker_timeout: int = 600         # 10 minutes per worker
    stuck_threshold: int = 900        # 15 minutes no progress
    heartbeat_interval: int = 30      # Seconds between heartbeats
    heartbeat_timeout: int = 120      # Seconds before considering hung

    # Limits
    max_workers: int = 3
    max_retries: int = 2
    max_revision_cycles: int = 3

    # Paths
    workspace_path: str = "./workspace"
    roles_path: str = "./roles"
    logs_path: str = "./workspace/logs"

    # Claude Code
    claude_command: str = "claude"
    claude_output_format: str = "text"

    class Config:
        env_file = ".env"
```

## Heartbeat System

Agents write periodic heartbeats to indicate they're alive:

```python
class HeartbeatManager:
    def __init__(self, workspace: Path, interval: int = 30):
        self.workspace = workspace
        self.interval = interval
        self.heartbeats_dir = workspace / "heartbeats"
        self.heartbeats_dir.mkdir(exist_ok=True)

    async def start_heartbeat(self, agent_id: str) -> asyncio.Task:
        """Start heartbeat writer for an agent."""
        async def heartbeat_loop():
            heartbeat_file = self.heartbeats_dir / f"{agent_id}.heartbeat"
            while True:
                heartbeat_file.write_text(str(time.time()))
                await asyncio.sleep(self.interval)

        return asyncio.create_task(heartbeat_loop())

    def check_heartbeat(self, agent_id: str, timeout: int = 120) -> bool:
        """Check if agent heartbeat is fresh."""
        heartbeat_file = self.heartbeats_dir / f"{agent_id}.heartbeat"
        if not heartbeat_file.exists():
            return False

        last_beat = float(heartbeat_file.read_text())
        return (time.time() - last_beat) < timeout

    async def monitor_heartbeats(self, active_agents: list[str], on_stale):
        """Monitor all active agents for stale heartbeats."""
        while active_agents:
            for agent_id in active_agents:
                if not self.check_heartbeat(agent_id):
                    await on_stale(agent_id)
            await asyncio.sleep(30)
```

## Cancellation Flow

```python
class CancellationManager:
    def __init__(self):
        self.processes: dict[str, asyncio.subprocess.Process] = {}

    def register(self, agent_id: str, process: asyncio.subprocess.Process):
        """Register a running process."""
        self.processes[agent_id] = process

    async def cancel_all(self, grace_period: int = 10):
        """Cancel all running agents gracefully."""

        # Send SIGTERM to all
        for agent_id, process in self.processes.items():
            if process.returncode is None:
                process.terminate()
                logging.info(f"Sent SIGTERM to {agent_id}")

        # Wait for graceful shutdown
        await asyncio.sleep(grace_period)

        # Force kill any remaining
        for agent_id, process in self.processes.items():
            if process.returncode is None:
                process.kill()
                logging.warning(f"Sent SIGKILL to {agent_id}")

        # Wait for all to exit
        for process in self.processes.values():
            await process.wait()

        self.processes.clear()

    async def watch_for_cancellation(self, state_file: Path, callback):
        """Watch state.json for cancellation request."""
        while True:
            state = json.loads(state_file.read_text())
            if state.get("status") == "cancelling":
                await callback()
                break
            await asyncio.sleep(1)
```

## Structured Logging

```python
import json
import logging
from datetime import datetime
from pathlib import Path

class JSONLogHandler(logging.Handler):
    def __init__(self, log_file: Path):
        super().__init__()
        self.log_file = log_file
        self.log_file.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, record):
        log_entry = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "level": record.levelname,
            "event": record.getMessage(),
            "logger": record.name,
        }
        if hasattr(record, "agent"):
            log_entry["agent"] = record.agent
        if hasattr(record, "task_id"):
            log_entry["task_id"] = record.task_id
        if hasattr(record, "details"):
            log_entry["details"] = record.details

        with self.log_file.open("a") as f:
            f.write(json.dumps(log_entry) + "\n")

def setup_logging(workspace: Path):
    """Configure structured logging."""
    logs_dir = workspace / "logs"
    logs_dir.mkdir(exist_ok=True)

    # Events log
    events_handler = JSONLogHandler(logs_dir / "events.jsonl")
    events_logger = logging.getLogger("hivemind.events")
    events_logger.addHandler(events_handler)
    events_logger.setLevel(logging.INFO)

    # Errors log
    errors_handler = JSONLogHandler(logs_dir / "errors.jsonl")
    errors_handler.setLevel(logging.ERROR)
    errors_logger = logging.getLogger("hivemind.errors")
    errors_logger.addHandler(errors_handler)

    return events_logger, errors_logger
```

## Agent Output Capture

```python
async def spawn_with_logging(
    role: str,
    instruction: str,
    workspace: Path,
    agent_id: str
) -> tuple[int, str, str]:
    """Spawn agent with full output capture to log files."""

    logs_dir = workspace / "logs" / "agents"
    logs_dir.mkdir(parents=True, exist_ok=True)

    stdout_log = logs_dir / f"{agent_id}.stdout.log"
    stderr_log = logs_dir / f"{agent_id}.stderr.log"

    role_prompt = (workspace.parent / "roles" / f"{role}.md").read_text()

    with stdout_log.open("w") as out, stderr_log.open("w") as err:
        process = await asyncio.create_subprocess_exec(
            "claude",
            "--print",
            "--output-format", "text",
            "--system-prompt", role_prompt,
            "--message", instruction,
            cwd=workspace,
            stdout=out,
            stderr=err,
        )
        await process.wait()

    return (
        process.returncode,
        stdout_log.read_text(),
        stderr_log.read_text()
    )
```
