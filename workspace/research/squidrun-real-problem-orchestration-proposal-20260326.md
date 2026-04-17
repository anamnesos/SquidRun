# SquidRun Real-Problem Orchestration Proposal

Date: 2026-03-26
Author: Oracle
Purpose: executable product/system changes from the 은별 session

## Diagnosis from this session

The system already has a lot of the plumbing:

- `ui/modules/task-parser.js`
- `ui/modules/smart-routing.js`
- `ui/modules/main/comms-journal.js`
- `ui/modules/main/auto-handoff-materializer.js`
- `ui/modules/team-memory/*`

But the product behavior is still wrong for real-world users because:

1. High-stakes problem intake is not a first-class object.
2. Cross-checking is optional and manual.
3. Agents communicate as raw chat messages, not structured work threads.
4. Restart continuity is log-centric, not case-centric.
5. The system does not automatically tell the user what SquidRun can do next.

## What should change

## 1. Add a first-class `problem intake` pipeline

### Goal

When a user describes a real legal / financial / medical / business problem, SquidRun should automatically switch into a different operating mode.

### Build

Add a new module:

- `ui/modules/problem-intake.js`

Add a new runtime state file:

- `.squidrun/runtime/problem-intakes.json`

Each intake should have:

- `problem_id`
- `source` (`telegram`, `pane`, `manual`)
- `domain` (`legal`, `financial`, `medical`, `business`, `consumer`, `general`)
- `stakes` (`low`, `medium`, `high`)
- `entities`
- `deadlines`
- `requested_help`
- `documents_needed`
- `actions_we_can_do`
- `verification_required`
- `status`

### Trigger rule

Extend `task-parser.js` and `smart-routing.js` to detect:

- real-world distress language
- official institutions / laws / deadlines / money / health terms
- user messages that describe a situation rather than a code task

If `stakes=high`, automatically create a structured intake.

## 2. Add a mandatory cross-verification state machine

### Goal

Architect should not need James to say “cross-check this.”

### Build

Add a new orchestrator:

- `ui/modules/main/problem-orchestrator.js`

State machine:

1. `intake_created`
2. `architect_first_pass`
3. `oracle_independent_review`
4. `disagreement_check`
5. `capability_plan`
6. `user_ready`

### Policy

For `stakes=high`:

- Architect must produce first-pass framing.
- Oracle must produce independent review before user-ready.
- If disagreement exists on:
  - deadlines
  - responsible entities
  - legal theory
  - risk severity
  then system marks `requires_resolution=true`.

Architect can override, but must record an override reason.

## 3. Replace raw agent chat with structured work threads

### Problem

Current messaging works, but too much important coordination is hidden in freeform text.

The logs also show repeated:

- `No connected client for target`
- fallback routing through InjectIPC

That is good as a transport fallback, but weak as a collaboration model.

### Build

Add thread/task envelope metadata to inter-agent messages:

- `thread_id`
- `problem_id`
- `task_id`
- `message_type` (`task`, `finding`, `risk`, `decision`, `question`, `ack`)
- `requires_response`
- `due_at`
- `reply_to`

Implementation path:

- extend metadata passed through `hm-send.js`
- persist it in `comms-journal`
- add a mailbox/thread view in UI

### Why this matters

Then Architect can ask Oracle for:

- `message_type=verification`
- `problem_id=legal-20260326-001`
- `requires_response=true`

and the runtime can track whether verification actually happened.

## 4. Add an automatic “what we can do for you” planner

### Goal

Users like 은별 should not have to guess the system’s capabilities.

### Build

Add:

- `ui/modules/capability-planner.js`

Given a structured intake, generate:

- `research_actions`
- `document_actions`
- `evidence_actions`
- `outreach_actions`
- `watchlist_actions`
- `cannot_do`

Example output:

- “We can draft a complaint checklist.”
- “We can identify deadlines and laws.”
- “We can search for victim groups.”
- “We cannot file a lawsuit for you.”

### UX rule

For high-stakes intakes, SquidRun should proactively show this block before the user asks.

## 5. Replace “memory continuity” with `active case continuity`

### Problem

The current system already materializes `.squidrun/handoffs/session.md`, but in this session:

- the `Decision Digest` was empty
- `Pending Deliveries` were noisy with test artifacts
- continuity remained log-oriented instead of case-oriented

