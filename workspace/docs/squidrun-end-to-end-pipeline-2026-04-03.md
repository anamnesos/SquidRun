# SquidRun End-to-End Pipeline Map

Date: 2026-04-03
Author lane: Builder
Purpose: map the actual runtime pipeline end-to-end before further fixes.

## 1. Inbound Message Path

### External / transport entrypoints
- Agent and system messages usually enter through `ui/scripts/hm-send.js`.
- `hm-send.js` normalizes the outbound envelope with `ui/modules/comms/message-envelope.js`.
- Delivery then goes over WebSocket / bridge / trigger fallback into `ui/modules/main/squidrun-app.js`.
- User-facing channels like Telegram and SMS ultimately route back into the same main-process delivery system, even if they originate from different pollers / channel handlers.

### Main process routing
- `ui/modules/main/squidrun-app.js` is the message router.
- For `send` messages it:
  - builds a canonical envelope
  - appends current-project context with `withProjectContext(...)`
  - journals the message into Evidence Ledger comms
  - routes to a pane through triggers, direct daemon write, or special channel routing
- Pane delivery ultimately lands through `inject-message` / terminal injection paths.

### What exists
- Canonical envelope normalization
- Comms journal persistence
- Pane routing with delivery tracking
- Current-project context injection

### What is not unified yet
- There is no single "message arrived -> recall top memories from all stores -> prepend to message" stage.
- Memory-aware delivery exists in pieces, but not as one universal pre-delivery pipeline.

## 2. Agent Startup / Context Path

### Claude hook path
- `.claude/hooks/session-start.sh` runs on session start / resume / compact.
- It injects:
  - mandatory file reads
  - startup transcript context from `ui/scripts/hm-startup-transcript-context.js`
  - agency-layer context from `ui/scripts/hm-hook-injection.js`
- This is hook-level `additionalContext`, not pane-message injection.

### Renderer startup injection
- `ui/modules/terminal.js` waits for CLI readiness, then injects a startup identity message.
- That startup identity currently includes:
  - startup health summary from `.squidrun/build/startup-health.md`
  - cognitive summary from `hm-memory-api.js retrieve ...`

### What exists
- Static startup doctrine
- Recent transcript / file-based startup context
- Cognitive-memory startup summary

### What is not unified yet
- Startup does not query all four stores together.
- Hook startup and renderer startup are separate context systems.

## 3. Memory Layers

### Tier A: Knowledge / file memory
- Source: `workspace/knowledge/*`, case docs, startup handoffs, evidence folders now indexed by memory search.
- Retrieval surface: `ui/modules/memory-search.js`.
- This is the broadest retrieval layer and includes evidence-folder indexing.

### Tier B: Evidence Ledger
- Source of truth for comms and session/runtime events.
- Main store: `ui/modules/main/evidence-ledger-store.js`.
- Important tables / uses:
  - `comms_journal`
  - ledger events
  - session snapshots / decisions
- Current role in pipeline:
  - immediate journaling of messages
  - consultation response collection reads from comms journal
  - sleep extraction reads episodes from ledger-backed sources

### Tier C: Team Memory
- Runtime: `ui/modules/team-memory/runtime.js`
- Main capabilities:
  - claims
  - decisions / consensus
  - patterns / guards
  - memory-ingest
  - delivery service / proactive injections
- Current role in pipeline:
  - structured claim store
  - guard evaluation
  - periodic tagged-claim extraction from comms

### Tier D: Cognitive Memory
- Store: `workspace/memory/cognitive-memory.db`
- API: `ui/modules/cognitive-memory-api.js`
- Important fact:
  - `retrieve()` already seeds from `memory-search` before ranking existing cognitive nodes
- Current role in pipeline:
  - semantic retrieval
  - sleep-cycle consolidation target
  - long-term ranked memory nodes

## 4. Memory Save / Consolidation Path

### Immediate save
- Messages are journaled immediately into Evidence Ledger from the main app send path.

### Structured extraction
- Team-memory tagged claim extraction runs periodically from comms.
- That turns some comms into structured claims, but only through the team-memory path.

### Sleep consolidation
- Supervisor runs `SleepConsolidator` from `ui/modules/cognitive-memory-sleep.js`.
- Sleep extracts episodes, runs extraction, clusters candidates, and writes into cognitive memory / promotion flow.
- Sleep extraction is now Claude-backed, not Ollama-backed.

### Health / drift
- Supervisor also runs memory-consistency audits and memory-ingest lifecycle maintenance.

### What exists
- Immediate journaling
- Periodic team-memory extraction
- Periodic cognitive-memory sleep consolidation

### What is still fragmented
- The save path is coherent enough.
- The recall path is not: the four stores are persisted, but retrieval is still split by subsystem.

## 5. Current Recall Reality

### Today
- Startup recall:
  - file doctrine
  - transcript context
  - cognitive retrieve
- Message-time recall:
  - mostly none, outside of special-purpose guard / delivery logic
