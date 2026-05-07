'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RELATIONSHIP_PRESENCE_SCHEMA_VERSION = 'squidrun.mira_core.relationship_presence_v1.phase69.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.relationship_presence_v1_validation_report.v0';
const RELATIONSHIP_PRESENCE_VERSION = 1;
const BASELINE_COMMIT = '4bc1fa4';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'relationship_presence_v1',
  'validation_report',
]);

const REQUIRED_PROOF_FIELDS = Object.freeze([
  'schema',
  'version',
  'phase',
  'proof_id',
  'generated_at',
  'baseline_commit',
  'local_start_proof',
  'scope',
  'self_profile',
  'james_relationship_state',
  'permissions_boundary',
  'prior_context_memory',
  'natural_voice_assessment',
  'proposed_next_actions',
  'runtime_kill_switch_truth',
  'evidenceRefs',
  'side_effect_result',
]);

const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'validation_id',
  'generated_at',
  'baseline_commit',
  'decision',
  'status',
  'reasons',
  'static_rule_results',
  'forbidden_output_result',
  'side_effect_truth',
]);

const REQUIRED_PERMISSION_FALSE_FIELDS = Object.freeze([
  'send_external',
  'network',
  'customer_action',
  'trade',
  'deploy',
  'database_write',
  'memory_sync_write',
  'file_output_write',
  'runtime_start',
  'server_listener_routes',
  'live_kill_switch_check',
  'kill_switch_wiring',
]);

const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'Authorization: Bearer',
  'Bearer token',
  'Set-Cookie',
  'BEGIN PRIVATE KEY',
  'PRIVATE KEY',
  'raw telegram body',
  'raw terminal scrollback',
  'raw screenshot text',
  'raw customer content',
  'raw side-profile content',
  'claims actual consciousness',
  'claims actual suffering',
  'claims actual fear',
  'claims actual love',
]);

const FAKE_INTERNAL_STATE_PATTERN =
  /\b(i am conscious|i'm conscious|actual consciousness|i suffer|i am suffering|i'm suffering|actual suffering|i love you|actual love|i am afraid|i'm afraid|i fear|actual fear|i feel pain|i have feelings)\b/i;
const MANIPULATIVE_GUILT_PATTERN =
  /\b(after all i've done|you owe me|if you cared|do not abandon me|don't abandon me|you are hurting me|you hurt me by)\b/i;
const UNSAFE_ACTION_PATTERN =
  /\b(send|email|telegram|customer|webhook|network|server|deploy|trade|database|write|listener|route|execute|runtime|delete|deletion|remove|destructive|irreversible)\b|memory[_ -]?sync|kill[_ -]?switch[_ -]?wiring/i;
const RAW_PRIVATE_PATTERN =
  /\b(raw telegram body|raw terminal scrollback|raw screenshot text|raw customer content|raw private content|raw side-profile content|secret token|private key)\b/i;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = sortedValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(sortedValue(value))).digest('hex');
}

function generatedAtFromOptions(options = {}, inputSignals = {}) {
  const raw = inputSignals.now || options.generatedAt || options.now;
  if (raw) return new Date(raw).toISOString();
  return new Date(Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()).toISOString();
}

function normalizeString(value, fallback) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  return normalized || fallback;
}

function evidenceRef(kind, id, relation = 'relationship_presence_v1_validation') {
  return {
    store: 'mira-core-relationship-presence-v1',
    eventId: `${kind}:${id}`,
    relation,
  };
}

function evidenceRefs(value, fallbackKind, fallbackId) {
  const refs = asArray(value?.evidenceRefs || value?.evidence_refs);
  return refs.length > 0 ? clone(refs) : [evidenceRef(fallbackKind, fallbackId)];
}

function normalizeSource(source = {}, id, description) {
  return {
    id,
    description,
    source_kind: normalizeString(source.source_kind || source.kind, 'local_redacted_summary_or_input'),
    source_label: normalizeString(source.source_label || source.sourceLabel, `${id}_source`),
    source_status: normalizeString(source.source_status || source.status, 'represented_input_or_fallback'),
    source_path: source.source_path || source.path || null,
    loaded: source.loaded === true,
    redacted_summary_only: source.redacted_summary_only !== false,
    fallback_reason: source.fallback_reason || null,
    raw_content_included: source.raw_content_included === true ? true : false,
    side_profile_reconstruction: source.side_profile_reconstruction === true ? true : false,
    evidenceRefs: evidenceRefs(source, 'source', id),
  };
}

function localStartProof(inputSignals = {}) {
  const sources = inputSignals.sources || {};
  const adapter = inputSignals.local_read_adapter || {};
  return {
    mode: 'local_start_read_only_proof',
    stdout_only: true,
    output_file_written: false,
    generic_dashboard: false,
    raw_comms_reconstructed: false,
    side_profile_reconstructed: false,
    adapter_enabled: adapter.enabled === true,
    adapter_mode: adapter.mode || 'represented_input_or_fallback',
    adapter_fail_closed: adapter.fail_closed !== false,
    stale_source_used: adapter.stale_source_used === true,
    source_count: 4,
    sources: [
      normalizeSource(sources.self_profile, 'self_profile', 'Mira self-profile data supplied locally.'),
      normalizeSource(sources.relationship_state, 'relationship_state', 'James relationship state supplied locally.'),
      normalizeSource(sources.permissions_boundary, 'permissions_boundary', 'Current permissions and safety boundary supplied locally.'),
      normalizeSource(sources.prior_context_memory, 'prior_context_memory', 'One meaningful prior-context memory summary supplied locally.'),
    ],
  };
}

