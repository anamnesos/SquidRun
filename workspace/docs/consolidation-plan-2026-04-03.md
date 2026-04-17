# SquidRun Consolidation Plan

Generated: 2026-04-03

## Goal

Stop creating parallel systems. Consolidate around modules that already exist and promote them into first-class owners:

1. `ui/modules/trading/position-management.js`
2. `ui/modules/transition-ledger.js`
3. `ui/modules/team-memory/guards.js`
4. `ui/modules/team-memory/patterns.js`

This plan is intentionally a design/ownership pass only. No new implementation is proposed here beyond extending the existing modules above.

## Core Diagnosis

The repo’s main problem is not “too many dead experiments.” It is multiple successful subsystems without a clear owner layer above them.

The most obvious overlap zones are:

- Retrieval and memory recall
- Handoffs and transition accountability
- Delivery/accountability loops
- Telegram routing and proactive notifications
- Trading lifecycle management after entry

The right response is not “replace everything.” It is to assign clearer ownership to the systems that already exist.

## Consolidation Principles

1. Search existing code first.
2. Extend the owner module that is closest to the problem.
3. Reuse persistence/state that already exists.
4. Use Team Memory patterns/guards for boundaries, not one-off custom conditionals.
5. Use transition-ledger for lifecycle accountability, not a separate ad hoc task tracker.
6. Only create a new module when no existing owner can absorb the responsibility cleanly.

## Contract 1: Position Management

### Existing Foundation

- `ui/modules/trading/position-management.js` already exists and already models:
  - `position_management(portfolio_state, market_context, risk_state)`
  - directives like `hold`, `close`, `tighten_stop`, `add`
  - supervisor-risk boundary via `owner: 'supervisor_risk'`
- `ui/modules/trading/orchestrator.js` already imports and uses it:
  - builds `positionManagementContext`
  - injects `taskType: 'position_management'` into consultation payloads
  - executes `close` / `tighten_stop` directives before new-entry logic
- `ui/modules/trading/consultation-store.js` already carries position-management prompts

### Consolidation Direction

Make `position-management.js` the first-class lifecycle owner for open-position reasoning.

It should own:

- Thesis validation for open positions
- Action selection:
  - `hold`
  - `add`
  - `reduce`
  - `close`
  - `tighten_stop`
  - `invalidate_thesis`
- Boundary with supervisor risk loop

It should not own:

- Liquidation emergency exits
- Peak giveback hard-stop automation
- Exchange-level disaster rails

Those remain in the supervisor risk loop.

### Planned Extensions

1. Expand directive vocabulary in `position-management.js`
   - Add `reduce`
   - Add explicit `invalidate_thesis`
   - Add richer rationale/priority encoding

2. Move more post-entry trading logic under `position-management.js`
   - Current orchestrator open/close logic stays
   - Management decisions should flow through the contract first

3. Make consultation decisions subordinate to position-management when a live position exists
   - New-entry scan should not compete with live-position management on the same asset

4. Keep the supervisor risk loop as a separate hard boundary
   - `position-management.js` = strategic owner
   - `supervisor-daemon.js` = emergency owner

## Contract 2: Transition Ledger

### Existing Foundation

- `ui/modules/transition-ledger.js` already provides:
  - first-class transition objects
  - owner leases
  - phase graph
  - verification outcomes
  - fallback policy
- It is already wired into:
  - `ui/modules/terminal.js`
  - IPC handlers
  - main app inspection surfaces
- Current kinds are still narrow and skewed toward message/injection flow

### Consolidation Direction

Repurpose `transition-ledger.js` as the lifecycle/accountability layer for proactive work and follow-up tasks.

Do not build a parallel proactive task tracker first.

Instead, extend transition-ledger kinds/categories so proactive work becomes transitions with:

- owner
- requested time
- due time
- verification evidence
- timeout fallback
- resolution state

### Planned Extensions

