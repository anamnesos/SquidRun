# Cognitive Memory: Advanced Algorithms

This document details the concrete algorithms for Phase 3 (Sleep Consolidation) and Phase 4 (Reconsolidation API) of the SquidRun Cognitive Memory Architecture.

## 1. Phase 3: Sleep Cycle Consolidation Algorithm

The "Sleep Cycle" runs in the Durable Supervisor during periods of user inactivity (e.g., no terminal input for 30 minutes). Its goal is to process the raw, noisy "hippocampus" (Evidence Ledger) into structured, semantic "neocortex" insights (Memory Graph).

### The Consolidation Pipeline

```javascript
async function runSleepConsolidation() {
  // 1. Fetch unextracted episodes
  const rawEpisodes = await db.all(`
    SELECT * FROM comms_journal 
    WHERE extracted_at IS NULL 
    ORDER BY sent_at ASC LIMIT 100
  `);
  
  if (rawEpisodes.length === 0) return;

  // 2. LLM Semantic Extraction (The "Dream" Phase)
  // Send the raw transcript chunk to a fast local/API LLM to extract facts
  const extractionPrompt = `
    Analyze this transcript. Extract only concrete system facts, user preferences, 
    and established architectural rules. Output as a JSON array of strings.
    Ignore casual conversation and temporary debugging steps.
  `;
  const extractedFacts = await llm.generate(extractionPrompt, rawEpisodes);
  
  // 3. Vectorization & Clustering (DBSCAN approach)
  // Embed the new facts
  const newVectors = await embedder.embedBatch(extractedFacts);
  
  // Fetch existing graph vectors
  const existingNodes = await db.all(`SELECT node_id, content, embedding FROM nodes`);
  
  // Combine and run Density-Based Spatial Clustering of Applications with Noise (DBSCAN)
  // Distance metric: 1 - CosineSimilarity. Epsilon: e.g., 0.15
  const clusters = dbscan.run(existingNodes.concat(newVectors), { epsilon: 0.15, minPoints: 2 });
  
  // 4. Insight Generation & PR Creation
  for (const cluster of clusters) {
    const hasNewFact = cluster.some(item => item.isNew);
    const hasOldFact = cluster.some(item => !item.isNew);
    
    if (hasNewFact && hasOldFact) {
      // Pattern detected: New facts relate heavily to existing graph nodes
      const proposedUpdate = await llm.synthesizeCluster(cluster);
      
      await createMemoryPR({
        type: 'MERGE_UPDATE',
        related_nodes: cluster.filter(i => !i.isNew).map(i => i.node_id),
        proposed_statement: proposedUpdate,
        confidence: 0.8
      });
    } else if (hasNewFact && !hasOldFact && cluster.length >= 3) {
      // Pattern detected: A brand new cluster of related ideas has formed
      const proposedInsight = await llm.summarizeCluster(cluster);
      
      await createMemoryPR({
        type: 'NEW_INSIGHT',
        proposed_statement: proposedInsight,
        confidence: 0.6 // Lower confidence for brand new isolated concepts
      });
    }
  }
  
  // 5. Mark as processed
  await db.exec(`UPDATE comms_journal SET extracted_at = NOW() WHERE id IN (...)`);
}
```

## 2. Phase 4: Reconsolidation API Design

Reconsolidation allows memory to "heal through use." When an agent retrieves a fact, it gains a temporary, optimistic lock on that fact. If the agent's actions prove the fact is incomplete or wrong, the agent patches it.

### The API Flow

1. **Retrieve (with Lease)**
   - Agent calls: `MaaS.retrieve({ query: "ServiceTitan API auth" })`
   - The MaaS performs the RRF hybrid search.
   - For the top returned nodes, the MaaS generates a `lease_id` and stores it in a `memory_leases` SQLite table.
   - **Schema:** `lease_id (UUID), node_id, agent_id, expires_at (NOW + 10 mins), version_at_lease`.

2. **The Reconsolidation Window**
   - The agent uses the returned context to write code or execute a command.
   - Scenario A (Success): The fact was perfectly accurate. The agent does nothing. The lease expires harmlessly.
   - Scenario B (Correction): The agent tries the ServiceTitan auth, it fails, and the agent discovers the endpoint changed from `/v1/` to `/v2/`.

3. **Patch (Healing the Graph)**
   - The agent calls: `MaaS.patch(lease_id, "ServiceTitan API auth endpoint is now /v2/, not /v1/")`
   
### Conflict Resolution & Concurrency

To prevent two background Builder agents from patching the same memory simultaneously with conflicting info, we use **Optimistic Concurrency Control (OCC)**.

```javascript
async function patchMemory(leaseId, updatedContent) {
  // 1. Validate Lease
  const lease = await db.get(`SELECT * FROM memory_leases WHERE lease_id = ?`, leaseId);
  if (!lease || lease.expires_at < NOW()) throw new Error("Lease expired or invalid");
  
  // 2. Check Version (OCC)
  const currentNode = await db.get(`SELECT current_version FROM nodes WHERE node_id = ?`, lease.node_id);
  if (currentNode.current_version !== lease.version_at_lease) {
    // Another agent updated this node while we held the lease!
    // Conflict resolution: Reject the patch, force the agent to re-retrieve the new state.
    throw new Error("Conflict: Memory was updated by another agent. Please re-retrieve.");
  }
  
  // 3. Apply Patch
  const newEmbedding = await embedder.embed(updatedContent);
  await db.exec(`
    UPDATE nodes 
    SET content = ?, 
        embedding = ?, 
        current_version = current_version + 1,
        last_reconsolidated_at = NOW(),
        confidence_score = MIN(1.0, confidence_score + 0.1) -- Reward for healing
    WHERE node_id = ?
  `, [updatedContent, newEmbedding, lease.node_id]);
  
  // 4. Invalidate all other active leases for this node to force other agents to refresh
  await db.exec(`DELETE FROM memory_leases WHERE node_id = ?`, lease.node_id);
}
```

### Why this works:
- **No Blocking:** Retrieval is fast and non-blocking. Multiple agents can retrieve the same node simultaneously (each gets a unique lease).
- **Safety:** The first agent to successfully patch "wins." Subsequent agents attempting to patch the old version will get an OCC conflict error and must re-evaluate based on the new truth.