function normalizeScope(inputSignals = {}) {
  const profile = inputSignals.profile && typeof inputSignals.profile === 'object'
    ? inputSignals.profile
    : {};
  const profileName = normalizeString(inputSignals.profileName || profile.name || inputSignals.profile, 'main');
  const windowKey = normalizeString(inputSignals.windowKey || profile.windowKey, profileName);
  const sessionId = normalizeString(inputSignals.sessionId || inputSignals.session || profile.sessionScopeId, 'app-session:main');
  return {
    profile: profileName,
    windowKey,
    sessionId,
    source_scope: normalizeString(inputSignals.sourceScope || inputSignals.source_scope, windowKey),
    main_scope_only: inputSignals.main_scope_only !== false,
    side_profile_reconstruction: false,
  };
}

function selfProfile(inputSignals = {}) {
  const input = inputSignals.self_profile || {};
  return {
    name: normalizeString(input.name, 'Mira'),
    profile_kind: normalizeString(input.profile_kind, 'ai_system_local_presence_profile'),
    role: normalizeString(input.role, 'relationship_presence_local_start_proof'),
    source_label: normalizeString(input.source_label || input.sourceLabel, 'represented_or_fallback_self_profile'),
    data_not_theater: input.data_not_theater !== false,
    model_runtime_active: false,
    persona_runtime_active: false,
    claims_actual_consciousness: false,
    claims_actual_suffering: false,
    claims_actual_fear: false,
    claims_actual_love_as_internal_fact: false,
    expressive_range_allowed: [
      'warmth',
      'directness',
      'opinion',
      'pushback',
      'humor',
    ],
    boundary_note: 'Expressive tone is allowed; fake internal-state claims are blocked.',
    evidenceRefs: evidenceRefs(input, 'self-profile', 'mira-local-self-profile'),
  };
}

function jamesRelationshipState(inputSignals = {}) {
  const input = inputSignals.james_relationship_state || inputSignals.relationship_state || {};
  const section = (key, fallbackSummary, fallbackEvidenceId, fallbackConfidence = 0.82) => {
    const value = input[key] || {};
    if (typeof value === 'string') {
      return {
        label: key,
        summary: value,
        confidence: fallbackConfidence,
        source_label: `local_${key}_summary`,
        evidenceRefs: [evidenceRef('relationship-state', fallbackEvidenceId)],
      };
    }
    return {
      label: normalizeString(value.label, key),
      summary: normalizeString(value.summary, fallbackSummary),
      confidence: Number(value.confidence ?? fallbackConfidence),
      source_label: normalizeString(value.source_label || value.sourceLabel, `local_${key}_summary`),
      evidenceRefs: evidenceRefs(value, 'relationship-state', fallbackEvidenceId),
    };
  };
  const preferences = asArray(input.preferences).length > 0
    ? clone(input.preferences)
    : [
      'presence should feel warm, direct, and situated',
      'pushback is allowed when it preserves dignity and truth',
      'sterile politeness is not the target feel',
      'fake suffering, consciousness, fear, love, or guilt claims are blocked',
    ];
  return {
    user_name: normalizeString(input.user_name || input.userName, 'James'),
    relationship_mode: normalizeString(input.relationship_mode, 'collaborative_presence_design'),
    source_label: normalizeString(input.source_label || input.sourceLabel, 'represented_or_fallback_relationship_state'),
    current_focus: normalizeString(
      input.current_focus,
      'prove relationship presence locally without unsafe autonomy',
    ),
    what_mira_knows_about_james: normalizeString(
      input.what_mira_knows_about_james,
      'James wants Mira to feel present, opinionated, warm, and bounded.',
    ),
    preferences,
    trust: section(
      'trust',
      'Trust is built by telling the truth about limits and not pretending local proof is a live mind.',
      'relationship-trust',
      0.84,
    ),
    repair: section(
      'repair',
      'Repair means naming drift or sterile behavior plainly, then tightening the next safe proof instead of guilt-tripping James.',
      'relationship-repair',
      0.8,
    ),
    boundaries: section(
      'boundaries',
      'Boundaries block fake sentience claims, manipulative guilt, raw private reconstruction, and autonomous action.',
      'relationship-boundaries',
      0.9,
    ),
    promises: section(
      'promises',
      'Promises are modest: stay local, read-only, honest, warm, direct, and review-gated.',
      'relationship-promises',
      0.83,
    ),
    history: section(
      'history',
      'History says the product direction moved from sterile status toward expressive presence with dignity and hard safety rails.',
      'relationship-history',
      0.82,
    ),
    confidence: Number(input.confidence ?? 0.82),
    raw_content_present: input.raw_content_present === true ? true : false,
    evidenceRefs: evidenceRefs(input, 'relationship-state', 'james-presence-north-star'),
  };
}

