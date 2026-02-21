# Background Builder Agents Specification

**Status:** Implemented (Stages 1-3)  
**Owner:** Oracle  
**Scope:** Runtime behavior for Background Builder Agents and related operator guidance

This document captures landed behavior only.

---

## 1. Commit Anchors (Source of Truth)

| Stage | Commit Hash | Date (UTC) | Author | Notes |
|-------|-------------|------------|--------|-------|
| Stage 1 | `365099bd6547e264bc23e5a3804b8d7570f08b8c` | `2026-02-19T06:50:43Z` | Core team | Core runtime plumbing: manager, daemon spawn/options, alias routing, WS send path, owner binding, watchdog |
| Stage 2/3 | `dcb91aaa55fb3297f76e6095c0a39699abf49412` | `2026-02-19T07:15:43Z` | Core team | Builder control surface (`hm-bg`), WS `background-agent` actions, bg target-health alias recognition, UI/recovery side-effect suppression for bg panes, orphan-on-sync hard kill |

---

## 2. Architecture Overview

### 2.1 Components

| Component | File(s) | Responsibility | Status |
|-----------|---------|----------------|--------|
| Background Agent Manager | `ui/modules/main/background-agent-manager.js` | Alias/slot allocation, spawn, direct daemon writes, owner binding, watchdog, cleanup orchestration | Implemented (Stage 1) |
| Terminal Daemon Integration | `ui/terminal-daemon.js` | Per-terminal `scrollbackMaxSize` option used for headless background agents | Implemented (Stage 1) |
| Daemon Client Integration | `ui/daemon-client.js` | `spawn(..., spawnOptions)` support and explicit `HIVEMIND_ROLE` override from provided env | Implemented (Stage 1) |
| App/WebSocket Routing | `ui/modules/main/hivemind-app.js` | Target resolution for `builder-bg-*`/`bg-2-*`, WS broker routing, owner-binding guard for background senders, builder-only `background-agent` control actions | Implemented (Stage 1 + 2/3) |
| WebSocket Runtime Health | `ui/modules/websocket-runtime.js` | Health identity resolution for `builder-bg-*` / `bg-2-*` targets (`no_route`/`stale`/`healthy`) | Implemented (Stage 2/3) |
| Builder Control CLI | `ui/scripts/hm-bg.js` | Builder CLI control path for spawn/list/kill/kill-all/map over WS `background-agent` requests | Implemented (Stage 2/3) |
| Target/Alias Source of Truth | `ui/config.js` | Canonical maps, constants, and resolver helpers for background alias <-> synthetic pane IDs | Implemented (Stage 1) |

### 2.2 Data/Control Flow

1. Spawn request reaches `BackgroundAgentManager.spawnAgent()` (owner pane is validated as `2`).
2. Manager allocates available alias slot (`builder-bg-1..3`) and tracks state (`starting`).
3. Manager calls daemon client `spawn()` with env:
`HIVEMIND_ROLE=<builder-bg-N>`, `HIVEMIND_PANE_ID=<bg-2-N>`, `HIVEMIND_PARENT_PANE_ID=2`, `HIVEMIND_BG_ALIAS=<builder-bg-N>`, plus `scrollbackMaxSize`.
4. Manager launches pane-2 CLI command in the spawned PTY and injects startup contract prompt, then retries startup prompt once.
5. WS `send` path resolves target via `resolveTargetToPane()`; background targets route through direct daemon write via manager.
6. Builder control path (`hm-bg`) issues WS `background-agent` action requests (`spawn`, `list`, `kill`, `kill-all`, `target-map`) and app handler enforces builder-only owner binding.
7. Watchdog and daemon event hooks reap stale/orphan/idle agents; session/parent/daemon/app lifecycle hooks call `killAll(...)`.

---

## 3. Target and Alias Routing

Documented from `ui/config.js` + `BackgroundAgentManager.getTargetMap()`.

### 3.1 Canonical Targets

| Input Target | Resolved Runtime Target | Final Pane/Worker ID | Notes |
|--------------|-------------------------|----------------------|-------|
| `builder-bg-1` | `bg-2-1` | `bg-2-1` | Background slot 1 owned by Builder pane `2` |
| `builder-bg-2` | `bg-2-2` | `bg-2-2` | Background slot 2 owned by Builder pane `2` |
| `builder-bg-3` | `bg-2-3` | `bg-2-3` | Background slot 3 owned by Builder pane `2` |

### 3.2 Routing Aliases

| Alias | Resolves To | Rationale | Status |
|-------|-------------|-----------|--------|
| `bg-2-1` | `builder-bg-1` | Synthetic pane identifier canonicalized to external alias when needed | Implemented |
| `bg-2-2` | `builder-bg-2` | Synthetic pane identifier canonicalized to external alias when needed | Implemented |
| `bg-2-3` | `builder-bg-3` | Synthetic pane identifier canonicalized to external alias when needed | Implemented |

---

## 4. Lifecycle Contract

### 4.1 Spawn
- Trigger conditions: manager spawn invoked with owner pane request.
- Capacity limits: max `3` background agents (`BACKGROUND_BUILDER_MAX_AGENTS`).
- Error behavior:
  - Invalid owner -> `owner_binding_violation`
  - At capacity -> `capacity_reached`
  - Requested/available slot missing -> `slot_unavailable`
  - Daemon unavailable/connect fail -> `daemon_missing` / `daemon_connect_failed`

