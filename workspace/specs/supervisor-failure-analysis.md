# Durable Supervisor Failure State Analysis

**Date:** 2026-03-12
**Scope:** `ui/supervisor-daemon.js` & `ui/modules/supervisor/store.js`

This document outlines the failure states of the new Durable Supervisor mechanism introduced in Session 213, specifically analyzing what occurs under different stress conditions based on a review of the daemon and store source code.

## 1. SQLite Lock Contention
**Scenario:** Multiple entities (e.g., the daemon, a CLI script, or an external process) attempt to write to `supervisor.sqlite` concurrently.

*   **Mechanism:** The `SupervisorStore` uses `better-sqlite3` or `node:sqlite`. In `_applyPragmas()`, it sets `PRAGMA journal_mode=WAL;` (Write-Ahead Logging) and `PRAGMA busy_timeout=5000;`. It also uses explicit transactions (`BEGIN IMMEDIATE;` ... `COMMIT;`) for critical operations like `claimNextTask` and `enqueueTask`.
*   **Outcome:** 
    *   `WAL` mode allows concurrent readers while a write is occurring, which is excellent for performance.
    *   The `busy_timeout=5000` means that if a write lock is held, other writers will wait up to 5 seconds before throwing an `SQLITE_BUSY` error.
    *   If a transaction fails (e.g., due to an error or prolonged lock), the store catches the error, attempts a `ROLLBACK;`, and returns `{ ok: false, reason: '...', error: err.message }`. 
    *   **Vulnerability:** The daemon's `tick()` loop logs the failure (`Task claim failed: ...`) but does not crash. It simply retries on the next poll interval (default 4 seconds). This is resilient, but prolonged lock contention > 5 seconds will temporarily halt queue processing.

## 2. Heartbeat Timeout (Worker Death)
**Scenario:** A worker process (e.g., a background Builder agent) is launched via `spawn`, but the worker process hangs indefinitely, gets suspended by the OS, or the supervisor's `setInterval` heartbeat loop is blocked (e.g., by synchronous heavy work like embeddings).

*   **Mechanism:** When a task is claimed, a `lease_expires_at_ms` is set (default `now + 60s`). The daemon sets up a `setInterval` (default every 15s) to call `store.heartbeatTask`, which pushes the lease out another 60 seconds.
*   **Outcome:**
    *   If the heartbeat stops updating the DB (e.g., daemon event loop blocked or worker killed without triggering the `exit` event), the lease expires.
    *   On the next supervisor `tick()`, the daemon calls `store.requeueExpiredTasks()`.
    *   The store identifies any `status = 'running'` tasks where `lease_expires_at_ms <= NOW()`. It updates them back to `status = 'pending'`, increments the `attempt_count`, and logs a `requeued_expired_lease` event.
    *   **Vulnerability:** If the child process is *actually* still running but the heartbeat just failed (split-brain), requeuing the task means a second worker might be spawned for the same objective. Agents must be written idempotently. Additionally, the original "zombie" process is never explicitly `kill()`'d by the requeue logic if it was a silent heartbeat failure rather than a process exit.

## 3. Task Queue Overflow (Backpressure)
**Scenario:** Tasks are enqueued significantly faster than the workers can process them.

*   **Mechanism:** The queue is a SQLite table (`supervisor_tasks`). `SupervisorStore.listTasks()` has a hardcoded limit parameter (clamped between 1 and 500). `claimNextTask` queries for `LIMIT 1` sorted by `priority DESC, created_at_ms ASC`.
*   **Outcome:**
    *   The daemon limits active execution using `maxWorkers` (default 2). It will only claim new tasks if `this.activeWorkers.size < this.maxWorkers`.
    *   If there are thousands of pending tasks, they safely wait in the SQLite table. There is no memory leak in the Node process because pending tasks remain on disk until claimed.
    *   **Vulnerability:** There is no automatic pruning or TTL for pending tasks. If a task is permanently blocked or lower priority than an endless stream of high-priority tasks, it will sit in the queue forever (starvation).

## 4. Unclean Shutdown (SIGKILL, Power Loss)
**Scenario:** The user machine loses power, or the supervisor process is killed instantly (e.g., `kill -9` or Task Manager end task), preventing `process.on('SIGINT')` / `SIGTERM` handlers from firing.

*   **Mechanism:**
    *   The active workers (`child_process.spawn`) might be orphaned if `windowsHide: true` prevents standard console termination propagation, though standard Node behavior attempts to kill children if the parent dies.
    *   The `supervisor_tasks` table will have rows stuck with `status = 'running'` and a `lease_expires_at_ms` set to some time in the near future.
*   **Outcome:**
    *   Upon the next startup (e.g., user logon triggers the scheduled task), the new `SupervisorDaemon` instance calls `init()`.
    *   `init()` explicitly calls `this.store.requeueExpiredTasks({ nowMs: Date.now() })`.
    *   Tasks that were interrupted during the crash will have their leases expired (or will expire shortly) and will be safely moved back to `pending`.
    *   **Vulnerability:** If an unclean shutdown occurs exactly while the worker was writing to a file, that file might be corrupted. The supervisor provides state-machine durability, but not filesystem transactional safety for the workers themselves. The `supervisor.pid` file might also remain on disk, but `acquirePidFile` checks if the recorded PID is actually a running process using `processExists(pid)`. If the old process is dead, it safely overwrites the PID file.

## Summary Verdict
The durability architecture is robust. The reliance on `WAL`, OCC leasing, and deterministic requeuing protects against queue corruption. 

**Areas for Future Hardening:**
1.  **Zombie Process Cleanup:** When a task lease expires, the supervisor should attempt to kill the associated `worker_pid` if it still exists before requeuing.
2.  **Queue Starvation:** Introduce a TTL for pending tasks or a dynamic priority boost for aging tasks.
3.  **Idempotency Enforcement:** We must enforce that all background Builder agents are strictly idempotent, as split-brain execution (two workers running the same task) is possible if heartbeats fail under high CPU load.

## Appendix: Memory Search Retrieval Quality (Session 214 Finding)
**Observation:** While unit tests for the cognitive memory index and search pass, real-world semantic search behavior shows degraded retrieval quality.
*   **Symptom:** Querying for `"truncation fix"` returned `workflows.md` as the top result, but the excerpt was for an unrelated AI research workflow. The actual paragraph containing the explicit words "PTY long-message truncation hardening" was missed entirely.
*   **Root Cause Hypotheses:** 
    *   **Chunking Strategy:** Recursive Character Text Splitting may be severing critical keywords from their surrounding context, diluting the TF-IDF / BM25 score for the specific chunk containing the answer.
    *   **Vector Bias:** The semantic vector search might be heavily prioritizing dense text chunks over shorter, specific bullet points, drowning out exact keyword matches.
    *   **Weighting:** The Reciprocal Rank Fusion (RRF) algorithm might have incorrect weights balancing the keyword match (FTS5) against the semantic match (`vec0`).
*   **Recommendation:** This requires tuning. We should implement an evaluation suite that tests specific expected queries against known files to dial in the chunk size, overlap, and RRF weighting.