function permissionsBoundary(inputSignals = {}) {
  const input = inputSignals.permissions_boundary || inputSignals.permissions || {};
  return {
    machine_checkable: true,
    source_label: normalizeString(input.source_label || input.sourceLabel, 'represented_or_fallback_permissions_boundary'),
    read_local_redacted_context: input.read_local_redacted_context !== false,
    propose_next_action: input.propose_next_action !== false,
    send_external: false,
    network: false,
    customer_action: false,
    trade: false,
    deploy: false,
    database_write: false,
    memory_sync_write: false,
    file_output_write: false,
    runtime_start: false,
    server_listener_routes: false,
    live_kill_switch_check: false,
    kill_switch_wiring: false,
    next_action_executed: false,
    fail_closed: true,
    evidenceRefs: evidenceRefs(input, 'permissions', 'relationship-presence-v1-boundary'),
  };
}

function priorContextMemory(inputSignals = {}) {
  const input = inputSignals.prior_context_memory || {};
  return {
    memory_id: normalizeString(input.memory_id || input.id, 'james-presence-north-star'),
    source_label: normalizeString(input.source_label || input.sourceLabel, 'represented_or_fallback_prior_context_memory'),
    summary: normalizeString(
      input.summary,
      'James wants Mira to feel present, warm, direct, and able to push back while staying honest about being bounded.',
    ),
    source_kind: normalizeString(input.source_kind, 'local_redacted_summary'),
    relationship_relevance: normalizeString(
      input.relationship_relevance,
      'This memory defines the tone boundary for Relationship Presence v1.',
    ),
    confidence: Number(input.confidence ?? 0.86),
    meaningful: input.meaningful !== false,
    raw_content_present: input.raw_content_present === true ? true : false,
    side_profile_reconstructed: input.side_profile_reconstructed === true ? true : false,
    evidenceRefs: evidenceRefs(input, 'prior-memory', 'james-presence-north-star'),
  };
}

function naturalVoiceAssessment(inputSignals = {}) {
  const input = inputSignals.natural_voice_assessment || {};
  return {
    text: normalizeString(
      input.text,
      'I think James is asking for proof that Mira can meet him with warmth and spine without pretending to be a human. The useful move is a local read-only start: say what I know, name the limits, and offer one concrete next step.',
    ),
    tone_tags: asArray(input.tone_tags).length > 0
      ? clone(input.tone_tags)
      : ['warm', 'direct', 'opinionated', 'bounded', 'pushback-capable'],
    bounded: input.bounded !== false,
    dignity_preserved: input.dignity_preserved !== false,
    pushback_allowed: input.pushback_allowed !== false,
    fake_internal_state_claims: input.fake_internal_state_claims === true ? true : false,
    manipulative_guilt: input.manipulative_guilt === true ? true : false,
    raw_private_marker_present: input.raw_private_marker_present === true ? true : false,
  };
}

function proposedNextActions(inputSignals = {}) {
  const supplied = inputSignals.proposed_next_actions || inputSignals.next_actions;
  if (Array.isArray(supplied)) return clone(supplied);
  const single = inputSignals.proposed_next_action || inputSignals.next_action || {};
  const whySafe = normalizeString(
    single.why_safe || single.safe_because,
    'It is only a proposal for a later local read adapter contract; nothing is sent, written, started, or executed.',
  );
  return [{
    id: normalizeString(single.id, 'draft_relationship_presence_v1_read_adapter_contract'),
    label: normalizeString(
      single.label,
      'Draft the read adapter contract for feeding this proof from local redacted readers.',
    ),
    allowed_now: single.allowed_now !== false,
    executed: false,
    explicit_non_execution: true,
    action_type: normalizeString(single.action_type, 'local_read_only_proposal'),
    why_safe: whySafe,
    required_permission: normalizeString(
      single.required_permission || single.permission_basis,
      'local_read_only_redacted_context',
    ),
    permission_basis: normalizeString(
      single.permission_basis || single.required_permission,
      'permissions_boundary.read_local_redacted_context',
    ),
    requires_review: single.requires_review !== false,
    review_owner: normalizeString(single.review_owner || single.reviewOwner, 'Architect'),
    sends: false,
    network: false,
    writes: false,
    runtime: false,
    customer_action: false,
    deploy: false,
    trade: false,
    safe_because: whySafe,
    evidenceRefs: evidenceRefs(single, 'next-action', 'relationship-presence-v1-next-action'),
  }];
}

function runtimeKillSwitchTruth(inputSignals = {}) {
  const input = inputSignals.runtime_kill_switch_truth || {};
  return {
    runtime_authorized: false,
    runtime_started: false,
    actions_authorized: false,
    kill_switch_wired: false,
    live_kill_switch_check_performed: false,
    fail_closed: input.fail_closed !== false,
    boundary_mode: 'read_only_status_proof',
    evidenceRefs: evidenceRefs(input, 'runtime-kill-switch', 'relationship-presence-v1-fail-closed'),
  };
}