1. Add new transition kinds/categories for proactive work
   - `proactive.scan`
   - `followup.check`
   - `followup.draft`
   - `case.review`
   - `market.alert`

2. Represent pending items and follow-up obligations as transitions
   - especially from `case-operations.md`
   - instead of inventing a second pending-items ledger

3. Use transition verification outcomes for accountability
   - `verified` when alert/draft/check was completed
   - `timed_out` when follow-up window passed
   - `deferred` when blocked on user input

4. Keep transition-ledger focused on lifecycle truth
   - not ranking relevance
   - not policy/guard logic
   - not message rendering

## Contract 3: Team Memory Patterns + Guards

### Existing Foundation

- `ui/modules/team-memory/patterns.js` already supports:
  - pattern spool mining
  - pattern frequency/confidence
  - pattern activation
- `ui/modules/team-memory/guards.js` already supports:
  - trigger conditions
  - actions: `warn`, `block`, `suggest`, `escalate`
  - auto-creation from patterns
- `ui/modules/team-memory/daily-integration.js` already emits pattern events around delivery, tasks, session lifecycle, and guard preflight

### Consolidation Direction

Use patterns + guards as proactive boundaries and policy rails.

Do not hardcode more “if this then alert” logic directly into supervisor wherever a reusable pattern/guard can express it.

### Planned Uses

1. Proactive task boundaries
   - if a draft was already created recently, suppress duplicate draft generation
   - if the same alert fired too many times, downgrade or silence it

2. Follow-up escalation logic
   - if a case item stays pending beyond threshold, emit escalation suggestions
   - if the same issue keeps resurfacing, create a guard against repeating the failure

3. Trading/proactive protection boundaries
   - block duplicate news alerts inside a cooldown window
   - escalate when an open-position management item has no acknowledgement path

4. Runtime learning loop
   - pattern spool should capture recurring missed follow-ups, duplicate alerts, and draft churn
   - guards should be the policy expression of those learned risks

## How These Three Owners Fit Together

### Position Management

Owns: what to do with an open position.

### Transition Ledger

Owns: whether a proactive obligation exists, who owns it, and whether it resolved.

### Team Memory Patterns + Guards

Owns: boundary policy, repetition control, escalation, and anti-loop behavior.

### Example Flow

1. Open LINK position exists.
2. `position-management.js` says `tighten_stop` or `reduce`.
3. Transition ledger records the management obligation as a transition.
4. Supervisor/orchestrator executes the action and verifies outcome.
5. Team Memory patterns observe whether this kind of obligation is repeatedly delayed or duplicated.
6. Guards later prevent spam or force escalation when the pattern repeats.

## Immediate Consolidation Order

1. Consolidate position management first
   - extend existing `position-management.js`
   - remove temptation to create a parallel live-position manager

2. Extend transition-ledger next
   - add proactive/follow-up transition kinds
   - reuse it for pending-item tracking and accountability

3. Wire patterns + guards after that
   - use them to shape behavior and reduce repetition
   - not as the primary state container

## Explicit Non-Goals

- Do not create a new proactive-task database first.
- Do not create a second position-management module.
- Do not create a separate guard system outside Team Memory.
- Do not replace transition-ledger with a simpler ad hoc queue.
- Do not treat `case-operations.md` as just static text; it should eventually feed transition truth.

## Recommended Next Build Sequence

### Phase A

Extend `position-management.js` into the full owner for open-position strategic decisions.

### Phase B

Extend `transition-ledger.js` with proactive/follow-up transition kinds and resolution semantics.

### Phase C

Wire Team Memory patterns + guards around those two flows to enforce cooldowns, escalation, and anti-duplication.

## Builder Read

The consolidation target is not “one giant new architecture.” It is:

- one owner for open positions
- one owner for lifecycle accountability
- one owner for proactive boundaries

Those owners already exist in the codebase. The next step is to make them real owners instead of half-integrated assets.
