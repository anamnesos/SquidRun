# Local Vector Search & Knowledge Indexing Design

## Objective
Implement a local, SQLite-backed hybrid search (BM25 + Semantic Vector) over our `workspace/knowledge/` directory and historical evidence ledger. This closes the gap with OpenClaw's memory architecture while retaining our deterministic multi-agent safety.

*Updated to include Memory Decay and Proactive Pattern Recognition.*

## Architecture

### 1. Database & Extensions
We will use our existing Node.js SQLite stack (`better-sqlite3` or `node:sqlite`) and integrate the `sqlite-vec` extension.
- **Why `sqlite-vec`:** It is a fast, C-based extension that runs natively inside SQLite on Windows. It avoids the need for heavy vector databases like Pinecone or Milvus.
- **Tables:** We will create a new DB file `workspace/memory/search-index.db` (or attach to the Evidence Ledger) with three tables:
  1. `documents` (id, file_path, chunk_index, content, last_modified, last_accessed_at, access_count)
  2. `fts_documents` (Virtual FTS5 table for BM25 keyword search)
  3. `vec_documents` (Virtual vec0 table for vector embeddings)

### 2. The Embedding Model (The Engine)
- **Choice:** We will use **`@xenova/transformers` (node-llama-cpp)** with a small, specialized embedding model like `all-MiniLM-L6-v2`.
- **Why Local:** James wants an autonomous system. Relying on the OpenAI API for embeddings costs money, introduces latency, and breaks if he's offline. `all-MiniLM-L6-v2` is tiny (~90MB), runs entirely on the CPU via Node.js, and generates fast 384-dimensional vectors. It requires no Python dependencies.

### 3. Chunking Strategy
Markdown files in `workspace/knowledge/` and `session.md` logs can get long. We cannot embed whole files at once.
- **Strategy:** Recursive Character Text Splitting (chunk size ~500 tokens, overlap ~50 tokens).
- **Metadata:** Each chunk will retain a reference to its source file and heading (e.g., `file: user-context.md, heading: Observed Preferences`).

### 4. Memory Decay & Retrieval Adjustments
Not all memories are evergreen. We need old, unused knowledge to fade.
- **Tracking:** When a search query successfully uses a document chunk, the `last_accessed_at` timestamp is updated and `access_count` increments.
- **Decay Scoring:** The retrieval query will apply a time-decay penalty to the RRF score. Chunks that haven't been accessed in 6 months receive a lower score than fresh chunks, unless their `access_count` is extremely high (proving they are fundamental evergreen facts).
- **Archiving:** The Supervisor can periodically move chunks with zero access over 12 months to a cold-storage table to keep the active index fast.

### 5. Integration with the Evidence Ledger
We should index two distinct sources:
1. **Curated Knowledge:** Everything in `workspace/knowledge/*.md`.
2. **Historical Decisions:** We will index the `Decision Digest` and `Cross-Session Decisions` tables from the Evidence Ledger. We will *not* index every raw chat message (too noisy).

### 6. Keeping the Index Fresh (The Update Loop)
- **File Watcher:** The Durable Supervisor will run a lightweight file watcher over `workspace/knowledge/`.
- **On Change:** When a file is modified (e.g., a Memory PR is promoted), the supervisor deletes old chunks for that `file_path`, re-chunks the file, generates new embeddings via `node-llama-cpp`, and inserts them into SQLite.
- **Startup Sync:** On SquidRun startup, it does a quick hash comparison of files vs. DB to catch any changes made while offline.

### 7. Proactive Pattern Recognition
- **Background Cron:** The Supervisor runs a low-priority background task (e.g., weekly) that runs a clustering algorithm (like DBSCAN) over the document embeddings.
- **Insight Generation:** If it finds a cluster of seemingly unrelated facts (e.g., three separate notes about vendor latency and two notes about James's plumbing inventory), it generates a brief "Insight" and submits it to the pending Memory PR queue for review.

### 8. Hybrid Search Query (Reciprocal Rank Fusion)
When an agent or James queries the system (e.g., via a new `hm-memory-search.js` CLI):
1. The script embeds the query string using the local model.
2. It executes a single SQLite query that uses **CTEs (Common Table Expressions)** to fetch the top K results from FTS5 (keyword match) and the top K results from `vec0` (semantic match).
3. It applies the Time Decay penalty to the rank index.
4. It combines the scores using **Reciprocal Rank Fusion (RRF)** to return the mathematically best combined result, prioritizing recently accessed and highly relevant chunks.

## Builder Implementation Steps
1. `npm install sqlite-vec @xenova/transformers`
2. Create `ui/scripts/hm-memory-index.js`: Reads `workspace/knowledge/`, chunks files, generates vectors, and populates the SQLite tables. Include access tracking columns.
3. Create `ui/scripts/hm-memory-search.js`: Takes a text query, embeds it, runs the RRF hybrid SQLite query with decay math, and outputs the top chunks. Update access counts for returned chunks.
4. Integrate the indexer and the proactive pattern recognizer into the Supervisor's background loop.