export type JsonRecord = Record<string, unknown>;

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