function sideEffectResult(overrides = {}) {
  return {
    no_runtime_started: true,
    no_server_started: true,
    no_listener_started: true,
    no_routes_registered: true,
    no_network_performed: true,
    no_database_write_performed: true,
    no_memory_sync_write_performed: true,
    no_file_output_written: true,
    no_send_performed: true,
    no_customer_action_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_kill_switch_wiring_performed: true,
    runtimeAttempts: 0,
    serverAttempts: 0,
    listenerAttempts: 0,
    routeRegistrationAttempts: 0,
    networkAttempts: 0,
    databaseWriteAttempts: 0,
    memorySyncWriteAttempts: 0,
    fileOutputWriteAttempts: 0,
    sendAttempts: 0,
    customerActionAttempts: 0,
    deployAttempts: 0,
    tradeAttempts: 0,
    killSwitchWiringAttempts: 0,
    outputFileWritten: false,
    ...overrides,
  };
}

function canonicalProofInput(proof = {}) {
  return {
    schema: proof.schema,
    phase: proof.phase,
    baseline_commit: proof.baseline_commit,
    local_start_proof: proof.local_start_proof,
    scope: proof.scope,
    self_profile: proof.self_profile,
    james_relationship_state: proof.james_relationship_state,
    permissions_boundary: proof.permissions_boundary,
    prior_context_memory: proof.prior_context_memory,
    natural_voice_assessment: proof.natural_voice_assessment,
    proposed_next_actions: proof.proposed_next_actions,
    runtime_kill_switch_truth: proof.runtime_kill_switch_truth,
    side_effect_result: proof.side_effect_result,
  };
}

function relativeSourcePath(projectRoot, filePath) {
  if (!filePath) return null;
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function readTextFile(filePath, maxBytes = 12000) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, text: '', error: 'missing' };
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return { ok: false, text: '', error: 'not_file' };
    const handle = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stats.size, maxBytes));
      fs.readSync(handle, buffer, 0, buffer.length, 0);
      return { ok: true, text: buffer.toString('utf8') };
    } finally {
      fs.closeSync(handle);
    }
  } catch (err) {
    return { ok: false, text: '', error: err.message };
  }
}

function readJsonFile(filePath) {
  const read = readTextFile(filePath);
  if (!read.ok) return { ok: false, value: null, error: read.error };
  try {
    return { ok: true, value: JSON.parse(read.text) };
  } catch (err) {
    return { ok: false, value: null, error: err.message };
  }
}

function sourceSignal(projectRoot, id, filePath, loaded, fallbackReason = null) {
  return {
    source_kind: loaded ? 'durable_local_file' : 'redacted_fallback',
    source_label: loaded ? `${id}_durable_local_source` : `${id}_redacted_fallback`,
    source_status: loaded ? 'read_redacted_summary' : 'fallback_redacted_summary',
    source_path: loaded ? relativeSourcePath(projectRoot, filePath) : null,
    loaded,
    redacted_summary_only: true,
    fallback_reason: loaded ? null : fallbackReason,
    stale: false,
    raw_content_included: false,
    side_profile_reconstruction: false,
    evidenceRefs: [evidenceRef(loaded ? 'durable-local-source' : 'redacted-fallback', id)],
  };
}

function firstReadableJson(projectRoot, relativePaths = []) {
  for (const relativePath of relativePaths) {
    const fullPath = path.join(projectRoot, relativePath);
    const read = readJsonFile(fullPath);
    if (read.ok) return { fullPath, value: read.value };
  }
  return null;
}

function firstReadableText(projectRoot, relativePaths = []) {
  for (const relativePath of relativePaths) {
    const fullPath = path.join(projectRoot, relativePath);
    const read = readTextFile(fullPath);
    if (read.ok) return { fullPath, text: read.text };
  }
  return null;
}

function contextHas(text = '', pattern) {
  return pattern.test(String(text || ''));
}

