# Memory Auto-Extract & "PR" Prototype Design

## Objective
Implement an auto-extract, manual-promote ("Memory PR") pipeline to solve memory decay without introducing the risk of automatic hallucination-pollution into our global memory files. 

*Updated to include Confidence Scoring and Real-Time Correction Propagation.*

## Architecture

### 1. Extraction Trigger (When to extract?)
We don't want to run extraction on every single message. The trigger should be tied to significant session events:
- **Hook-based:** We can use the `PreCompress` hook (or a dedicated `PreCompact` event) to scan the rolling context window before it gets compressed or lost.
- **Completion-based:** Trigger an extraction when the Architect marks a high-level task as `COMPLETE` or when a predefined session duration/turn count is reached.

### 2. Auto-Extract Pipeline (The "Diff" Generator)
An background agent (or the Architect itself via a special LLM pass) analyzes the recent session history looking for:
- **New procedural knowledge:** "How to build X", "Where Y is deployed".
- **User preferences:** "James prefers X over Y".
- **System facts:** "Device MACBOOK has a quirk with path X".

*Output:* The extraction pass does **not** write to `workspace/knowledge/*.md` directly. Instead, it generates a structured JSON payload representing proposed facts.

### 3. The Staging Area (The "PR")
Proposed facts are saved to a staging file or database table:
- e.g., `.squidrun/memory/pending-pr.json` or an `Unresolved Claims` table in the Evidence Ledger.
- Each fact includes: 
  - `category` (e.g., preference, workflow)
  - `statement` (the proposed text)
  - `source_trace` (pointer to the session logs that generated it)
  - `confidence_score` (Float 0.0-1.0: How certain the extractor is about this fact)
  - `review_count` (Integer: Starts at 0)

### 4. Promotion / Review UI (Manual Promote)
Before the facts become canonical, they must be reviewed.
- **Agent Review:** At the start of a new session, or during a quiet period, the Architect reviews the pending queue.
- **User Review (Optional but Recommended):** The UI could surface a "Memory PRs" tab. James can click [Approve], [Reject], or [Edit] on proposed facts.
- **Applying the PR:** Once approved, the system merges the fact into the appropriate Markdown file in `workspace/knowledge/` (e.g., appending to `user-context.md` or `workflows.md`).
- **Confidence Tracking:** When a fact is approved, its `review_count` increments. If multiple agents independently propose the same fact, its `confidence_score` increases.

### 5. Real-Time Correction Propagation
When James explicitly corrects an agent ("No, I prefer X, not Y"):
- The agent immediately queries the Vector Search index for facts related to "Y".
- If found, the agent flags those specific chunks/facts in the pending PR queue or marks the existing knowledge file line with a `[Requires Review: Correction]` tag.
- The confidence score of the old fact is heavily penalized.

## Implementation Plan for Builder
1. **Extractor Script:** Create `ui/scripts/hm-memory-extract.js` that takes a session log window, prompts a fast model (like Gemini Flash or Haiku) to extract facts, and writes to `.squidrun/memory/pending.json` with base confidence scores.
2. **Hook Integration:** Bind this script to the `PreCompress` hook.
3. **Approval Command:** Create `ui/scripts/hm-memory-promote.js` that reads the pending JSON, presents it to the Architect (or User), and appends approved items to the canonical markdown files.
4. **Correction Hook:** Add logic to detect explicit user corrections and trigger a search-and-flag operation.