That matches James’s complaint: restart happens, agents ask what’s going on.

### Build

Add:

- `.squidrun/runtime/active-cases.json`

Each active case:

- `problem_id`
- `title`
- `owner_role`
- `participants`
- `last_meaningful_update`
- `open_questions`
- `next_actions`
- `blocked_on`
- `documents`
- `user_summary`

### Startup behavior

On restart:

- each pane reads `active-cases.json`
- each pane filters to its assigned/open items
- startup prompt includes:
  - current active cases
  - unresolved questions
  - next actions for this role

This should be driven by case state, not just session summary prose.

## 6. Add high-stakes checklists as system guards

### Goal

Normal users should get “what are we missing?” automatically.

### Build

Encode domain-specific checklists in team-memory guards, not just prompts.

Examples:

#### Legal intake guard

Must extract:

- counterparties
- deadlines / limitation periods
- signed documents
- official notices received
- strongest adverse scenario
- strongest user-side theory
- strongest defense-side theory
- what evidence is missing

#### Financial intake guard

Must extract:

- current positions / debts / cash
- counterparty and creditor map
- default / liquidation / margin timelines
- official programs / relief options
- what happens if user does nothing

### Implementation

Use existing team-memory guard machinery:

- `ui/modules/team-memory/guards.js`
- `ui/modules/ipc/team-memory-handlers.js`

Add `problem-domain guards` that can fail a case from moving to `user_ready`.

## 7. Add disagreement capture, not just final consensus

### Problem

The blind spots in the 은별 case were only found because James manually pushed for pushback.

### Build

Add a `disagreement record` object:

- `problem_id`
- `issue`
- `architect_position`
- `oracle_position`
- `resolution`
- `resolution_basis`

Persist in:

- `.squidrun/runtime/problem-disagreements.json`

### UX

If the agents disagree, Architect sees:

- “Here is the unresolved disagreement”
- “Here is the evidence behind each side”

This makes the system stronger than a single polished answer.

## 8. Make complaint/research/document execution first-class

### Goal

Shift from advice-only to action-partner behavior.

### Build

When `problem intake` is created, attach executable action slots:

- `draft_document`
- `collect_evidence`
- `search_for_groups`
- `build_watchlist`
- `generate_form_checklist`
- `prepare_contact_sheet`

This should feed Builder and Oracle automatically.

Example:

- Oracle: research laws, rulings, entities, deadlines
- Builder: produce form packets, complaint templates, evidence index, trackers

## 9. Improve inter-pane communication reliability and visibility

### Problem

Transport works, but collaboration still feels lossy and opaque.

### Build

Add UI surfaces for:

- open agent threads
- awaiting responses
- overdue verification
- unresolved disagreement
- active case owners

### Specific code hooks

- `ui/modules/main/comms-journal.js`
- `ui/modules/main/auto-handoff-materializer.js`
- bridge / transport tabs in UI

## 10. Metrics that tell us if this is actually better

Track:

- `% of high-stakes intakes auto-cross-checked`
- `% of high-stakes replies with explicit deadlines extracted`
- `% with “what we can do” block included`
- `% of restarts where agent resumes active case without asking for context`
- `time from intake -> first actionable plan`
- `number of architect replies later corrected by Oracle`

## Recommended implementation order

## Phase 1: no-model-change, orchestration-only

- add `problem intake` detector
- add `problem-orchestrator` state machine
- make Oracle verification mandatory for high-stakes domains
- add `actions_we_can_do` generation

This alone would have changed the 은별 session.

## Phase 2: continuity

- add `active-cases.json`
- startup resume from active cases
- reduce handoff noise by filtering test / transport artifacts from session materializer

## Phase 3: structured collaboration

- add thread/task metadata to comms
- add disagreement records
- add UI mailbox / pending verification view

## Phase 4: domain guards

- legal / financial / medical intake guards
- block `user_ready` until checklist satisfied or overridden

## Concrete product rule I would ship

If a user describes a high-stakes real-world problem, SquidRun should automatically do all of this:

1. create a structured problem intake
2. route first pass to Architect
3. route independent verification to Oracle
4. compare results for blind spots
5. generate “here’s what we can do for you now”
6. persist the case so a restart can resume it

That is the behavior difference James is asking for.