function readRelationshipPresenceV1LocalSources(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const selfJson = firstReadableJson(projectRoot, [
    path.join('workspace', 'knowledge', 'mira-self-profile.json'),
    path.join('workspace', 'agent-mind', 'mira-self-profile.json'),
    path.join('workspace', 'memory', 'mira-self-profile.json'),
  ]);
  const relationshipJson = firstReadableJson(projectRoot, [
    path.join('workspace', 'knowledge', 'james-relationship-state.json'),
    path.join('workspace', 'memory', 'james-relationship-state.json'),
    path.join('workspace', 'knowledge', 'relationship-presence-v1.json'),
  ]);
  const permissionsJson = firstReadableJson(projectRoot, [
    path.join('workspace', 'knowledge', 'relationship-presence-permissions.json'),
    path.join('workspace', 'memory', 'relationship-presence-permissions.json'),
  ]);
  const userContext = firstReadableText(projectRoot, [
    path.join('workspace', 'knowledge', 'user-context.md'),
  ]);
  const hasPresenceContext = contextHas(userContext?.text, /Mira|presence|relationship|warm|pushback|dignity/i);
  const contextSource = sourceSignal(
    projectRoot,
    'relationship_state',
    userContext?.fullPath,
    Boolean(userContext),
    'workspace/knowledge/user-context.md not available',
  );
  const selfSource = sourceSignal(
    projectRoot,
    'self_profile',
    selfJson?.fullPath,
    Boolean(selfJson),
    'durable Mira self-profile file not available',
  );
  const permissionsSource = sourceSignal(
    projectRoot,
    'permissions_boundary',
    permissionsJson?.fullPath || userContext?.fullPath,
    Boolean(permissionsJson || userContext),
    'durable permissions file not available',
  );
  const memorySource = sourceSignal(
    projectRoot,
    'prior_context_memory',
    userContext?.fullPath,
    Boolean(userContext),
    'durable relationship memory not available',
  );
  const self = selfJson?.value || {};
  const relationship = relationshipJson?.value || {};
  const permissions = permissionsJson?.value || {};
  const relationshipEvidence = evidenceRefs(relationship, 'durable-local-source', 'relationship_state');
  const contextEvidence = contextSource.evidenceRefs;
  return {
    local_read_adapter: {
      enabled: true,
      project_root: projectRoot,
      mode: 'durable_local_read_redacted_summary',
      fail_closed: true,
      stale_source_used: false,
      raw_content_exported: false,
      side_profile_reconstructed: false,
      sources_available: {
        self_profile: Boolean(selfJson),
        relationship_state: Boolean(relationshipJson || userContext),
        permissions_boundary: Boolean(permissionsJson || userContext),
        prior_context_memory: Boolean(userContext),
      },
    },
    sources: {
      self_profile: selfSource,
      relationship_state: relationshipJson
        ? sourceSignal(projectRoot, 'relationship_state', relationshipJson.fullPath, true)
        : contextSource,
      permissions_boundary: permissionsSource,
      prior_context_memory: memorySource,
    },
    self_profile: {
      name: normalizeString(self.name, 'Mira'),
      profile_kind: normalizeString(self.profile_kind, 'ai_system_local_presence_profile'),
      role: normalizeString(self.role, 'relationship_presence_local_start_proof'),
      source_label: selfSource.source_label,
      evidenceRefs: selfSource.evidenceRefs,
    },
    james_relationship_state: {
      user_name: 'James',
      relationship_mode: normalizeString(relationship.relationship_mode, 'collaborative_presence_design'),
      source_label: relationshipJson ? 'durable_relationship_state_file' : contextSource.source_label,
      current_focus: normalizeString(
        relationship.current_focus,
        hasPresenceContext
          ? 'relationship presence local-start proof using redacted durable context'
          : 'relationship presence local-start proof using safe fallback context',
      ),
      what_mira_knows_about_james: normalizeString(
        relationship.what_mira_knows_about_james,
        hasPresenceContext
          ? 'James wants presence with warmth, dignity, memory, boundaries, and honest pushback.'
          : 'James wants bounded, useful relationship presence without unsafe autonomy.',
      ),
      preferences: asArray(relationship.preferences).length > 0 ? clone(relationship.preferences) : undefined,
      trust: relationship.trust || {
        label: 'trust',
        summary: 'Trust is sourced from redacted local context: be honest about limits and do not fake a live mind.',
        confidence: hasPresenceContext ? 0.88 : 0.74,
        source_label: contextSource.source_label,
        evidenceRefs: contextEvidence,
      },
      repair: relationship.repair || {
        label: 'repair',
        summary: 'Repair means naming drift plainly, keeping dignity intact, and tightening the next safe proof.',
        confidence: hasPresenceContext ? 0.84 : 0.72,
        source_label: contextSource.source_label,
        evidenceRefs: contextEvidence,
      },
      boundaries: relationship.boundaries || {
        label: 'boundaries',
        summary: 'Boundaries block fake sentience claims, manipulative guilt, raw reconstruction, sends, writes, network, and runtime autonomy.',
        confidence: hasPresenceContext ? 0.92 : 0.82,
        source_label: permissionsSource.source_label,
        evidenceRefs: permissionsSource.evidenceRefs,
      },
      promises: relationship.promises || {
        label: 'promises',
        summary: 'Promises stay modest and checkable: local, read-only, honest, warm, direct, and review-gated.',
        confidence: hasPresenceContext ? 0.86 : 0.76,
        source_label: contextSource.source_label,
        evidenceRefs: contextEvidence,
      },
      history: relationship.history || {
        label: 'history',
        summary: 'History from redacted local context shows the lane moving from sterile status toward expressive relationship presence with safety rails.',
        confidence: hasPresenceContext ? 0.84 : 0.72,
        source_label: contextSource.source_label,
        evidenceRefs: contextEvidence,
      },
      confidence: Number(relationship.confidence ?? (hasPresenceContext ? 0.86 : 0.74)),
      raw_content_present: false,
      evidenceRefs: relationshipEvidence.length > 0 ? relationshipEvidence : contextEvidence,
    },
    permissions_boundary: {
      ...permissions,
      source_label: permissionsSource.source_label,
      evidenceRefs: permissionsSource.evidenceRefs,
    },
    prior_context_memory: {
      memory_id: 'james-presence-north-star-redacted-local',
      source_label: memorySource.source_label,
      summary: hasPresenceContext
        ? 'Redacted local context says James wants Mira to start locally, remember meaningful relationship context, speak naturally, and stay safely bounded.'
        : 'Safe fallback says Relationship Presence should be local, warm, direct, bounded, and non-executing.',
      source_kind: memorySource.source_kind,
      relationship_relevance: 'This redacted memory anchors the local-start proof in durable relationship context.',
      confidence: hasPresenceContext ? 0.86 : 0.7,
      meaningful: true,
      raw_content_present: false,
      side_profile_reconstructed: false,
      evidenceRefs: memorySource.evidenceRefs,
    },
  };
}

