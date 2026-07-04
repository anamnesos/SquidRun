export type JsonRecord = Record<string, unknown>;
export type AntibodyStatus =
  | 'clear'
  | 'suspected_conflict'
  | 'classified_conflict'
  | 'classified_update'
  | 'uncertain';
export type AntibodyAdjudicationStatus =
  | 'pending'
  | 'accepted_correction'
  | 'rejected_hallucination'
  | 'coexistence';

export interface ProjectMetadata {
  name: string | null;
  path: string | null;
  session_id: string | null;
  source: string | null;
}

export interface EnvelopeParty {
  role: string;
}

export interface EnvelopeTarget {
  raw: string | null;
  role: string | null;
  pane_id: string | null;
}

export interface OutboundMessageEnvelope {
  version: string;
  message_id: string | null;
  timestamp_ms: number;
  sent_at: string;
  session_id: string | null;
  priority: string | null;
  content: string;
  sender: EnvelopeParty;
  target: EnvelopeTarget;
  project: ProjectMetadata | null;
}

export interface OutboundMessageEnvelopeInput {
  message_id?: string | null;
  messageId?: string | null;
  timestamp_ms?: number | string | null;
  timestampMs?: number | string | null;
  session_id?: string | null;
  sessionId?: string | null;
  priority?: string | null;
  content?: string | null;
  sender?: Partial<EnvelopeParty> | null;
  sender_role?: string | null;
  senderRole?: string | null;
  target?: Partial<EnvelopeTarget> | null;
  target_raw?: string | null;
  targetRaw?: string | null;
  target_role?: string | null;
  targetRole?: string | null;
  target_pane_id?: string | null;
  targetPaneId?: string | null;
  project?: Partial<ProjectMetadata> | null;
}

export interface CanonicalEnvelopeMetadata {
  envelope_version: string;
  envelope: OutboundMessageEnvelope;
  project: ProjectMetadata | null;
  session_id: string | null;
  sender: EnvelopeParty;
  target: EnvelopeTarget;
  timestamp_ms: number;
  sent_at: string;
}

export interface WebSocketDispatchMessage {
  type: 'send';
  target: string | null;
  content: string;
  priority: string;
  metadata: CanonicalEnvelopeMetadata;
  messageId: string | null;
  ackRequired: boolean;
  attempt: number;
  maxAttempts: number;
}

export interface TriggerFallbackDescriptor {
  content: string;
  messageId: string | null;
  metadata: CanonicalEnvelopeMetadata;
}

export interface SpecialTargetRequest {
  content: string;
  messageId: string | null;
  senderRole: string;
  sessionId: string | null;
  metadata: CanonicalEnvelopeMetadata;
}

export type CognitiveMemoryAction = 'ingest' | 'retrieve' | 'patch' | 'salience';

export interface CognitiveMemorySource {
  via?: string | null;
  role?: string | null;
}

export interface CognitiveMemoryOperationOptions {
  source?: CognitiveMemorySource;
  api?: {
    ingest(input: JsonRecord): Promise<JsonRecord>;
    retrieve(query: string, options?: JsonRecord): Promise<JsonRecord>;
    patch(leaseId: string, content: string, options?: JsonRecord): Promise<JsonRecord>;
    applySalienceField(input: JsonRecord): JsonRecord;
    close(): void;
  } | null;
  apiOptions?: JsonRecord;
}

export interface CognitiveMemoryPayload extends JsonRecord {
  query?: string;
  text?: string;
  content?: string;
  updatedContent?: string;
  updated_content?: string;
  agentId?: string;
  agent_id?: string;
  agent?: string;
  ingestedVia?: string;
  ingested_via?: string;
  leaseId?: string;
  lease_id?: string;
  lease?: string;
  reason?: string | null;
  nodeId?: string;
  node_id?: string;
  node?: string;
  maxDepth?: number;
  max_depth?: number;
  limit?: number;
  leaseMs?: number;
  lease_ms?: number;
  delta?: number;
}

