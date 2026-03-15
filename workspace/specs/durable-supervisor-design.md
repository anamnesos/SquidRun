# Durable Supervisor & Background Task Queue Design

## Goal
Implement a durable supervisor service that manages background agents (like Builder's `builder-bg-1..3`), persists state across crashes or restarts, and allows James to drop tasks and walk away.

## Architecture

### 1. Process Host (User Session Daemon)
To achieve true background durability on Windows without requiring the UI to stay open, the supervisor must run in the background.
- **Problem with Windows Services:** Services run in Session 0, which isolates them from user-scoped authentication (GitHub tokens, browser session data, `~/.codex/auth.json`, etc.).
- **Resolution:** The supervisor will run as a background daemon within James's user session. We will use a **Windows Scheduled Task** triggered at user logon (or a tool like PM2 installed globally and run under the user) to ensure it stays alive and restarts automatically, while retaining full access to user credentials and GUI capabilities if needed.

### 2. Durability Layer (State Machine Pattern)
We need an immutable ledger of state. If the supervisor or an agent crashes, it must resume exactly where it left off.
- **Storage:** We will use a dedicated **SQLite** database (`.squidrun/runtime/supervisor.sqlite`).
- **Mechanism:** Before an agent starts a step, the supervisor logs `Task N: State=Running`. When the agent finishes, it logs `Task N: State=Complete, Result=...`.
- **Recovery:** On startup, the supervisor queries SQLite for any tasks stuck in `Running` or `Pending` and re-queues them. This acts as a "Checkpointer" (similar to LangGraph).
- **Resume Semantics:** Resuming applies *only* to background jobs (requeuing or continuing async work). The supervisor will not attempt to resurrect interactive terminal UI panes.

### 3. Supervisor <-> Agent Communication
- **Core Transport:** The SQLite database serves as the execution backbone. The supervisor writes to the queue, and worker agents poll the queue (or receive direct IPC signals if spawned as child processes). 
- **Decoupling from UI:** The supervisor **must not** depend on SquidRun's WebSocket bus for core execution. The WebSocket bus is strictly for broadcasting status updates to the UI. If the UI is closed, the supervisor continues operating purely via SQLite and process management.
- **Idempotency:** Agents must be designed to safely retry a step if interrupted (e.g., they check if a file exists before writing).

### 4. Background Task Queue Structure
The `supervisor_tasks` table in SQLite will track the lifecycle of all jobs:
- `task_id` (Text PRIMARY KEY)
- `objective` (Text)
- `status` (Text - pending | running | complete | failed | blocked | canceled)
- `owner_pane` (Text - e.g., builder-bg-1)
- `priority` (Integer - higher means run first)
- `attempt_count` (Integer)
- `lease_owner` (Text)
- `lease_expires_at_ms` (Integer - timestamp used as a heartbeat)
- `worker_pid` (Integer)
- `context_snapshot_json` (Text - necessary state to resume)
- `result_payload_json` (Text - output of success)
- `error_payload_json` (Text - output of failure)
- `created_at_ms`, `updated_at_ms`, `started_at_ms`, `completed_at_ms`, `last_heartbeat_at_ms`

A companion `supervisor_task_events` table tracks granular state changes:
- `event_id` (Text PRIMARY KEY)
- `task_id` (Text)
- `event_type` (Text)
- `payload_json` (Text)
- `created_at_ms` (Integer)

## Implementation Steps for Builder
1. **Schema:** Create the SQLite tables for the Task Queue with the expanded schema.
2. **Supervisor Daemon:** Create a standalone Node script that polls this queue, manages worker processes, and operates entirely independently of the WebSocket UI bus.
3. **Daemon Persistence:** Add a script to install the supervisor as a User Logon Scheduled Task (or PM2 user service) to bypass the Session 0 problem.
4. **Agent Integration:** Update Builder's auto-spawning logic to insert tasks into this queue rather than just starting a process directly in memory.