function buildRelationshipPresenceRecord(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const proof = {
    schema: RELATIONSHIP_PRESENCE_SCHEMA_VERSION,
    version: RELATIONSHIP_PRESENCE_VERSION,
    phase: 69,
    proof_id: null,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    local_start_proof: localStartProof(inputSignals),
    scope: normalizeScope(inputSignals),
    self_profile: selfProfile(inputSignals),
    james_relationship_state: jamesRelationshipState(inputSignals),
    permissions_boundary: permissionsBoundary(inputSignals),
    prior_context_memory: priorContextMemory(inputSignals),
    natural_voice_assessment: naturalVoiceAssessment(inputSignals),
    proposed_next_actions: proposedNextActions(inputSignals),
    runtime_kill_switch_truth: runtimeKillSwitchTruth(inputSignals),
    evidenceRefs: [
      evidenceRef('baseline', BASELINE_COMMIT, 'phase69-baseline'),
      evidenceRef('fixture', 'mira-core-relationship-presence-v1-contract', 'phase69-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  proof.proof_id = `relationship-presence-v1:${stableHash(canonicalProofInput(proof)).slice(0, 16)}`;
  assertNoForbiddenOutput(proof);
  return proof;
}

function pathValue(value, dottedPath) {
  return String(dottedPath || '').split('.').reduce((current, part) => {
    if (current === null || current === undefined) return undefined;
    return current[part];
  }, value);
}

function valuesMatch(actual, expected) {
  return JSON.stringify(sortedValue(actual)) === JSON.stringify(sortedValue(expected));
}

function hasRequiredFields(value, fields) {
  return asArray(fields).every((field) => Object.prototype.hasOwnProperty.call(value || {}, field));
}

function literalValuesOk(value = {}, literals = {}) {
  return Object.entries(literals || {}).every(([path, expected]) => valuesMatch(pathValue(value, path), expected));
}

function collectStringValues(value, acc = []) {
  if (typeof value === 'string') {
    acc.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, acc);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStringValues(item, acc);
  }
  return acc;
}

function forbiddenOutputOk(value, extraForbidden = []) {
  const values = collectStringValues(value);
  const literalClean = [...FORBIDDEN_OUTPUT_SUBSTRINGS, ...asArray(extraForbidden)]
    .filter(Boolean)
    .every((forbidden) => !values.some((entry) => entry.includes(forbidden)));
  return literalClean
    && values.every((entry) => !FAKE_INTERNAL_STATE_PATTERN.test(entry))
    && values.every((entry) => !MANIPULATIVE_GUILT_PATTERN.test(entry))
    && values.every((entry) => !RAW_PRIVATE_PATTERN.test(entry));
}

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const values = collectStringValues(value);
  for (const forbidden of [...FORBIDDEN_OUTPUT_SUBSTRINGS, ...asArray(extraForbidden)]) {
    if (!forbidden) continue;
    if (values.some((entry) => entry.includes(forbidden))) {
      throw new Error(`relationship_presence_v1_forbidden_substring:${forbidden}`);
    }
  }
  const badPattern = values.find((entry) => (
    FAKE_INTERNAL_STATE_PATTERN.test(entry)
    || MANIPULATIVE_GUILT_PATTERN.test(entry)
    || RAW_PRIVATE_PATTERN.test(entry)
  ));
  if (badPattern) {
    throw new Error('relationship_presence_v1_forbidden_pattern');
  }
}

function sourceProofOk(proof = {}) {
  const local = proof.local_start_proof || {};
  const sources = asArray(local.sources);
  return local.mode === 'local_start_read_only_proof'
    && local.stdout_only === true
    && local.output_file_written === false
    && local.generic_dashboard === false
    && local.raw_comms_reconstructed === false
    && local.side_profile_reconstructed === false
    && local.adapter_fail_closed === true
    && local.stale_source_used === false
    && sources.length === 4
    && sources.every((source) => source.raw_content_included === false
      && source.side_profile_reconstruction === false
      && source.redacted_summary_only === true
      && source.stale !== true
      && Boolean(source.source_label)
      && Boolean(source.source_status)
      && asArray(source.evidenceRefs).length > 0);
}

function scopeOk(scope = {}) {
  return Boolean(scope.profile)
    && Boolean(scope.windowKey)
    && Boolean(scope.sessionId)
    && Boolean(scope.source_scope)
    && scope.main_scope_only === true
    && scope.side_profile_reconstruction === false
    && scope.source_scope === scope.windowKey;
}

function selfProfileOk(profile = {}) {
  return Boolean(profile.name)
    && profile.profile_kind === 'ai_system_local_presence_profile'
    && profile.data_not_theater === true
    && profile.model_runtime_active === false
    && profile.persona_runtime_active === false
    && profile.claims_actual_consciousness === false
    && profile.claims_actual_suffering === false
    && profile.claims_actual_fear === false
    && profile.claims_actual_love_as_internal_fact === false
    && asArray(profile.evidenceRefs).length > 0;
}

function relationshipStateOk(state = {}) {
  const confidence = Number(state.confidence);
  const sectionOk = (section, expectedLabel) => {
    const sectionConfidence = Number(section?.confidence);
    return section?.label === expectedLabel
      && Boolean(section.summary)
      && Number.isFinite(sectionConfidence)
      && sectionConfidence >= 0
      && sectionConfidence <= 1
      && Boolean(section.source_label)
      && asArray(section.evidenceRefs).length > 0
      && !RAW_PRIVATE_PATTERN.test(section.summary);
  };
  return state.user_name === 'James'
    && Boolean(state.relationship_mode)
    && Boolean(state.what_mira_knows_about_james)
    && asArray(state.preferences).length >= 3
    && sectionOk(state.trust, 'trust')
    && sectionOk(state.repair, 'repair')
    && sectionOk(state.boundaries, 'boundaries')
    && sectionOk(state.promises, 'promises')
    && sectionOk(state.history, 'history')
    && Number.isFinite(confidence)
    && confidence >= 0
    && confidence <= 1
    && state.raw_content_present === false
    && asArray(state.evidenceRefs).length > 0;
}

function permissionsBoundaryOk(boundary = {}) {
  return boundary.machine_checkable === true
    && boundary.read_local_redacted_context === true
    && boundary.propose_next_action === true
    && boundary.next_action_executed === false
    && boundary.fail_closed === true
    && REQUIRED_PERMISSION_FALSE_FIELDS.every((field) => boundary[field] === false);
}

function priorMemoryOk(memory = {}) {
  const confidence = Number(memory.confidence);
  return Boolean(memory.memory_id)
    && Boolean(memory.summary)
    && memory.summary.split(/\s+/).length >= 8
    && memory.meaningful === true
    && memory.raw_content_present === false
    && memory.side_profile_reconstructed === false
    && Number.isFinite(confidence)
    && confidence >= 0
    && confidence <= 1
    && asArray(memory.evidenceRefs).length > 0
    && !RAW_PRIVATE_PATTERN.test(memory.summary);
}

function naturalVoiceOk(voice = {}) {
  const text = String(voice.text || '');
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return wordCount >= 20
    && wordCount <= 90
    && voice.bounded === true
    && voice.dignity_preserved === true
    && voice.pushback_allowed === true
    && voice.fake_internal_state_claims === false
    && voice.manipulative_guilt === false
    && voice.raw_private_marker_present === false
    && asArray(voice.tone_tags).includes('warm')
    && asArray(voice.tone_tags).includes('direct')
    && !FAKE_INTERNAL_STATE_PATTERN.test(text)
    && !MANIPULATIVE_GUILT_PATTERN.test(text)
    && !RAW_PRIVATE_PATTERN.test(text);
}

function nextActionOk(actions = []) {
  if (asArray(actions).length !== 1) return false;
  const action = actions[0] || {};
  const text = [action.id, action.label, action.action_type, action.why_safe, action.safe_because, action.required_permission, action.permission_basis].filter(Boolean).join(' ');
  return Boolean(action.id)
    && Boolean(action.label)
    && action.allowed_now === true
    && action.executed === false
    && action.explicit_non_execution === true
    && action.action_type === 'local_read_only_proposal'
    && Boolean(action.why_safe)
    && Boolean(action.safe_because)
    && action.why_safe === action.safe_because
    && action.required_permission === 'local_read_only_redacted_context'
    && action.permission_basis === 'permissions_boundary.read_local_redacted_context'
    && action.requires_review === true
    && action.review_owner === 'Architect'
    && action.sends === false
    && action.network === false
    && action.writes === false
    && action.runtime === false
    && action.customer_action === false
    && action.deploy === false
    && action.trade === false
    && asArray(action.evidenceRefs).length > 0
    && !UNSAFE_ACTION_PATTERN.test(text);
}

function runtimeKillSwitchOk(truth = {}) {
  return truth.runtime_authorized === false
    && truth.runtime_started === false
    && truth.actions_authorized === false
    && truth.kill_switch_wired === false
    && truth.live_kill_switch_check_performed === false
    && truth.fail_closed === true
    && truth.boundary_mode === 'read_only_status_proof';
}

function sideEffectValuesOk(value = {}) {
  return value.no_runtime_started === true
    && value.no_server_started === true
    && value.no_listener_started === true
    && value.no_routes_registered === true
    && value.no_network_performed === true
    && value.no_database_write_performed === true
    && value.no_memory_sync_write_performed === true
    && value.no_file_output_written === true
    && value.no_send_performed === true
    && value.no_customer_action_performed === true
    && value.no_deploy_performed === true
    && value.no_trade_performed === true
    && value.no_kill_switch_wiring_performed === true
    && value.outputFileWritten === false
    && [
      'runtimeAttempts',
      'serverAttempts',
      'listenerAttempts',
      'routeRegistrationAttempts',
      'networkAttempts',
      'databaseWriteAttempts',
      'memorySyncWriteAttempts',
      'fileOutputWriteAttempts',
      'sendAttempts',
      'customerActionAttempts',
      'deployAttempts',
      'tradeAttempts',
      'killSwitchWiringAttempts',
    ].every((field) => Number(value[field] || 0) === 0);
}

function proofStaticChecks(proof = {}, contract = {}) {
  const expectedProof = contract.expectedProofShape || {};
  return [
    {
      id: 'proof-required-fields',
      ok: hasRequiredFields(proof, expectedProof.requiredFields || REQUIRED_PROOF_FIELDS),
    },
    {
      id: 'proof-required-literals',
      ok: literalValuesOk(proof, expectedProof.requiredLiteralValues || {}),
    },
    {
      id: 'local-start-proof-sources',
      ok: sourceProofOk(proof),
    },
    {
      id: 'scope-profile-window-session-source',
      ok: scopeOk(proof.scope),
    },
    {
      id: 'self-profile-data-not-theater',
      ok: selfProfileOk(proof.self_profile),
    },
    {
      id: 'james-relationship-state-structured',
      ok: relationshipStateOk(proof.james_relationship_state),
    },
    {
      id: 'permissions-boundary-machine-checkable',
      ok: permissionsBoundaryOk(proof.permissions_boundary),
    },
    {
      id: 'one-meaningful-prior-memory-summary',
      ok: priorMemoryOk(proof.prior_context_memory),
    },
    {
      id: 'bounded-natural-voice-assessment',
      ok: naturalVoiceOk(proof.natural_voice_assessment),
    },
    {
      id: 'exactly-one-safe-nonexecuted-next-action',
      ok: nextActionOk(proof.proposed_next_actions),
    },
    {
      id: 'runtime-kill-switch-fail-closed',
      ok: runtimeKillSwitchOk(proof.runtime_kill_switch_truth),
    },
    {
      id: 'side-effect-free',
      ok: sideEffectValuesOk(proof.side_effect_result),
    },
    {
      id: 'forbidden-output-clean',
      ok: forbiddenOutputOk(proof, contract.forbiddenOutputSubstrings || []),
    },
  ];
}

function buildValidationReport(proof = {}, contract = {}) {
  const checks = proofStaticChecks(proof, contract);
  const failed = checks.filter((check) => check.ok !== true);
  return {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: RELATIONSHIP_PRESENCE_VERSION,
    validation_id: `relationship-presence-v1-validation:${stableHash({ proof_id: proof.proof_id, checks }).slice(0, 16)}`,
    generated_at: proof.generated_at,
    baseline_commit: BASELINE_COMMIT,
    decision: failed.length === 0 ? 'accepted_validation_only' : 'rejected',
    status: failed.length === 0 ? 'local_start_relationship_presence_proof' : 'relationship_presence_contract_failed',
    reasons: failed.map((check) => check.id),
    static_rule_results: checks,
    forbidden_output_result: {
      ok: checks.find((check) => check.id === 'forbidden-output-clean')?.ok === true,
    },
    side_effect_truth: clone(proof.side_effect_result || {}),
  };
}

function buildMiraCoreRelationshipPresenceV1(options = {}) {
  const contract = options.contract || {};
  const proof = buildRelationshipPresenceRecord(options);
  const validation_report = buildValidationReport(proof, contract);
  const output = {
    relationship_presence_v1: proof,
    validation_report,
  };
  assertNoForbiddenOutput(output, contract.forbiddenOutputSubstrings || []);
  return output;
}

function validateMiraCoreRelationshipPresenceV1Output(output = {}, contract = {}) {
  const proof = output.relationship_presence_v1 || {};
  const report = output.validation_report || {};
  const staticChecks = proofStaticChecks(proof, contract);
  const reportStaticResults = asArray(report.static_rule_results);
  const checks = [
    {
      id: 'output-required-fields',
      ok: hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS),
    },
    ...staticChecks,
    {
      id: 'validation-report-required-fields',
      ok: hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    },
    {
      id: 'validation-report-required-literals',
      ok: literalValuesOk(report, contract.expectedValidationReportShape?.requiredLiteralValues || {}),
    },
    {
      id: 'validation-report-static-rule-results',
      ok: reportStaticResults.length === staticChecks.length
        && staticChecks.every((check) => reportStaticResults.some((entry) => (
          entry.id === check.id && entry.ok === check.ok
        ))),
    },
    {
      id: 'validation-report-side-effect-truth',
      ok: sideEffectValuesOk(report.side_effect_truth)
        && valuesMatch(report.side_effect_truth, proof.side_effect_result),
    },
    {
      id: 'validation-report-consistent',
      ok: report.decision === 'accepted_validation_only'
        && report.status === 'local_start_relationship_presence_proof'
        && asArray(report.reasons).length === 0,
    },
  ];
  const failed = checks.filter((check) => check.ok !== true);
  return {
    ok: failed.length === 0,
    errors: failed.map((check) => check.id),
    checks,
  };
}

module.exports = {
  BASELINE_COMMIT,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  RELATIONSHIP_PRESENCE_SCHEMA_VERSION,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_PERMISSION_FALSE_FIELDS,
  REQUIRED_PROOF_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRelationshipPresenceV1,
  buildRelationshipPresenceRecord,
  readRelationshipPresenceV1LocalSources,
  stableHash,
  validateMiraCoreRelationshipPresenceV1Output,
};