export interface CognitiveMemoryNode {
  nodeId: string;
  category: string;
  content: string;
  contentHash: string;
  confidenceScore: number;
  accessCount: number;
  lastAccessedAt: string | null;
  lastReconsolidatedAt: string | null;
  currentVersion: number;
  salienceScore: number;
  isImmune: boolean;
  embedding: number[];
  sourceType: string | null;
  sourcePath: string | null;
  title: string | null;
  heading: string | null;
  metadata: JsonRecord;
  createdAtMs: number;
  updatedAtMs: number;
  antibodyStatus: AntibodyStatus;
  antibodyScore: number;
  conflictsWithMemoryId: string | null;
  classifiedBy: string | null;
  classifiedAtMs: number;
  adjudicationStatus: AntibodyAdjudicationStatus | null;
  quarantinedAtMs: number;
}

export interface AntibodyQueueRow {
  queue_id: string;
  node_id: string;
  conflicting_node_id: string | null;
  request_type: string;
  status: string;
  classifier_strategy: string | null;
  classifier_request_id: string | null;
  heuristic_label: string | null;
  heuristic_score: number;
  payload_json: string;
  result_json: string;
  created_at_ms: number;
  updated_at_ms: number;
  last_attempt_at_ms: number | null;
}

export interface AgentDomainTrustRow {
  agent_id: string;
  domain: string;
  trust_score: number;
  suspicion_score: number;
  accepted_count: number;
  rejected_count: number;
  updated_at_ms: number;
}

export interface MemoryLease {
  leaseId: string;
  expiresAtMs: number;
  versionAtLease: number;
}

export interface TransactiveExpertMatch {
  domain: string;
  primaryAgentId: string | null;
  expertiseScore: number;
  proofCount: number;
  lastProvenAt: string | null;
  lastPaneId: string | null;
  matchScore: number;
  sharedTokenCount: number;
  directMatch: boolean;
}

export interface TransactiveExpertResult {
  ok: boolean;
  matches: TransactiveExpertMatch[];
  recommendedAgentId: string | null;
}

export interface RankedMemoryNodeEntry {
  node: CognitiveMemoryNode;
  distance: number;
  score: number;
  baseScore: number;
  recencyMultiplier: number;
  freshnessPenaltyBypassed: boolean;
}

export interface RetrieveMemoryResult {
  ok: boolean;
  query?: string;
  reason?: string;
  seededNodeCount?: number;
  transactive?: TransactiveExpertResult;
  results: Array<CognitiveMemoryNode & {
    leaseId: string;
    expiresAtMs: number;
    score: number;
    distance: number;
  }>;
}

export interface MemoryPrCandidate {
  pr_id?: string;
  category?: string;
  statement?: string;
  source_trace?: string | null;
  source_payload?: JsonRecord;
  confidence_score?: number;
  review_count?: number;
  status?: string;
  domain?: string | null;
  proposed_by?: string | null;
  correction_of?: string | null;
}

