# Memory Consistency Repair Policy

## Purpose
This specification defines the rules of engagement for repairing synchronization drift between the canonical flat-file knowledge base (`workspace/knowledge/`) and the vector-backed cognitive memory index (`workspace/memory/cognitive-memory.db`). It provides clear classification of drift types and establishes when automated repair is safe versus when manual human-in-the-loop review is required.

## Case Study: Session 228
During Session 228, the first live consistency check discovered 8 drifted items:
- 2 "Missing" chunks (flat-file content that had not been indexed).
- 6 "Orphaned" nodes (stale cognitive nodes whose corresponding flat-file sections had been modified, renamed, or removed).
Analysis confirmed this was pure **revision skew** (the flat files advanced ahead of the index, likely while the supervisor was inactive or the watcher missed an event). Because there was no data loss involving transactive metadata or standalone extracted notes, the entire set was safe to repair by mirroring the current flat-file state into the index.

## Drift Classification & Repair Matrix

### 1. Missing Chunks
- **Definition:** Content exists in `workspace/knowledge/*.md` but has no corresponding hash/node in `cognitive-memory.db`.
- **Risk Level:** Low. The flat file is the canonical source of truth.
- **Evidence Required:** File path and chunk text exist on disk but cannot be located via hash lookup in the index.
- **Recommended Action:** **Auto-Repair (Safe)**.
- **Implementation:** Re-index the missing chunk. If the entire file is missing, re-index the file.

### 2. Orphaned Nodes (Revision Skew)
- **Definition:** A node exists in the index pointing to a file path, but the specific chunk text (or its hash) no longer exists in the target flat file (e.g., the user edited a bullet point).
- **Risk Level:** Medium. Generally safe if it's pure revision skew, but requires checking for attached metadata.
- **Evidence Required:** The node exists, its `source_type` is `file`, but the hash does not match any current chunk in the source file.
- **Recommended Action:** **Auto-Repair (Conditional)**.
- **Implementation:** 
  - **Condition:** If the node contains NO manual transactive metadata or standalone extracted relationships (i.e., it is purely a semantic index of a file chunk), it is safe to **delete/tombstone** the old node and rely on the "Missing Chunks" policy to index the new text.
  - **Fallback:** If metadata exists, flag for **Manual Review** to prevent silent loss of agent annotations.

### 3. Orphaned Nodes (Deleted Source)
- **Definition:** Nodes exist in the index pointing to a file path that no longer exists on disk.
- **Risk Level:** High. The file may have been renamed, moved, or intentionally deleted.
- **Evidence Required:** Node `source_path` points to a non-existent file.
- **Recommended Action:** **Manual Review (or Dry-Run/Prompt)**.
- **Implementation:** Do not auto-delete. A missing file might be a git-checkout artifact or an accidental deletion. Surface the orphan count to the user/Architect. Allow an explicit `repair --purge-deleted` command.

### 4. Duplicate Hashes
- **Definition:** Multiple nodes in the index share the exact same content hash.
- **Risk Level:** Low. Harmless but wastes vector space and pollutes search results.
- **Evidence Required:** `SELECT content_hash, COUNT(*) FROM nodes GROUP BY content_hash HAVING COUNT(*) > 1`.
- **Recommended Action:** **Auto-Repair (Safe)**.
- **Implementation:** Keep the node with the highest access count or most recent `last_accessed_at` (or simply the oldest ID if tied). Delete the duplicates. Consolidate any edges/metadata to the surviving node before deletion.

### 5. Transactive Metadata Loss (Edge Case)
- **Definition:** Transactive metadata (expertise routing, salience scores) is attached to a node that has been marked as an orphan (e.g., due to a file edit).
- **Risk Level:** High. Deleting the orphan wipes the learned metadata.
- **Evidence Required:** Node is orphaned AND has entries in `transactive_meta` or inbound/outbound `edges`.
- **Recommended Action:** **Manual Review**.
- **Implementation:** The system must not auto-delete these nodes. Instead, it should propose a "Metadata Migration" patch, presenting the old node's text, the new file text, and asking if the metadata should be re-attached to the new chunk.

## Tooling Requirements (For Builder)
When implementing the repair mode (`hm-memory-consistency.js --repair`):
1. **Safe Mode (Default):** Only auto-repairs **Missing Chunks** and **Duplicate Hashes**, plus **Orphaned Nodes (Revision Skew)** *only if* they lack attached metadata.
2. **Interactive/Dry-Run Mode:** Lists High/Medium risk items (Deleted Source, Metadata Loss) and requires explicit confirmation to purge or migrate.
3. **Audit Trail:** Every automated deletion or insertion during a repair pass must be logged to the Evidence Ledger to ensure accountability.
