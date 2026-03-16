# Memory Immune System & Reasoning Bank Architecture

## Vision
To evolve the Cognitive Memory OS from a passive indexed cache into an active, learning entity. By blending the extraction mechanics of **ReasoningBank** with the **Recursive Learning Model (RLM)** immunity layer, SquidRun will automatically mine its own failures for reusable heuristics and protect critical knowledge from context decay.

## Theoretical Foundation
1. **The Antigens (Evidence Ledger):** The fast-learning episodic buffer (Hippocampus) that records all successes and failures in real-time.
2. **The Antibodies (ReasoningBank):** Heuristics and procedural rules minted from analyzing the antigens.
3. **The Immune System (RLM):** A protection layer in the Neocortex (Cognitive DB) that prevents core identity, user preferences, and proven antibodies from being archived or decayed.

## The Three-Tier Promotion Ladder
Memories move through a three-stage lifecycle, gaining stability and protection as they prove useful.

### Tier 1: Provisional (Immediate)
- **Trigger:** Synchronous completion events. Specifically: the existing `completion-detected` path in the Architect's workflow, and background agent `supervisor_tasks` moving to `complete` or `failed`.
- **Mechanism (ReasoningBank Induction):** The system performs a lightweight extraction on the immediate session trajectory, judging success/fail and drafting a provisional heuristic (title, description, transferable strategy).
- **Storage:** Candidates are staged into the `memory_pr_queue` via `CognitiveMemoryStore.stageMemoryPRs()`. They are NOT directly inserted as active nodes until reviewed or clustered.
- **Decay:** As staged PRs, they are provisional and do not yet affect active routing.

### Tier 2: Durable (Sleep)
- **Trigger:** Asynchronous background cycle (Sleep Consolidator during idle periods).
- **Mechanism (Contrastive Extraction):** The Consolidator executes a broader episode query layer. It reads `comms_journal` episodes, `supervisor_task_events`, and CI/test outcomes to pair failure trajectories with successful resolutions. It compares these across sessions to merge duplicates, discard false patterns, and finalize the heuristic into an active node.
- **Storage:** Promoted from the PR queue into the `nodes` table. The `confidence_score` and `salience_score` are set based on the frequency of the pattern. `edges` are formed between related heuristics.
- **Decay:** Slower decay curve due to high salience. Subject to standard recency/freshness penalties during retrieval.

### Tier 3: Immune (Protected)
- **Trigger:** Proven heuristics reaching a confidence threshold, OR explicit manual designation (e.g., user preferences, core project invariants).
- **Mechanism (RLM Immunity):** The node is granted the `is_immune` flag.
- **Storage:** Flagged `is_immune = 1`. 
- **Decay:** **Bypasses time-decay at retrieval.** During query execution in `ui/modules/cognitive-memory-api.js`, immune nodes are exempted from the recency multiplier / low-freshness penalty.

## Schema Additions

### Cognitive DB (`nodes` table)
To implement the RLM immunity layer, the `nodes` schema requires a new column:
- `is_immune INTEGER DEFAULT 0`
  - `0`: Standard node, subject to time-decay based on `last_accessed_at`.
  - `1`: Immune node. Exempt from recency penalties.

## Integration & Implementation

1. **Trigger Events for Immediate Induction:** 
   - Hook the extraction logic into `ui/modules/ipc/completion-detection-handlers.js` and `ui/supervisor-daemon.js` (when a task status flips to complete/failed). Send outputs to `CognitiveMemoryStore.stageMemoryPRs`.
2. **Contrastive Extraction Query Layer (Sleep Consolidator):**
   - Update `ui/modules/cognitive-memory-sleep.js`. Expand its data ingestion beyond `comms_journal` to include `supervisor_tasks` and `supervisor_task_events`. Add logic to specifically correlate a failed task trajectory with a subsequent successful task trajectory before prompting the model for a generalized rule.
3. **Decay Logic Update (Retrieval Time):**
   - Update `ui/modules/cognitive-memory-api.js`. In the retrieval scoring loop, if `node.is_immune === 1`, force the recency multiplier to `1.0` (or its equivalent max value), ensuring the node's base vector similarity and salience are never penalized by age.
4. **Memory Consistency Repair Safety:**
   - Update `ui/modules/memory-consistency-check.js`. During repair operations (`collapse_duplicate_hash` or `delete_revision_skew_orphan`), if ANY node in a duplicate group or being merged has `is_immune = 1`, the surviving node MUST inherit `is_immune = 1`. Revision-skew deletion must be blocked if `is_immune = 1` unless the user explicitly confirms.