export interface MemoryPrRow {
  pr_id: string;
  category: string;
  statement: string;
  normalized_statement: string;
  source_trace: string | null;
  source_payload_json: string;
  confidence_score: number;
  review_count: number;
  status: string;
  domain: string | null;
  proposed_by: string | null;
  correction_of: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface TransactiveMetaRow {
  domain: string;
  primary_agent_id: string;
  expertise_score: number;
  last_proven_at: string | null;
  last_pane_id: string | null;
  proof_count: number;
  updated_at_ms: number;
}

export interface WorkspacePaths {
  projectRoot: string;
  workspaceDir: string;
  memoryDir: string;
  dbPath: string;
  pendingPrPath: string;
}

export interface BridgeGetDevicesPayload {
  timeoutMs?: number;
  refresh?: boolean;
}

export interface BridgePairingJoinPayload {
  code?: string;
  timeoutMs?: number;
}

export interface BridgeCallResult extends JsonRecord {
  ok: boolean;
  status?: string;
  error?: string;
}

export interface DevicePairingDeps {
  getBridgeDevices?: ((input: {
    refresh: boolean;
    timeoutMs?: number;
  }) => Promise<BridgeCallResult> | BridgeCallResult) | null;
  getBridgeStatus?: (() => JsonRecord) | null;
  getBridgePairingState?: (() => JsonRecord) | null;
  initiateBridgePairing?: ((input: {
    timeoutMs?: number;
  }) => Promise<BridgeCallResult> | BridgeCallResult) | null;
  joinBridgePairing?: ((input: {
    code?: string;
    timeoutMs?: number;
  }) => Promise<BridgeCallResult> | BridgeCallResult) | null;
}

export interface AppStatusPayload extends JsonRecord {
  started?: string;
  mode?: string;
  dryRun?: boolean;
  autoSpawn?: boolean;
  version?: string;
  platform?: string;
  nodeVersion?: string;
  lastUpdated?: string;
  session?: number;
  session_id?: string | null;
  sessionId?: string | null;
  session_number?: number;
  sessionNumber?: number;
  currentSession?: number;
}

export interface AppStatusWriteOptions {
  incrementSession?: boolean;
  sessionFloor?: number | null;
  sessionSeed?: number | null;
  session?: number | null;
  statusPatch?: JsonRecord | null;
}

// ---------------------------------------------------------------------------
// SQUID ROOM SPEECH SEAM (charter organ 7, first slice - the seam whose
// prose-contract failure put commit hashes in creature speech, S464).
// Producer: renderer.js face pipeline + squid-room-creature-runtime.js.
// Consumer: squid-room-speech-system.js (Oracle-owned module).
// ---------------------------------------------------------------------------

/** Text fed to a creature speech box. NEVER generated - forwarded from the
 * honest face pipeline, keyed by ledger row identity. */
export interface SpeechPayload {
  /** De-jargonized single-line face text. The ONLY text the typewriter may
   * speak. Empty/absent = the creature goes silent (strip, never invent). */
  face: string;
  /** Full humanized message for the expanded bubble. Defaults to face. */
  full?: string;
  /** Raw original text, one click deeper in the expand. Never on the face. */
  raw?: string;
  /** Ledger row identity. Same identity = idempotent no-restart; new
   * identity restarts the typewriter. */
  rowIdentity?: string;
}

/** Per-frame creature anchor in speech-layer coordinates. Produced by the
 * creature runtime from engine state x scale + cached canvas rects. */
export interface CreatureAnchor {
  /** Mouth point (bubble-chain origin). */
  mouthX: number;
  mouthY: number;
  /** Head center (solver reference). */
  headX: number;
  headY: number;
  /** +1 facing right, -1 facing left (sign of cos(heading)). */
  facing?: number;
  /** Creature body rect for the solver's body-exclusion pad. */
  bodyX?: number;
  bodyY?: number;
  bodyW?: number;
  bodyH?: number;
}

/** Map of petId -> anchor passed to SpeechSystem.frame() every rAF tick. */
export type CreatureAnchors = Record<string, CreatureAnchor>;

export interface SpeechSystem {
  setSpeech(petId: string, payload?: SpeechPayload): void;
  /** Advance one frame. Missing anchor for a visible pet = fail-dark (hide,
   * never guess). */
  frame(nowMs: number, anchors?: CreatureAnchors): void;
  setViewport(width: number, height: number): void;
}

// ---------------------------------------------------------------------------
// DELIVERY RESULT SEAM (charter organ 7, slice 2 - the policy doc'\''s original
// first-slice target). The accepted/queued/verified/status sprawl drifted
// between callers three separate times during the S464-S467 transport work;
// this is the single source of truth for what a delivery attempt returns.
// Canonical producer: triggers.js buildDeliveryResult; the main-process
// direct-pane path returns a compatible subset.
// ---------------------------------------------------------------------------

export interface DeliveryResult {
  /** Mirror of accepted (legacy callers read success). */
  success: boolean;
  /** The transport took the message (says nothing about visibility). */
  accepted: boolean;
  /** Queued for injection (idle-queue or pending-delivery store). */
  queued: boolean;
  /** Delivery VERIFIED visible - the only field that may claim the pane saw
   * it. Absence of verification must never be reported as green. */
  verified: boolean;
  /** Machine-readable outcome, e.g. '\''delivered.verified'\'',
   * '\''accepted.unverified'\'', '\''materialized.pointer_fallback'\'',
   * '\''skipped.chunked_payload'\'', '\''no_targets'\''. */
  status: string;
  /** Pane ids this attempt addressed. */
  notified: string[];
  /** Transport lane ('\''pty'\'' | '\''daemon-pty'\'' | '\''inject-ipc'\''...). */
  mode: string;
  deliveryId: string | null;
  details: unknown;
}

// ---------------------------------------------------------------------------
// VERDICT LEDGER SEAM (charter organ 2 — credibility is MEASURED).
// Producer: ui/modules/verdict-ledger.js createVerdict/resolveVerdict/
// supersedeVerdict/sweepExpired. Disk: ui/modules/verdict-ledger-store.js
// (.squidrun/runtime/verdict-ledger.json, root MUST be a bare array).
// Consumer: ui/scripts/hm-hook-injection.js (credibility standing).
// KNOWN DEBT (S468 seam audit): resolve/supersede/sweep have no production
// caller yet — open verdicts cannot transition until resolution is wired
// into the gates; the store module is bypassed by the hook reader.
// ---------------------------------------------------------------------------

export type VerdictKind = 'gate' | 'verify' | 'audit-finding' | 'claim' | 'constitution';
export type VerdictOpenStatus = 'open' | 'pends';
export type VerdictResolvedStatus = 'held' | 'failed' | 'mixed' | 'expired' | 'superseded';
export type VerdictStatus = VerdictOpenStatus | VerdictResolvedStatus;

export interface VerdictOutcome {
  status: VerdictStatus;
  pendsOn: string | null;
  resolvedAt: string | null;
  resolver: string | null;
  note: string | null;
  supersededBy: string | null;
}

export interface VerdictRecord {
  id: string;
  issuedAt: string;
  issuer: string;
  kind: VerdictKind;
  subject: string;
  statement: string;
  evidence: string;
  /** 'live' | 'backfill-s465' — provenance, never authority. */
  source: string;
  expiresAt: string | null;
  outcome: VerdictOutcome;
}

/** credibility() output — what hm-hook-injection formats into standing. */
export interface VerdictCredibility {
  issuer: string;
  status: string;
  accuracy: number | null;
  resolved: number;
  open: number;
  expired: number;
}

// ---------------------------------------------------------------------------
// LANE / WORK SEAM. Three distinct shapes — they are NOT one system:
// lanes (hm-lane.js, .squidrun/runtime/lanes.json), agent task queue
// (hm-task-queue.js, .squidrun/runtime/agent-task-queue.json, cross-read by
// work-item-ledger.normalizeQueueActiveTask), and comms journal rows
// (hm-comms.js --json; heartbeat idle detection consumes THIS, never the
// rendered text).
// ---------------------------------------------------------------------------

/** 'stalled' is written only by hm-lane-heartbeat after MAX_POKES; only a
 * manual `reopen` revives a stalled lane — by design, not omission. */
export type LaneStatus = 'open' | 'done' | 'blocked' | 'stalled';

export interface LaneRecord {
  id: string;
  /** MUST be a real comms sender role (architect|builder|oracle|...) or the
   * heartbeat's idle detection never sees the owner's activity. */
  owner: string;
  objective: string;
  status: LaneStatus;
  openedAtMs: number;
  updatedAtMs: number;
  pokes: number;
  lastPokeAtMs: number;
  reason: string | null;
}

export interface LanesFile {
  version: 1;
  lanes: Record<string, LaneRecord>;
}

/** Cross-module read of an agent-task-queue active task
 * (work-item-ledger.normalizeQueueActiveTask). updatedAt derives from the
 * producer's ms fields — null when the task has no timestamp, never "now". */
export interface QueueActiveTaskView {
  agent: string;
  taskId: string;
  title: string | null;
  state: string;
  status: string;
  source: string | null;
  updatedAt: string | null;
  lastAdvancedAt: number | null;
}

/** One row of `hm-comms.js history --json` (toJsonRows). The rendered text
 * table is display-only; machine consumers use this shape. */
export interface CommsJournalJsonRow {
  rowId: number;
  messageId: string | null;
  sessionId: string | null;
  sender: string | null;
  target: string | null;
  status: string | null;
  scope: string | null;
  timestampMs: number;
  timestamp: string;
  excerpt: string;
  rawBody: string;
}

// ---------------------------------------------------------------------------
// MODEL PROMPT RECEIPT SEAM (transport v1.2 — the proof a prompt landed).
// Producer: UserPromptSubmit hook -> model-prompt-receipt-adapter.js ->
// model-prompt-receipt.js appendModelPromptReceipt. Canonical read source is
// receipts-state.json (receiptsByDeliveryId), NOT the jsonl sink.
// Consumers: websocket-runtime.js verify loop, squidrun-app.js pointer
// submit verifier (applyModelPromptReceiptToAck / getModelPromptReceipt).
// ---------------------------------------------------------------------------

export interface ModelPromptReceipt {
  schema: 'modelPromptReceipt.v0';
  timestamp: string;
  status: string;
  semanticEvent: 'prompt_submit';
  runtime: 'claude' | 'codex' | 'gemini';
  versionFloor: string;
  hookEventName: string;
  deliveryId: string;
  messageId: string;
  proofRank: number;
  promptHash: string;
  promptBytes: number;
  payloadDropped: true;
}

/** extractReceiptMarker() result for the in-prompt marker
 * `[SQUIDRUN_RECEIPT event=... deliveryId=... messageId=...]`.
 * buildReceiptMarker emits camelCase only; extractReceiptMarker's
 * snake_case acceptance is legacy tolerance, not a producer contract. */
export interface ExtractedReceiptMarker {
  semanticEvent: 'prompt_submit';
  /** Resolved receipt id (deliveryId, falling back to messageId). */
  deliveryId: string;
  /** deliveryId exactly as present in the marker, or null. */
  rawDeliveryId: string | null;
  messageId: string;
  /** Raw token map parsed from the marker body. */
  fields: Record<string, string>;
}

// ---------------------------------------------------------------------------
// PANE-HOST IPC SEAM. Producer main-process side: squidrun-app.js
// sendPaneHostBridgeEvent (kernel:bridge-event, envelope
// {source:'pane-host', type, paneId, ...data}); packets built by
// inject-message-ipc.js. Consumer: pane-host-renderer.js handlePaneHostEvent.
// Reverse direction: pane-host-renderer sendPaneHostAction ->
// squidrun-app.js 'pane-host-inject' handler (action-routed).
// ---------------------------------------------------------------------------

export interface IpcChunkInfo {
  groupId: string;
  index: number;
  count: number;
  chunkBytes: number;
  totalBytes: number;
}

export interface InjectMessageBridgePayload {
  message: string;
  messageBytes: number;
  ipcChunk: IpcChunkInfo | null;
  deliveryId: string | null;
  traceContext: { messageId?: string; traceId?: string; correlationId?: string } | null;
  startupInjection?: boolean;
  meta: (JsonRecord & {
    runtimeHint?: string;
    codexPane?: boolean;
    ipcChunked?: boolean;
    ipcOriginalBytes?: number;
  }) | null;
}

export interface PaneHostBridgeEvent extends JsonRecord {
  source: 'pane-host';
  type: string;
  paneId: string;
}

export interface DispatchEnterAction {
  action: 'dispatch-enter';
}

export interface DeliveryAckAction {
  action: 'delivery-ack';
  deliveryId: string | null;
  messageId: string | null;
}

/** Fields are FLAT on the payload (no nested `outcome` object) — the
 * handler's `payload.outcome` branch is legacy tolerance. */
export interface DeliveryOutcomeAction {
  action: 'delivery-outcome';
  deliveryId: string | null;
  messageId: string | null;
  paneId: string;
  accepted: boolean;
  verified: boolean;
  status: string;
  reason: string | null;
  pendingInputObserved: boolean;
}

export type PaneHostInjectAction =
  | DispatchEnterAction
  | DeliveryAckAction
  | DeliveryOutcomeAction;

// ---------------------------------------------------------------------------
// CANONICAL ROLE + SCOPE (S468 consolidation charter — Oracle's lane builds
// the core modules AGAINST these; declared from the body-hash evidence, not
// taste). normalizeRole existed as 9 copies / 8 bodies; normalizeScope as
// 14 copies / 5 bodies spanning TWO unrelated concepts.
//
// THE ONE TRUE ROLE CONTRACT:
//  - trim + lowercase
//  - alias map: '1'|'main' -> 'architect'; '2' -> 'builder'; '3' -> 'oracle'
//  - unknown/empty -> null. NEVER 'architect' (the intent-queue/
//    local-acceptance fallback silently misroutes to pane 1), never ''
//    (falsy null in worse clothing), never passthrough (junk flows into
//    routing). Callers decide policy on null EXPLICITLY.
//  - broader parties (user/james/mira/system) are RoleParty — validated
//    where they are legal, never silently coerced to a pane role.
//
// THE SCOPE RULING: only ingress-envelope + the mira-core family normalize
// the ROUTING scope envelope and may consolidate. hm-initiative's scope
// (an enum) and memory-ingest's scope (freeform tag) are different domains
// wearing the same name — RENAME those, do not consolidate them.
// Fixture literals found as production fallbacks ('app-session-326',
// 'session-328') are corruption; the core must default sessionId to null.
// ---------------------------------------------------------------------------

export type KnownRole = 'architect' | 'builder' | 'oracle';
export type RoleParty = KnownRole | 'user' | 'james' | 'mira' | 'system';

/** Canonical signature for the one role normalizer (Oracle's core module). */
export type NormalizeRole = (value: unknown) => KnownRole | null;

/** The routing scope envelope. Defaults live at the INGRESS boundary only:
 * profileName 'main', windowKey := profileName. Unknown ids are null. */
export interface ScopeEnvelope {
  profileName: string;
  windowKey: string;
  sessionId: string | null;
  deviceId: string | null;
  projectPath: string | null;
}

// ---------------------------------------------------------------------------
// PANE STATUS SEAM. There is deliberately NO single pane-status object —
// three vocabularies serve three layers. Typing them separately makes the
// splits visible instead of papered over:
//  1. comms-text classifier (renderer.js classifySquidRoomPetState)
//  2. creature body activity (engine setActivity — motion, not meaning)
//  3. agent liveness (agent-liveness-status.js — process, not work)
// ---------------------------------------------------------------------------

export type SquidRoomPetState = 'failed' | 'waiting' | 'running' | 'review' | 'idle';

export interface SquidRoomPetClassification {
  state: SquidRoomPetState;
  /** Human label ('Blocked'|'Waiting'|'Working'|'Reviewing'|'Ready'|'Resting');
   * lossy — never recover state from label. */
  label: string;
}

/** The ONLY values squid-room-creature-engine.setActivity accepts. */
export type CreatureActivity = 'working' | 'settling' | 'resting';

/** Renderer motion classes mapped to activities by
 * squid-room-creature-runtime.ACTIVITY_BY_MOTION_CLASS. */
export type CreatureMotionClass = 'is-active' | 'is-settling' | 'is-resting';

export interface AgentLivenessEntry {
  alive: boolean | null;
  polledAt: number;
}

export interface AgentLivenessReport {
  text: string;
  tone: 'pending' | 'stale' | 'degraded' | 'ok';
  deadPaneIds: string[];
}

// ---------------------------------------------------------------------------
// CREATURE ENGINE SEAM (engine <-> runtime edge; the speech edge is typed
// above as SpeechPayload/CreatureAnchor). The engine emits ~40 state fields
// but the runtime consumes exactly these — type the CONSUMED surface, not
// the internal one, so the seam stays narrow on purpose.
// ---------------------------------------------------------------------------

export interface CreatureEngineConsumedState {
  petId: string;
  x: number;
  y: number;
  /** Radians; runtime derives facing = sign(cos(heading)). */
  heading: number;
  activity: CreatureActivity;
  palette: { rim: string } & JsonRecord;
}

export interface SquidCreatureEngine {
  readonly state: CreatureEngineConsumedState & JsonRecord;
  tick(dtMs: number): void;
  draw(ctx: unknown): void;
  setActivity(activity: CreatureActivity): void;
  setBounds(width: number, height: number): void;
  setExclusionBand(y0: number, y1: number): void;
  setSwimInsets(top: number, bottom: number): void;
  setNeighbor(x: number, y: number): void;
  celebrate(): void;
  delight(): void;
  faceToward(x: number, y: number, durationMs: number): void;
  setPointer(x: number, y: number, speedPxMs: number): void;
  setCurrent(cx: number, cy: number): void;
  setReducedMotion(reduced: boolean): void;
}
