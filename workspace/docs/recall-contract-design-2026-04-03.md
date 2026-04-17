# Recall Contract Design

Date: 2026-04-03
Author lane: Builder
Status: design draft for review before implementation

## Goal

Create one reusable recall broker that can be called from:
- session-start context injection
- inbound user / Telegram message delivery
- future agent-side "recall now" tools

The broker should not treat all backends as equal peers. They serve different roles:
- Evidence Ledger: recent episodic truth
- Team Memory: structured claims / patterns / handoffs / delivery memory
- Memory Search: broad file and evidence retrieval corpus
- Cognitive Memory: derived semantic recall over promoted memory nodes, already seeded from memory-search

## Non-Goals

- Do not build `memory_feedback` in this step.
- Do not redesign position management in this step.
- Do not replace the existing storage backends.

## Proposed Module

New module:
- `ui/modules/memory-recall.js`

Primary export:

```js
async function recall(input = {}) => RecallResult
```

Optional helper exports:

```js
function formatRecallForInjection(result, options = {}) => string
function buildRecallQueryFromMessage(message, context = {}) => RecallQuery
function buildStartupRecallQuery(context = {}) => RecallQuery
```

## Request Interface

```js
{
  query: string,
  topN?: number,
  paneId?: string,
  agentRole?: 'architect' | 'builder' | 'oracle',
  senderRole?: string | null,
  targetRole?: string | null,
  sessionId?: string | null,
  projectRoot?: string,
  mode?: 'startup' | 'message' | 'manual',
  trigger?: 'session_start' | 'user_message' | 'telegram_inbound' | 'manual',
  userIdentity?: 'james' | 'eunbyeol' | null,
  currentMessage?: string | null,
  activeSymbols?: string[],
  activeFiles?: string[],
  maxPerSource?: {
    evidenceLedger?: number,
    teamMemory?: number,
    memorySearch?: number,
    cognitiveMemory?: number,
  },
  timeWindowMs?: number,
  includeDiagnostics?: boolean,
}
```

## Response Interface

```js
{
  ok: true,
  query: string,
  resultSetId: string,
  mode: 'startup' | 'message' | 'manual',
  trigger: string,
  summary: {
    returned: number,
    considered: number,
    bySource: {
      evidenceLedger: number,
      teamMemory: number,
      memorySearch: number,
      cognitiveMemory: number,
    },
  },
  results: [
    {
      resultId: string,
      rank: number,
      mergedScore: number,
      source: 'evidence_ledger' | 'team_memory' | 'memory_search' | 'cognitive_memory',
      sourceRole: 'episodic' | 'structured' | 'corpus' | 'derived',
      authoritative: boolean,
      confidence: number | null,
      freshnessAt: string | null,
      title: string | null,
      content: string,
      excerpt: string,
      recallReason: string,
      provenance: {
        citation?: string | null,
        path?: string | null,
        rowId?: number | null,
        claimId?: string | null,
        nodeId?: string | null,
        documentId?: number | null,
      },
      feedback: {
        resultSetId: string,
        resultId: string,
        source: string,
      },
      diagnostics?: {
        sourceScore: number,
        freshnessScore: number,
        authorityBoost: number,
        duplicationPenalty: number,
      }
    }
  ],
  diagnostics?: {
    backendTimingsMs: object,
    rawCounts: object,
    dedupedCount: number,
  }
}
```

## Backend Responsibilities

### 1. Evidence Ledger backend

Role:
- recent episodic truth
- who said what recently
- current-session and near-session facts

Query shape:
- recent `comms_journal`
- optionally recent session snapshots / decisions later
- biased to:
  - sender / target role
  - recent user-facing channels
  - exact name matches like James / Eunbyeol / 은별

Output type:
- short factual excerpts
- not broad corpus chunks

Priority:
- highest freshness
- medium authority

### 2. Team Memory backend

Role:
- structured memory
- claims, patterns, handoffs, delivery memory

Query shape:
- `search-claims` / `query-claims`
- recent surfaced memories from delivery service
- cross-device handoff / session-rollover style records when relevant

Output type:
- compact structured facts
- useful because they are already normalized claims rather than raw transcripts

Priority:
- high authority when claim is confirmed / system-promoted
- medium freshness

### 3. Memory Search backend

Role:
- broad corpus retrieval
- workspace knowledge plus case evidence folders

Query shape:
- `MemorySearchIndex.search(query)`

Output type:
- file/evidence chunks with excerpt + path

Priority:
- highest breadth
- lower authority than explicit team-memory / user truth unless source is clearly canonical

### 4. Cognitive Memory backend

Role:
- derived semantic recall over promoted nodes
- should not just duplicate raw search chunks

Query shape:
- `CognitiveMemoryApi.retrieve(query, { limit, agentId, proactiveInjection: false })`

