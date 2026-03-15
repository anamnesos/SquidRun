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
- **Trigger:** Synchronous post-task event (e.g., Architect task completion, specific `[ACK REQUIRED]` failure signals).
- **Mechanism (ReasoningBank Induction):** The system performs a lightweight extraction on the immediate session trajectory, judging success/fail and drafting a provisional heuristic (title, description, transferable strategy).
- **Storage:** Stored in `cognitive-memory.db` with low `confidence_score` and explicit trace provenance.
- **Decay:** Fully susceptible to standard time-decay.

### Tier 2: Durable (Sleep)
- **Trigger:** Asynchronous background cycle (Sleep Consolidator during idle periods).
- **Mechanism (Contrastive Extraction):** The Consolidator compares multiple trajectories across sessions (successes vs. failures) to merge duplicates, discard false patterns, and generalize the heuristic. 
- **Storage:** The `confidence_score` and `salience_score` are raised. `edges` are formed between related heuristics.
- **Decay:** Slower decay curve due to high salience, but still eligible for eventual archival if unused.

### Tier 3: Immune (Protected)
- **Trigger:** Proven heuristics reaching a confidence threshold, OR explicit manual designation (e.g., user preferences, core project invariants).
- **Mechanism (RLM Immunity):** The node is granted the `is_immune` flag.
- **Storage:** Flagged `is_immune = 1`. 
- **Decay:** **Bypasses all decay and archival logic.** Always available for semantic routing.

## Schema Additions

### Cognitive DB (`nodes` table)
To implement the RLM immunity layer, the `nodes` schema requires a new column:
- `is_immune INTEGER DEFAULT 0`
  - `0`: Standard node, subject to time-decay and archival based on `last_accessed_at` and `salience_score`.
  - `1`: Immune node. Exempt from all decay processes.

## Integration & Implementation

1. **Trigger Events for Immediate Induction:** 
   - Hook into the main IPC bus or Event Kernel for task completion signals. When a task ends (especially one marked with errors), invoke the lightweight extractor model.
2. **Contrastive Extraction (Sleep Consolidator):**
   - Update `ui/modules/cognitive-memory-sleep.js`. Add a clustering pass that specifically targets Tier 1 provisional nodes and recent Evidence Ledger error traces. It must prompt the model to "Compare this failure to this success. Extract the underlying rule."
3. **Decay Logic Update:**
   - Update `ui/modules/memory-ingest/lifecycle.js`. Add a guard clause: `WHERE is_immune = 0` to all queries that mark nodes as `expired` or `archived`.
