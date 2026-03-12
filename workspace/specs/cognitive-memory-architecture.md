# SquidRun Cognitive Memory Architecture

## Vision
To evolve SquidRun's memory from a passive, file-based storage system into an active, self-healing **Cognitive Memory Operating System**. Inspired by cutting-edge 2026 AI research (MAGMA, EverMemOS, MemEvolve) and biological neuroscience (Predictive Coding, Reconsolidation, Salience Fields), this architecture treats memory not as a database to be queried, but as an autonomous subsystem that continuously restructures itself to better predict the user's needs.

## Architecture Overview: The "Dual-Process" Engine
The system mimics the biological transition from the hippocampus to the neocortex using our existing SQLite and Node.js infrastructure.

1. **The Fast Buffer (Episodic Hippocampus):** 
   - Powered by the existing `evidence-ledger.db`.
   - Captures raw, noisy, chronological interactions, tool outputs, and commands.
2. **The Consolidation Engine (The Supervisor):** 
   - A background Node.js service that runs during system idle times (or "sleep").
   - It reads the Fast Buffer, extracts semantic meaning, detects patterns, and writes to the Slow Graph.
3. **The Slow Graph (Semantic Neocortex):**
   - A multi-graph SQLite database (`cognitive-memory.db`) that stores entities, relationships, temporal causality, and confidence scores.
   - Accessed via a decoupled **Memory as a Service (MaaS)** layer.

---

## The Four Pillars of Cognition

### 1. Memory Reconsolidation (Healing Through Use)
In biology, retrieving a memory makes it temporarily malleable. In SquidRun:
- **Mechanic:** Whenever an agent queries the MaaS for a fact, the service doesn't just return it; it opens a "Reconsolidation Window." If the agent learns new information during that turn that contradicts or refines the retrieved fact, it issues an `UPDATE` payload.
- **Benefit:** The memory graph actively heals and sharpens itself through daily use, preventing the accumulation of stale "zombie" facts.

### 2. Salience Fields (Radiating Importance)
Rather than scoring individual facts in isolation, importance is topological.
- **Mechanic:** If James flags a specific vendor problem as "Critical," the system doesn't just tag that one node. It applies a mathematical "Salience Field" that retroactively boosts the retrieval weight of *adjacent* nodes in the graph (e.g., the API keys for that vendor, the last invoice date).
- **Benefit:** The agent gains "intuition" about what is important to James right now without needing explicit instructions for every related piece of data.

### 3. Transactive Memory (Meta-Knowledge)
A multi-agent team shouldn't duplicate knowledge; it should route it.
- **Mechanic:** The MaaS maintains a `Capabilities` table. The Architect agent doesn't need to load the exact syntax of a ServiceTitan API; it only needs to query the MaaS, which replies: `[Builder-BG-2 holds the highest confidence on ServiceTitan schema]`. The Architect then delegates the task.

### 4. Proactive Pattern Recognition (Sleep Cycles)
- **Mechanic:** During periods of low terminal activity, the Durable Supervisor runs clustering algorithms (e.g., DBSCAN over vector embeddings) on the semantic graph. It looks for unlinked nodes that share high vector similarity and generates a "Memory PR" (a proposed insight).
- **Example:** "James mentioned WC insurance twice this week, and plumbing payroll once. Insight: He may be preparing for a workers comp audit."

---

## Phase Rollout Plan

### Phase 1: The Vector & Decay Foundation
*Laying the groundwork for continuous evaluation.*
- **Deliverables:**
  - Implement `sqlite-vec` index over `workspace/knowledge/`.
  - Add `last_accessed_at` and `access_count` to the schema.
  - Implement the **Time-Decay** penalty in the Reciprocal Rank Fusion (RRF) retrieval query.
  - Create the decoupled MaaS API layer (`hm-memory-api.js`).

### Phase 2: Transactive Meta-Knowledge & The Memory PR
*Structuring how agents share and validate facts.*
- **Deliverables:**
  - Implement the `PreCompress` hook to extract raw facts from dying context windows.
  - Build the Staging Area (`pending-pr.json` / SQLite table) with `confidence_score` and `review_count`.
  - Implement the Transactive Registry: A table tracking which Agent/Pane successfully utilized which domains of knowledge, enabling Architect routing.

### Phase 3: Sleep Consolidation & Proactive Patterning
*Moving from passive storage to active reasoning.*
- **Deliverables:**
  - Upgrade the Durable Supervisor to run "Sleep Cycles" when UI activity is zero.
  - Implement the DBSCAN clustering script to find connections across the `sqlite-vec` index.
  - Generate automated Insights and push them to the Memory PR queue.

### Phase 4: Reconsolidation & Salience Fields
*The bleeding edge of Agentic Memory.*
- **Deliverables:**
  - Implement the Reconsolidation API: `MaaS.retrieve()` returns a `lease_id`. Agents use `MaaS.patch(lease_id, updated_fact)` at the end of their turn to heal the memory.
  - Build the Graph-Relational layer in SQLite to allow Salience Field math (updating weights of nodes connected by a `related_to` foreign key).

---

## Database Schemas (`cognitive-memory.db`)

### 1. Semantic Nodes (The Facts)
```sql
CREATE TABLE nodes (
  node_id TEXT PRIMARY KEY,
  category TEXT, -- 'preference', 'fact', 'system_state'
  content TEXT,
  embedding float[384], -- sqlite-vec
  confidence_score REAL DEFAULT 0.5,
  access_count INTEGER DEFAULT 0,
  last_accessed_at DATETIME,
  last_reconsolidated_at DATETIME
);
```

### 2. Relational Edges (The Graph & Salience)
```sql
CREATE TABLE edges (
  source_node_id TEXT,
  target_node_id TEXT,
  relation_type TEXT, -- 'causes', 'contradicts', 'related_to'
  weight REAL DEFAULT 1.0, -- Used for Salience Field radiation
  FOREIGN KEY(source_node_id) REFERENCES nodes(node_id),
  FOREIGN KEY(target_node_id) REFERENCES nodes(node_id)
);
```

### 3. Transactive Registry (Who knows what)
```sql
CREATE TABLE transactive_meta (
  domain TEXT PRIMARY KEY, -- e.g., 'Google Workspace API'
  primary_agent_id TEXT,   -- e.g., 'builder'
  expertise_score REAL,
  last_proven_at DATETIME
);
```

### 4. Episodic Traces (The Hippocampus Link)
```sql
CREATE TABLE traces (
  node_id TEXT,
  trace_id TEXT, -- Foreign key to evidence-ledger.db
  extracted_at DATETIME,
  FOREIGN KEY(node_id) REFERENCES nodes(node_id)
);
```

## Integration with SquidRun Systems
1. **Evidence Ledger:** Acts as the read-only Fast Buffer. The sleep cycle queries `comms_journal` where `extracted = false`.
2. **Durable Supervisor:** Hosts the background sleep cycle, pattern recognition, and decay archival.
3. **Hooks:** The `PreCompress` and `AfterAgent` hooks trigger the extraction prompts and the Reconsolidation patches, respectively.
4. **Memory PR:** Acts as the human-in-the-loop safety valve for high-impact structural changes to the graph.