- Search:
  - `memory-search` can search knowledge plus evidence folders
  - cognitive retrieve can seed from memory-search
  - team memory and evidence ledger each have their own query surfaces

### Core gap
- There is no single recall broker that merges:
  - evidence ledger
  - team memory
  - memory search
  - cognitive memory
- That is why the system has memory pieces but not one coherent "James/Eunbyeol context comes in -> best relevant memories appear" behavior.

## 6. Agent Response Path

### Outbound response
- Agents reply through `hm-send.js`.
- The message is re-enveloped, journaled, and routed through the same main-process comms path.

### Response persistence
- Evidence Ledger comms journal gets the response immediately.
- Consultation collection later reads those responses back out of comms journal by sender role and request id.
- Transcript indexing and memory extraction happen after the fact, not inline with response generation.

### What exists
- Strong immediate journaling
- Response collection by request id

### Missing
- Inline post-response promotion from one universal memory service
- Unified "response saved and immediately recallable from all stores" path

## 7. Trading Consultation Pipeline

### Scheduler / supervisor
- `ui/supervisor-daemon.js` is the runtime orchestrator.
- It runs:
  - scheduled crypto consensus cycles
  - 5-minute Hyperliquid monitor cycles
  - sleep cycles
  - memory audits
  - other market loops

### Consensus flow
- Supervisor crypto phase:
  1. assess macro risk
  2. clear old signals
  3. run pre-market/data gathering
  4. call `runConsensusRound(...)` in `ui/modules/trading/orchestrator.js`
- `runConsensusRound(...)`:
  1. resolves symbols / universe
  2. ingests market context
  3. builds event veto
  4. builds consultation request JSON
  5. dispatches prompts to agents through `consultation-store.js`
  6. collects responses from comms journal
  7. evaluates consensus
  8. sizes with `consensus-sizer`
  9. risk-checks
  10. optionally auto-executes

### What exists
- End-to-end consultation request / response loop
- Responses are grounded in saved request JSON artifacts
- Consensus and sizing are real runtime steps, not just chat decisions

### Missing / weak
- Position management is still not a first-class consultation lane in the live loop.
- Open-position strategic management is weaker than new-entry scanning.

## 8. Execution Pipeline

### Auto-execution
- Hyperliquid auto-exec is in `orchestrator.maybeAutoExecuteLiveConsensus(...)`.
- It:
  - filters for actionable crypto consensus
  - checks confidence threshold
  - maps approved risk sizing to CLI args
  - calls `hm-defi-execute.js` or `hm-defi-close.js`
  - persists stop state into `defi-peak-pnl.json` on success

### Script layer
- `ui/scripts/hm-defi-execute.js`
  - builds trade plan
  - places IOC entry
  - re-reads fill state
  - attempts stop / TP placement
- `ui/scripts/hm-defi-close.js`
  - closes existing position

### Runtime monitor
- Supervisor 5-minute monitor:
  - polls Hyperliquid
  - syncs peak PnL state
  - enforces stop / giveback / liquidation-close logic
  - alerts via Telegram

### What exists
- Consensus can reach execution
- Stop state persists outside the immediate script
- Monitor can auto-close risk breaches

### Missing / weak
- Live canary / full venue rehearsal confidence is still below focused-test confidence.
- Position management consultation is not yet the main strategic owner of open trades.

## 9. Autosmoke Path

### Intended path
- Builder messages can trigger autonomous smoke.
- `ui/modules/main/squidrun-app.js` launches `ui/scripts/hm-smoke-runner.js`.
- Runner writes `summary.json` and emits structured JSON.
- App parses structured JSON and reports summary back to Architect.

### Current architectural reality
- Repo code already has suppression for no-JSON runner output.
- If `invalid_summary` is still appearing every cycle, the likely issue is runtime/version split:
  - old app process still running old autosmoke code
  - or a caller path still expecting pure stdout JSON instead of tolerant parsing

## 10. System-Level Truth Right Now

### What is genuinely coherent
- Message transport and journaling
- Consultation request / response / consensus flow
- Hyperliquid execution and monitor rails
- Sleep-based cognitive consolidation

### What is only partially coherent
- Memory as a whole
  - storage exists
  - save paths exist
  - retrieval is fragmented

### What is the main design gap
- SquidRun does not yet have one central recall broker.
- That missing broker is the same reason:
  - James/Eunbyeol messages do not automatically bring in the right memory bundle
  - startup, search, team memory, and cognitive memory feel like separate systems
  - fixes keep happening per subsystem instead of through one end-to-end contract

## 11. Builder Recommendation Before More Patches

Design the next pass around two explicit contracts:

1. `recall(query, context)` contract
- one function
- four backends
- one ranked merged result
- reusable from startup hooks, inbound messages, and agent tools

2. `position_management` contract
- one consultation type for live positions
- separate from new-entry scanning
- same request/response/journal/consensus discipline as new-signal flow

Without those two contracts, we will keep fixing symptoms in the local subsystem instead of upgrading SquidRun as one system.