Important nuance:
- cognitive retrieve already seeds from memory-search internally
- because of that, the broker should treat cognitive memory as a derived/ranking layer, not a second equal corpus search

Output type:
- promoted node summaries
- linked concepts
- historically useful semantic matches

Priority:
- useful for abstraction and cross-session patterns
- should be deduped aggressively against memory-search results

## Merge / Ranking Rules

### Source weighting

Initial weighting:
- evidence_ledger: freshness-heavy
- team_memory: authority-heavy
- memory_search: breadth-heavy
- cognitive_memory: abstraction-heavy

Notional merge weights:
- Evidence Ledger: `0.90 freshness, 0.55 authority`
- Team Memory: `0.75 freshness, 0.90 authority`
- Memory Search: `0.60 freshness, 0.65 authority`
- Cognitive Memory: `0.65 freshness, 0.75 authority`

These are design intent, not fixed constants yet.

### Deduping

Deduping key priority:
1. exact path + excerpt hash
2. claim id / node id if present
3. normalized content hash

Specific rule:
- if cognitive memory result is clearly just the promoted semantic restatement of a memory-search chunk, keep the cognitive result only if it adds abstraction or stronger authority metadata

### Result budget

Default top-N:
- startup: 6
- message: 4
- manual: 8

Default per-source cap:
- evidence ledger: 2
- team memory: 2
- memory search: 2
- cognitive memory: 2

Then merge and trim.

## Injection Formatting

The broker should not inject raw JSON into agents. It should format a short bounded block.

Example:

```text
[RECALL]
reason=user_message
query=은별 customs shipping label alias

1. [structured][team_memory] Gini Qwan/Kwan is James's test-buy alias; Messenger/label/invoice use alias while CashApp uses real identity.
2. [episodic][evidence_ledger] Recent review flagged the shipping-label mismatch until alias linkage was explained.
3. [corpus][memory_search] Korean Fraud evidence files include shipping-label image, invoice analysis, and test-buy statement.
4. [derived][cognitive_memory] Prior corrections indicate legal statements should avoid categorical claims when evidence proves shipment but not final legal determination.
```

Hard limit:
- keep total injected recall block under a configurable character budget
- message-mode default target: about 1200-1600 chars

## First Wiring Points

### A. Session start

Current startup already has:
- hook doctrine
- transcript startup context
- cognitive startup summary

Replace only the cognitive startup slice with:
- `recall({ mode: 'startup', trigger: 'session_start', ... })`

Keep:
- mandatory doctrinal file block
- agency layer

Add:
- one formatted recall block after mandatory reads

### B. Inbound message path

In `ui/modules/main/squidrun-app.js`, in the `send` route:
- after canonical envelope creation
- before final `contentWithProjectContext` is delivered

Condition for first implementation:
- only for inbound user / telegram messages targeting an agent pane
- not for every agent-to-agent message yet

Call:

```js
const recall = await recallBroker.recall({
  mode: 'message',
  trigger: 'user_message',
  query: buildRecallQueryFromMessage(...),
  senderRole,
  targetRole,
  sessionId,
  currentMessage: canonicalEnvelope.content,
});
```

Then prepend formatted recall block only when non-empty.

## Query Builder Rules

### For James / user messages
- use raw message
- add active project and session hints
- include role names and obvious entities

### For Eunbyeol / Telegram inbound
- boost exact identity aliases:
  - `은별`
  - `eunbyeol`
  - case names
  - customs / evidence / fraud entities

### For startup
- use active items from:
  - startup health
  - current trading state
  - case operations
  - recent comms

## Why This Interface Fits Current Architecture

It respects the current system instead of fighting it:
- Evidence Ledger stays the episodic source
- Team Memory stays the structured/feedback source
- Memory Search stays the broad corpus index
- Cognitive Memory stays the semantic/promoted layer

It also creates a clean slot for the later feedback contract:
- every recalled result already carries `resultSetId` and `resultId`
- later `memory_feedback(result_set, outcome)` can consume those ids without redesigning recall

## Explicit Boundaries

### What recall does
- retrieve
- merge
- rank
- format for bounded context injection

### What recall does not do
- promote
- suppress
- patch memories
- decide which memories become canonical

That is for the next `memory_feedback` contract.

## Builder Recommendation

Implement recall in two passes:

### Phase 1
- broker module
- four backend adapters
- merge + dedupe + format
- wire into:
  - session start
  - inbound user/Telegram message delivery

### Phase 2
- extend to agent-requested manual recall
- add diagnostics / observability
- only then connect memory feedback

## Open Questions For Review

1. Should Team Memory surfaced injections be queried directly in recall v1, or only claims/handoffs?
2. Should Evidence Ledger retrieval include session decisions/snapshots in v1, or only comms_journal?
3. Should message-mode recall run for all user messages, or only for named identities like James / Eunbyeol in the first rollout?
4. Should the broker emit a machine-readable audit trail for every injection from day one?