Spawn sequencing:
1. Allocate alias/pane slot.
2. Spawn headless daemon PTY.
3. Start CLI command (pane-2 command, with autonomy flags if enabled).
4. Inject startup contract.
5. Retry startup contract once.

### 4.2 Startup Contract
- Startup briefing inputs: manager prompt injected into PTY.
- Required files/context loaded by prompt:
  - `ROLES.md`
  - runtime model shim (`CLAUDE.md` / `CODEX.md` / `GEMINI.md`)
  - `.squidrun/handoffs/session.md`
  - `.squidrun/app-status.json`
- Required first check-in behavior from prompt:
  - message Builder only via `hm-send` using `--role <builder-bg-N>`
  - do not message Architect directly
  - emit completion sentinel `__HM_BG_DONE__` when delegated task finishes

### 4.3 Communication
- Primary channel(s): WebSocket broker route with direct daemon PTY write for background targets.
- Delivery semantics/ACK handling:
  - background send path returns `status: delivered.daemon_write` on successful daemon write
  - manager-side send rejects non-builder senders with `owner_binding_violation`
  - WS control requests use message type `background-agent` and enforce builder-only sender binding
- Target resolution rules:
  - `resolveTargetToPane()` accepts `builder-bg-*` and synthetic `bg-2-*`
  - background sender (`builder-bg-*`) is blocked from non-builder targets in WS broker path (`owner_binding_violation`)
  - comms journaling normalizes target role to background alias when applicable

### 4.4 Auto-Kill and Reaping
- Idle timeout rules:
  - idle TTL watchdog kills agents with `reason: idle_ttl_expired`
  - defaults: TTL `20m`, watchdog tick `15s` (env-overridable)
- Completion-triggered termination:
  - daemon output containing `__HM_BG_DONE__` or `[BG_TASK_COMPLETE]` triggers kill with `reason: task_completed`
- Reaping/orphan handling:
  - daemon sync hard-kills orphan live background panes not tracked by manager (`reason: orphan_on_sync`)
  - daemon sync removes stale tracked agents not present in live terminals
  - watchdog removes orphaned agents missing live terminal presence
- Manual termination path:
  - `killAgent(target, { reason })`
  - `killAll({ reason })`

### 4.5 Session Rollover Cleanup
- Session scope changes:
  - `handleSessionScopeChange(newScope)` compares previous scope and triggers `killAll({ reason: 'session_rollover' })` when changed.
  - app startup session initialization calls this scope-change handler.
- Parent/daemon/app lifecycle cleanup:
  - parent builder exit -> `killAll({ reason: 'parent_builder_exit' })`
  - parent builder killed -> `killAll({ reason: 'parent_builder_killed' })`
  - daemon disconnect -> `killAll({ reason: 'daemon_disconnected' })`
  - app shutdown -> `killAll({ reason: 'app_shutdown' })`

---

## 5. Operational Guidance

Builder expectation (runtime policy):
- Builder is expected to decompose heavy/multi-file tasks and delegate to background builders instead of running all work serially in one context.

### 5.1 Agent Usage
- Address background builders:
  - `node ui/scripts/hm-send.js builder-bg-1 "(BUILDER #N): ..."`
  - `node ui/scripts/hm-send.js builder-bg-2 "(BUILDER #N): ..."`
  - `node ui/scripts/hm-send.js builder-bg-3 "(BUILDER #N): ..."`
- Background agent responses should target Builder only and include role alias via `--role builder-bg-N`.
- Builder control surface (`hm-bg`):
  - `node ui/scripts/hm-bg.js spawn`
  - `node ui/scripts/hm-bg.js spawn --slot 2`
  - `node ui/scripts/hm-bg.js list`
  - `node ui/scripts/hm-bg.js kill builder-bg-1`
  - `node ui/scripts/hm-bg.js kill-all`
  - `node ui/scripts/hm-bg.js map`

### 5.2 Failure Modes and Diagnostics
- Known failure signatures:
  - `owner_binding_violation`
  - `capacity_reached`
  - `slot_unavailable`
  - `daemon_not_connected` / `agent_not_running`
  - `invalid_action` (unsupported `background-agent` action)
- First-line checks:
  - app target map from manager state (`background-agents-state`)
  - daemon connectivity + live terminal set
  - session scope change and lifecycle events
  - target health checks for `builder-bg-*` / `bg-2-*` in websocket runtime (`healthy`, `stale`, `no_route`)
- Escalation path:
  - Builder owns runtime fixes
  - Oracle updates docs and restart-risk notes

---

## 6. Validation Evidence

| Command | Scope | Result | Evidence |
|---------|-------|--------|----------|
| `npm test -- --runInBand` | Full Jest suite | Passed (`161` suites, `3202` tests) | Builder report at Stage 1 handoff |
| Pre-commit Jest gate (`--silent`) | Commit gate | Passed | Builder report at Stage 1 handoff |
| `npm test -- --runInBand` | Full Jest suite | Passed (`162` suites, `3210` tests) | Builder report at Stage 2/3 handoff |
| Pre-commit Jest gate (`--silent`) | Commit gate | Passed | Builder report at Stage 2/3 handoff |

---

## 7. Follow-up Doc Sync Checklist

Updated for Stages 1-3:
- `docs/protocol-spec.md` (target routing, owner-binding semantics, background control path, and health semantics)
- `docs/triggers.md` (hm-send background targets, fallback caveat, and hm-bg control references)
- `docs/models/base-instructions.md` (background targets + owner-binding guidance)
- `ROLES.md` (Builder responsibilities now include mandatory heavy-task delegation to bg builders)
