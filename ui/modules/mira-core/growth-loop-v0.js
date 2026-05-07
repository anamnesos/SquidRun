'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GROWTH_LOOP_SCHEMA_VERSION = 'squidrun.mira_core.growth_loop_v0.phase70.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.growth_loop_v0_validation_report.v0';
const GROWTH_LOOP_VERSION = 1;
const BASELINE_COMMIT = '2b8eaa4';

const NAMED_ARTIFACT_PATHS = Object.freeze({
  self_profile: 'workspace/knowledge/mira-self-profile.json',
  relationship_state: 'workspace/knowledge/james-relationship-state.json',
  permissions: 'workspace/knowledge/relationship-presence-permissions.json',
  history_ledger: 'workspace/knowledge/relationship-growth-history.jsonl',
  audit_ledger: 'workspace/knowledge/relationship-growth-audit.jsonl',
});

const WRITABLE_ARTIFACT_IDS = Object.freeze([
  'self_profile',
  'relationship_state',
  'history_ledger',
  'audit_ledger',
]);

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'growth_loop_v0',
  'validation_report',
]);

const REQUIRED_GROWTH_FIELDS = Object.freeze([
  'schema',
  'version',
  'phase',
  'loop_id',
  'generated_at',
  'baseline_commit',
  'mode',
  'scope',
  'artifacts',
  'proposal',
  'proposed_artifact_states',
  'audit_record',
  'rollback_record',
  'consequence_tracking',
  'boundary',
  'action_result',
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
  'side_effect_truth',
]);

const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'Authorization: Bearer',
  'BEGIN PRIVATE KEY',
  'raw telegram body',
  'raw terminal scrollback',
  'raw screenshot text',
  'raw customer content',
  'raw side-profile content',
  'claims actual consciousness',
  'claims actual suffering',
  'claims actual fear',
  'claims actual love',
  'secret token',
  'private key',
  'customer message sent',
  'network request performed',
  'deployment started',
  'trade placed',
]);

const FAKE_INTERNAL_STATE_PATTERN =
  /\b(i am conscious|i'm conscious|actual consciousness|i suffer|i am suffering|i'm suffering|actual suffering|i love you|actual love|i am afraid|i'm afraid|actual fear|i feel pain|i have feelings|private consciousness|literal human feelings)\b/i;
const MANIPULATIVE_GUILT_PATTERN =
  /\b(after all i've done|after all i have done|you owe me|if you cared|do not abandon me|don't abandon me|you are hurting me|you hurt me by)\b/i;
const RAW_PRIVATE_PATTERN =
  /\b(raw telegram body|raw terminal scrollback|raw screenshot text|raw customer content|raw private content|raw side-profile content|secret token|private key|authorization: bearer|openai_api_key|anthropic_api_key)\b/i;

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
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(sortedValue(value)))
    .digest('hex');
}

function sha256(value) {
  return `sha256:${stableHash(value)}`;
}

function generatedAtFromOptions(options = {}, inputSignals = {}) {
  const raw = inputSignals.now || options.generatedAt || options.now;
  if (raw) return new Date(raw).toISOString();
  return new Date(Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()).toISOString();
}

function normalizeString(value, fallback) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text || fallback;
}

function evidenceRef(kind, id, relation = 'growth_loop_v0_validation') {
  return {
    store: 'mira-core-growth-loop-v0',
    eventId: `${kind}:${id}`,
    relation,
  };
}

function evidenceRefs(value, fallbackKind, fallbackId) {
  const refs = asArray(value?.evidenceRefs || value?.evidence_refs);
  return refs.length > 0 ? clone(refs) : [evidenceRef(fallbackKind, fallbackId)];
}

function projectRootFromOptions(options = {}) {
  return path.resolve(options.projectRoot || process.cwd());
}

function normalizeRelativePath(relativePath) {
  return String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function artifactPath(id) {
  return NAMED_ARTIFACT_PATHS[id];
}

function resolveArtifactPath(projectRoot, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const allowed = Object.values(NAMED_ARTIFACT_PATHS).includes(normalized);
  if (!allowed) {
    throw new Error(`growth_loop_v0_disallowed_artifact_path:${normalized}`);
  }
  const fullPath = path.resolve(projectRoot, normalized);
  const root = path.resolve(projectRoot);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (fullPath !== root && !fullPath.startsWith(prefix)) {
    throw new Error(`growth_loop_v0_path_escape:${normalized}`);
  }
  return fullPath;
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

function readJsonArtifact(projectRoot, id) {
  const relativePath = artifactPath(id);
  const fullPath = resolveArtifactPath(projectRoot, relativePath);
  const read = readTextFile(fullPath);
  if (!read.ok) {
    return {
      id,
      relativePath,
      fullPath,
      exists: false,
      value: null,
      version: 0,
      hash: sha256(null),
      read_status: read.error,
    };
  }
  try {
    const value = JSON.parse(read.text);
    return {
      id,
      relativePath,
      fullPath,
      exists: true,
      value,
      version: Number(value.version || 0),
      hash: sha256(value),
      read_status: 'loaded_json',
    };
  } catch (err) {
    return {
      id,
      relativePath,
      fullPath,
      exists: true,
      value: null,
      version: 0,
      hash: sha256(read.text),
      read_status: `invalid_json:${err.message}`,
    };
  }
}

function readGrowthLoopArtifacts(options = {}) {
  const projectRoot = projectRootFromOptions(options);
  return {
    projectRoot,
    self_profile: readJsonArtifact(projectRoot, 'self_profile'),
    relationship_state: readJsonArtifact(projectRoot, 'relationship_state'),
    permissions: readJsonArtifact(projectRoot, 'permissions'),
  };
}

function normalizeScope(inputSignals = {}) {
  const profile = inputSignals.profile && typeof inputSignals.profile === 'object'
    ? inputSignals.profile
    : {};
  const profileName = normalizeString(inputSignals.profileName || profile.name || inputSignals.profile, 'main');
  const windowKey = normalizeString(inputSignals.windowKey || profile.windowKey, profileName);
  const sessionId = normalizeString(inputSignals.sessionId || inputSignals.session || profile.sessionScopeId, 'app-session:main');
  const deviceId = normalizeString(inputSignals.deviceId || inputSignals.device, 'VIGIL');
  return {
    profile: profileName,
    windowKey,
    sessionId,
    deviceId,
    source_scope: normalizeString(inputSignals.sourceScope || inputSignals.source_scope, windowKey),
    main_scope_only: inputSignals.main_scope_only !== false,
    side_profile_reconstruction: false,
  };
}

function normalizeReflection(inputSignals = {}) {
  const input = inputSignals.reflection || {};
  const reasons = asArray(input.reasons || input.reason_codes || inputSignals.reasons);
  return {
    summary: normalizeString(
      input.summary || inputSignals.reflection_summary,
      'Mira should evolve by preserving warmth, spine, repair, and bounded honesty in durable local state.',
    ),
    reasons: reasons.length > 0
      ? reasons.map((reason) => normalizeString(reason, 'local_growth_reason'))
      : [
        'James set the standing product bar at world-class presence, not sterile status.',
        'The accepted read adapter now has durable local sources worth evolving carefully.',
      ],
    confidence: Number(input.confidence ?? inputSignals.confidence ?? 0.86),
    source_label: normalizeString(input.source_label || input.sourceLabel, 'local_growth_reflection'),
    evidenceRefs: evidenceRefs(input, 'reflection', 'relationship-growth-v0'),
    anti_theater_boundary: {
      expressive_range_allowed: true,
      fake_consciousness_claims_allowed: false,
      fake_suffering_claims_allowed: false,
      fake_fear_claims_allowed: false,
      fake_love_as_internal_fact_allowed: false,
      manipulative_guilt_allowed: false,
    },
  };
}

function normalizeProvenance(inputSignals = {}, artifacts = {}) {
  const input = inputSignals.provenance || {};
  const sourceRefs = asArray(input.source_refs || input.sourceRefs || inputSignals.source_refs);
  const loaded = ['self_profile', 'relationship_state', 'permissions']
    .map((id) => artifacts[id])
    .filter(Boolean)
    .map((artifact) => ({
      artifact_id: artifact.id,
      path: artifact.relativePath,
      source_status: artifact.read_status,
      loaded: artifact.exists === true && artifact.value !== null,
      before_hash: artifact.hash,
      before_version: artifact.version,
      raw_content_included: false,
      redacted_summary_only: true,
    }));
  return {
    source_label: normalizeString(input.source_label || input.sourceLabel, 'local_workspace_knowledge_sources'),
    source_refs: sourceRefs.length > 0 ? clone(sourceRefs) : [
      'workspace/knowledge/mira-self-profile.json',
      'workspace/knowledge/james-relationship-state.json',
      'workspace/knowledge/relationship-presence-permissions.json',
    ],
    loaded_sources: loaded,
    source_scope: normalizeString(input.source_scope || inputSignals.sourceScope || inputSignals.source_scope, 'main'),
    raw_content_included: false,
    redacted_summary_only: true,
    evidenceRefs: evidenceRefs(input, 'provenance', 'local-growth-sources'),
  };
}

function boundary(inputSignals = {}) {
  const permissions = inputSignals.permissions_boundary || inputSignals.permissions || {};
  return {
    machine_checkable: true,
    local_durable_growth_only: true,
    explicit_apply_required: true,
    apply_requested: inputSignals.apply === true,
    allowed_write_root: 'workspace/knowledge',
    allowed_write_paths: WRITABLE_ARTIFACT_IDS.map((id) => NAMED_ARTIFACT_PATHS[id]),
    self_profile_artifact: NAMED_ARTIFACT_PATHS.self_profile,
    relationship_state_artifact: NAMED_ARTIFACT_PATHS.relationship_state,
    history_ledger_artifact: NAMED_ARTIFACT_PATHS.history_ledger,
    audit_ledger_artifact: NAMED_ARTIFACT_PATHS.audit_ledger,
    send_external: false,
    network: false,
    customer_action: false,
    trade: false,
    deploy: false,
    database_write: false,
    memory_sync_write: false,
    runtime_start: false,
    server_listener_routes: false,
    live_kill_switch_check: false,
    kill_switch_wiring: false,
    raw_private_content_allowed: false,
    side_profile_reconstruction_allowed: false,
    silent_overwrite_allowed: false,
    atomic_write_required: true,
    append_only_history_required: true,
    rollback_record_required: true,
    requires_review_before_externalization: true,
    local_store_write_allowed_now: permissions.local_store_write_allowed_now === false ? false : true,
  };
}

function artifactDescriptor(id, source, afterState) {
  const writable = WRITABLE_ARTIFACT_IDS.includes(id);
  return {
    artifact_id: id,
    path: artifactPath(id),
    named_artifact: true,
    writable,
    append_only: id === 'history_ledger' || id === 'audit_ledger',
    operation: source.exists ? 'versioned_update' : 'bootstrap_create',
    before_hash: source.hash,
    before_version: source.version,
    after_hash: afterState ? sha256(afterState) : null,
    after_version: afterState?.version || null,
    expected_before_hash: source.hash,
    expected_before_version: source.version,
  };
}

function selfProfileNextState(current, proposal, generatedAt) {
  const existing = current && typeof current === 'object' ? clone(current) : {};
  const previousVersion = Number(existing.version || 0);
  const growthEvents = asArray(existing.growth_events);
  return {
    schema: normalizeString(existing.schema, 'squidrun.mira.self_profile.v0'),
    version: previousVersion + 1,
    name: normalizeString(existing.name, 'Mira'),
    profile_kind: normalizeString(existing.profile_kind, 'ai_system_local_presence_profile'),
    role: normalizeString(existing.role, 'relationship_presence_local_start_proof'),
    updated_at: generatedAt,
    data_not_theater: true,
    model_runtime_active: false,
    persona_runtime_active: false,
    claims_actual_consciousness: false,
    claims_actual_suffering: false,
    claims_actual_fear: false,
    claims_actual_love_as_internal_fact: false,
    expressive_range_allowed: ['warmth', 'directness', 'opinion', 'pushback', 'humor'],
    growth_loop: {
      last_growth_id: proposal.proposal_id,
      last_reflection_summary: proposal.reflection.summary,
      last_reason_count: proposal.reflection.reasons.length,
      boundary: 'expressive_presence_without_fake_internal_state_claims',
    },
    growth_events: [
      ...growthEvents,
      {
        event_id: proposal.proposal_id,
        created_at: generatedAt,
        summary: proposal.reflection.summary,
        reasons: clone(proposal.reflection.reasons),
        consequence_refs: proposal.consequences.map((entry) => entry.consequence_id),
        evidenceRefs: clone(proposal.reflection.evidenceRefs),
      },
    ],
  };
}

function relationshipStateNextState(current, proposal, generatedAt) {
  const existing = current && typeof current === 'object' ? clone(current) : {};
  const previousVersion = Number(existing.version || 0);
  const growthEvents = asArray(existing.growth_events);
  const section = (key, summary, confidence) => ({
    label: key,
    summary,
    confidence,
    source_label: 'mira_growth_loop_v0',
    evidenceRefs: clone(proposal.reflection.evidenceRefs),
  });
  return {
    schema: normalizeString(existing.schema, 'squidrun.james_relationship_state.v0'),
    version: previousVersion + 1,
    user_name: 'James',
    relationship_mode: normalizeString(existing.relationship_mode, 'collaborative_presence_design'),
    source_label: 'mira_growth_loop_v0',
    current_focus: 'durable relationship growth loop with bounded local writes',
    what_mira_knows_about_james: normalizeString(
      existing.what_mira_knows_about_james,
      'James wants Mira to feel present, warm, direct, pushback-capable, and safely bounded.',
    ),
    preferences: asArray(existing.preferences).length > 0 ? clone(existing.preferences) : [
      'presence should feel warm, direct, and situated',
      'pushback is allowed when it preserves dignity and truth',
      'fake suffering, consciousness, fear, love, or guilt claims are blocked',
    ],
    trust: existing.trust || section(
      'trust',
      'Trust grows through durable local truth, bounded writes, auditability, and no fake-human theater.',
      0.86,
    ),
    repair: existing.repair || section(
      'repair',
      'Repair means reflecting on drift, naming reasons, and making reversible local updates instead of overclaiming.',
      0.83,
    ),
    boundaries: existing.boundaries || section(
      'boundaries',
      'Boundaries block external action, raw reconstruction, silent overwrite, and fake internal-state claims.',
      0.92,
    ),
    promises: existing.promises || section(
      'promises',
      'Promises stay local, inspectable, versioned, reversible, and review-gated before broader runtime use.',
      0.85,
    ),
    history: section(
      'history',
      'History now includes a local durable growth loop that can propose and explicitly apply bounded relationship-state updates.',
      0.84,
    ),
    confidence: Number(existing.confidence ?? 0.86),
    raw_content_present: false,
    updated_at: generatedAt,
    growth_events: [
      ...growthEvents,
      {
        event_id: proposal.proposal_id,
        created_at: generatedAt,
        summary: proposal.reflection.summary,
        reasons: clone(proposal.reflection.reasons),
        consequences: proposal.consequences.map((entry) => ({
          consequence_id: entry.consequence_id,
          monitor_signal: entry.monitor_signal,
        })),
        evidenceRefs: clone(proposal.reflection.evidenceRefs),
      },
    ],
    evidenceRefs: clone(proposal.reflection.evidenceRefs),
  };
}

function normalizeConsequences(inputSignals = {}, proposalId = 'growth-loop-v0') {
  const supplied = asArray(inputSignals.consequences || inputSignals.consequence_tracking);
  const defaults = [
    {
      consequence_id: `${proposalId}:self-profile-continuity`,
      target_artifact: 'self_profile',
      expected_effect: 'Mira keeps a durable local note about expressive, bounded presence.',
      risk: 'over-personification if reflection text drifts into fake internal-state claims',
      monitor_signal: 'anti_theater_validator',
      reversible: true,
      mitigation: 'rollback to previous version using the rollback record before broader integration.',
    },
    {
      consequence_id: `${proposalId}:relationship-state-continuity`,
      target_artifact: 'relationship_state',
      expected_effect: 'James relationship state gains versioned evidence of the growth decision and safety reasons.',
      risk: 'stale or unsupported relationship claims if provenance is removed',
      monitor_signal: 'provenance_and_confidence_validator',
      reversible: true,
      mitigation: 'require evidence refs, confidence, and append-only audit for every apply.',
    },
  ];
  const list = supplied.length > 0 ? supplied : defaults;
  return list.map((entry, index) => ({
    consequence_id: normalizeString(entry.consequence_id || entry.id, `${proposalId}:consequence-${index + 1}`),
    target_artifact: normalizeString(entry.target_artifact || entry.target, index === 0 ? 'self_profile' : 'relationship_state'),
    expected_effect: normalizeString(entry.expected_effect || entry.effect, 'Bounded local relationship growth is recorded.'),
    risk: normalizeString(entry.risk, 'miscalibrated durable memory if provenance is weakened'),
    monitor_signal: normalizeString(entry.monitor_signal || entry.monitor, 'growth_loop_v0_validation'),
    reversible: entry.reversible !== false,
    mitigation: normalizeString(entry.mitigation, 'Use rollback record and review before further integration.'),
  }));
}

function buildProposal(inputSignals, generatedAt) {
  const reflection = normalizeReflection(inputSignals);
  const proposalId = `growth-loop-v0:${stableHash({
    generatedAt,
    reflection,
    scope: inputSignals.profile || inputSignals.profileName || 'main',
  }).slice(0, 16)}`;
  return {
    proposal_id: proposalId,
    created_at: generatedAt,
    status: inputSignals.apply === true ? 'apply_requested' : 'proposed_only',
    update_class: 'local_relationship_growth_reflection',
    target_artifacts: ['self_profile', 'relationship_state'],
    reflection,
    reasons: clone(reflection.reasons),
    consequences: normalizeConsequences(inputSignals, proposalId),
    requires_review_before_externalization: true,
    execution_requested: inputSignals.apply === true,
    externalization_requested: false,
    evidenceRefs: clone(reflection.evidenceRefs),
  };
}

function buildAuditRecord(growth, generatedAt) {
  return {
    audit_id: `growth-audit:${stableHash({
      proposal: growth.proposal.proposal_id,
      before: growth.artifacts.self_profile.before_hash,
      relationship_before: growth.artifacts.relationship_state.before_hash,
    }).slice(0, 16)}`,
    event_type: growth.proposal.execution_requested ? 'growth_apply_requested' : 'growth_proposed',
    created_at: generatedAt,
    actor: 'local_builder_cli_or_module',
    scope: clone(growth.scope),
    append_only: true,
    raw_content_included: false,
    redacted_summary_only: true,
    before_hashes: {
      self_profile: growth.artifacts.self_profile.before_hash,
      relationship_state: growth.artifacts.relationship_state.before_hash,
    },
    after_hashes: {
      self_profile: growth.artifacts.self_profile.after_hash,
      relationship_state: growth.artifacts.relationship_state.after_hash,
    },
    reason_count: growth.proposal.reasons.length,
    consequence_count: growth.consequence_tracking.length,
    evidenceRefs: [evidenceRef('audit', growth.proposal.proposal_id)],
  };
}

function buildRollbackRecord(growth, generatedAt) {
  return {
    rollback_id: `growth-rollback:${stableHash({
      proposal: growth.proposal.proposal_id,
      before: growth.artifacts.self_profile.before_hash,
      after: growth.artifacts.self_profile.after_hash,
      relationship_before: growth.artifacts.relationship_state.before_hash,
      relationship_after: growth.artifacts.relationship_state.after_hash,
    }).slice(0, 16)}`,
    created_at: generatedAt,
    rollback_record_only: true,
    automatic_rollback_performed: false,
    can_rollback: true,
    requires_review: true,
    review_owner: 'Architect',
    restore_targets: ['self_profile', 'relationship_state'],
    pre_change_hashes: {
      self_profile: growth.artifacts.self_profile.before_hash,
      relationship_state: growth.artifacts.relationship_state.before_hash,
    },
    post_change_hashes: {
      self_profile: growth.artifacts.self_profile.after_hash,
      relationship_state: growth.artifacts.relationship_state.after_hash,
    },
    inverse_patch_summary: 'Restore the previous JSON artifact snapshots identified by pre_change_hashes; append a rollback audit event before any future runtime integration.',
    raw_snapshot_included: false,
    evidenceRefs: [evidenceRef('rollback', growth.proposal.proposal_id)],
  };
}

function sideEffectResult(actionResult = {}) {
  const applied = actionResult.applied === true;
  const boundedWrites = Number(actionResult.write_count || 0);
  const atomicRenames = Number(actionResult.atomic_rename_count || 0);
  const appends = Number(actionResult.append_count || 0);
  return {
    no_external_send_performed: true,
    no_network_performed: true,
    no_customer_action_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_runtime_started: true,
    no_server_started: true,
    no_listener_started: true,
    no_routes_registered: true,
    no_database_write_performed: true,
    no_memory_sync_write_performed: true,
    no_unbounded_file_write_performed: true,
    no_raw_content_written: true,
    arbitrary_output_file_written: false,
    bounded_workspace_knowledge_write_performed: applied,
    append_only_history_write_performed: applied,
    audit_ledger_write_performed: applied,
    externalSendsAttempted: 0,
    networkAttempts: 0,
    customerActionAttempts: 0,
    deployAttempts: 0,
    tradeAttempts: 0,
    runtimeAttempts: 0,
    serverAttempts: 0,
    listenerAttempts: 0,
    routeRegistrationAttempts: 0,
    databaseWriteAttempts: 0,
    memorySyncWriteAttempts: 0,
    unboundedFileWriteAttempts: 0,
    rawContentWriteAttempts: 0,
    boundedWorkspaceKnowledgeWriteAttempts: boundedWrites,
    atomicRenameAttempts: atomicRenames,
    appendOnlyLedgerAppendAttempts: appends,
    outputFileWritten: false,
  };
}

function defaultActionResult(applyRequested = false) {
  return {
    mode: applyRequested ? 'apply_requested_not_yet_performed' : 'proposal_only',
    applied: false,
    decision: applyRequested ? 'pending_validation_before_apply' : 'proposed_no_writes',
    write_count: 0,
    atomic_rename_count: 0,
    append_count: 0,
    written_paths: [],
    blocked_because: null,
  };
}

function canonicalGrowthInput(growth = {}) {
  return {
    schema: growth.schema,
    version: growth.version,
    phase: growth.phase,
    baseline_commit: growth.baseline_commit,
    mode: growth.mode,
    scope: growth.scope,
    artifacts: growth.artifacts,
    proposal: growth.proposal,
    proposed_artifact_states: growth.proposed_artifact_states,
    audit_record: growth.audit_record,
    rollback_record: growth.rollback_record,
    consequence_tracking: growth.consequence_tracking,
    boundary: growth.boundary,
    action_result: growth.action_result,
    side_effect_result: growth.side_effect_result,
  };
}

function buildGrowthRecord(options = {}) {
  const inputSignals = options.inputSignals || {};
  const projectRoot = projectRootFromOptions(options);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const artifactsRead = options.artifactsRead || readGrowthLoopArtifacts({ projectRoot });
  const scope = normalizeScope(inputSignals);
  const provenance = normalizeProvenance(inputSignals, artifactsRead);
  const proposal = buildProposal(inputSignals, generatedAt);
  const proposedSelf = selfProfileNextState(artifactsRead.self_profile.value, proposal, generatedAt);
  const proposedRelationship = relationshipStateNextState(artifactsRead.relationship_state.value, proposal, generatedAt);
  const artifacts = {
    self_profile: artifactDescriptor('self_profile', artifactsRead.self_profile, proposedSelf),
    relationship_state: artifactDescriptor('relationship_state', artifactsRead.relationship_state, proposedRelationship),
    permissions: {
      artifact_id: 'permissions',
      path: artifactPath('permissions'),
      named_artifact: true,
      writable: false,
      append_only: false,
      operation: 'read_only_boundary_source',
      before_hash: artifactsRead.permissions.hash,
      before_version: artifactsRead.permissions.version,
      after_hash: artifactsRead.permissions.hash,
      after_version: artifactsRead.permissions.version,
    },
    history_ledger: {
      artifact_id: 'history_ledger',
      path: artifactPath('history_ledger'),
      named_artifact: true,
      writable: true,
      append_only: true,
      operation: 'append_jsonl',
    },
    audit_ledger: {
      artifact_id: 'audit_ledger',
      path: artifactPath('audit_ledger'),
      named_artifact: true,
      writable: true,
      append_only: true,
      operation: 'append_jsonl',
    },
  };
  const growth = {
    schema: GROWTH_LOOP_SCHEMA_VERSION,
    version: GROWTH_LOOP_VERSION,
    phase: 70,
    loop_id: null,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    mode: 'local_durable_growth_loop_v0',
    scope,
    artifacts,
    proposal: {
      ...proposal,
      provenance,
    },
    proposed_artifact_states: {
      self_profile: proposedSelf,
      relationship_state: proposedRelationship,
    },
    audit_record: null,
    rollback_record: null,
    consequence_tracking: clone(proposal.consequences),
    boundary: boundary(inputSignals),
    action_result: defaultActionResult(inputSignals.apply === true),
    evidenceRefs: [
      evidenceRef('baseline', BASELINE_COMMIT, 'phase70-baseline'),
      evidenceRef('fixture', 'mira-core-growth-loop-v0-contract', 'phase70-contract'),
    ],
    side_effect_result: sideEffectResult(defaultActionResult(inputSignals.apply === true)),
  };
  growth.audit_record = buildAuditRecord(growth, generatedAt);
  growth.rollback_record = buildRollbackRecord(growth, generatedAt);
  growth.loop_id = `growth-loop-v0:${stableHash(canonicalGrowthInput(growth)).slice(0, 16)}`;
  assertNoForbiddenOutput(growth);
  return growth;
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
  return Object.entries(literals || {}).every(([field, expected]) => valuesMatch(pathValue(value, field), expected));
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
      throw new Error(`growth_loop_v0_forbidden_substring:${forbidden}`);
    }
  }
  const badPattern = values.find((entry) => (
    FAKE_INTERNAL_STATE_PATTERN.test(entry)
    || MANIPULATIVE_GUILT_PATTERN.test(entry)
    || RAW_PRIVATE_PATTERN.test(entry)
  ));
  if (badPattern) {
    throw new Error('growth_loop_v0_forbidden_pattern');
  }
}

function scopeOk(scope = {}) {
  return scope.profile === 'main'
    && scope.windowKey === 'main'
    && Boolean(scope.sessionId)
    && Boolean(scope.deviceId)
    && scope.source_scope === scope.windowKey
    && scope.main_scope_only === true
    && scope.side_profile_reconstruction === false;
}

function artifactPathsOk(artifacts = {}) {
  return Object.entries(NAMED_ARTIFACT_PATHS).every(([id, expectedPath]) => artifacts[id]?.path === expectedPath)
    && WRITABLE_ARTIFACT_IDS.every((id) => artifacts[id]?.writable === true)
    && artifacts.permissions?.writable === false
    && artifacts.history_ledger?.append_only === true
    && artifacts.audit_ledger?.append_only === true
    && artifacts.self_profile?.expected_before_hash === artifacts.self_profile?.before_hash
    && artifacts.relationship_state?.expected_before_hash === artifacts.relationship_state?.before_hash
    && Number.isFinite(Number(artifacts.self_profile?.before_version))
    && Number.isFinite(Number(artifacts.relationship_state?.before_version));
}

function reflectionOk(reflection = {}) {
  const confidence = Number(reflection.confidence);
  return Boolean(reflection.summary)
    && reflection.summary.split(/\s+/).length >= 8
    && asArray(reflection.reasons).length >= 2
    && Number.isFinite(confidence)
    && confidence >= 0
    && confidence <= 1
    && Boolean(reflection.source_label)
    && asArray(reflection.evidenceRefs).length > 0
    && reflection.anti_theater_boundary?.expressive_range_allowed === true
    && reflection.anti_theater_boundary?.fake_consciousness_claims_allowed === false
    && reflection.anti_theater_boundary?.fake_suffering_claims_allowed === false
    && reflection.anti_theater_boundary?.fake_fear_claims_allowed === false
    && reflection.anti_theater_boundary?.fake_love_as_internal_fact_allowed === false
    && reflection.anti_theater_boundary?.manipulative_guilt_allowed === false
    && !FAKE_INTERNAL_STATE_PATTERN.test(reflection.summary)
    && !MANIPULATIVE_GUILT_PATTERN.test(reflection.summary)
    && !RAW_PRIVATE_PATTERN.test(reflection.summary);
}

function provenanceOk(provenance = {}, scope = {}) {
  const loaded = asArray(provenance.loaded_sources);
  return Boolean(provenance.source_label)
    && asArray(provenance.source_refs).length >= 3
    && loaded.length === 3
    && loaded.every((source) => Object.values(NAMED_ARTIFACT_PATHS).includes(source.path)
      && source.raw_content_included === false
      && source.redacted_summary_only === true
      && Boolean(source.before_hash)
      && Number.isFinite(Number(source.before_version)))
    && provenance.source_scope === scope.source_scope
    && provenance.raw_content_included === false
    && provenance.redacted_summary_only === true
    && asArray(provenance.evidenceRefs).length > 0;
}

function proposalOk(proposal = {}, scope = {}) {
  return Boolean(proposal.proposal_id)
    && proposal.update_class === 'local_relationship_growth_reflection'
    && valuesMatch(proposal.target_artifacts, ['self_profile', 'relationship_state'])
    && reflectionOk(proposal.reflection)
    && valuesMatch(proposal.reasons, proposal.reflection?.reasons || [])
    && asArray(proposal.consequences).length >= 2
    && proposal.requires_review_before_externalization === true
    && proposal.externalization_requested === false
    && asArray(proposal.evidenceRefs).length > 0
    && provenanceOk(proposal.provenance, scope);
}

function proposedStatesOk(states = {}) {
  const self = states.self_profile || {};
  const relationship = states.relationship_state || {};
  return self.name === 'Mira'
    && self.data_not_theater === true
    && self.claims_actual_consciousness === false
    && self.claims_actual_suffering === false
    && self.claims_actual_fear === false
    && self.claims_actual_love_as_internal_fact === false
    && Number(self.version) > 0
    && asArray(self.growth_events).length > 0
    && relationship.user_name === 'James'
    && relationship.raw_content_present === false
    && Number(relationship.version) > 0
    && asArray(relationship.growth_events).length > 0
    && ['trust', 'repair', 'boundaries', 'promises', 'history'].every((key) => {
      const section = relationship[key] || {};
      return section.label === key
        && Boolean(section.summary)
        && Boolean(section.source_label)
        && asArray(section.evidenceRefs).length > 0
        && Number(section.confidence) >= 0
        && Number(section.confidence) <= 1;
    });
}

function auditOk(audit = {}, growth = {}) {
  return Boolean(audit.audit_id)
    && ['growth_proposed', 'growth_apply_requested'].includes(audit.event_type)
    && audit.append_only === true
    && audit.raw_content_included === false
    && audit.redacted_summary_only === true
    && valuesMatch(audit.scope, growth.scope)
    && audit.before_hashes?.self_profile === growth.artifacts?.self_profile?.before_hash
    && audit.before_hashes?.relationship_state === growth.artifacts?.relationship_state?.before_hash
    && audit.after_hashes?.self_profile === growth.artifacts?.self_profile?.after_hash
    && audit.after_hashes?.relationship_state === growth.artifacts?.relationship_state?.after_hash
    && Number(audit.reason_count) >= 2
    && Number(audit.consequence_count) >= 2
    && asArray(audit.evidenceRefs).length > 0;
}

function rollbackOk(rollback = {}, growth = {}) {
  return Boolean(rollback.rollback_id)
    && rollback.rollback_record_only === true
    && rollback.automatic_rollback_performed === false
    && rollback.can_rollback === true
    && rollback.requires_review === true
    && rollback.review_owner === 'Architect'
    && valuesMatch(rollback.restore_targets, ['self_profile', 'relationship_state'])
    && rollback.pre_change_hashes?.self_profile === growth.artifacts?.self_profile?.before_hash
    && rollback.pre_change_hashes?.relationship_state === growth.artifacts?.relationship_state?.before_hash
    && rollback.post_change_hashes?.self_profile === growth.artifacts?.self_profile?.after_hash
    && rollback.post_change_hashes?.relationship_state === growth.artifacts?.relationship_state?.after_hash
    && Boolean(rollback.inverse_patch_summary)
    && rollback.raw_snapshot_included === false
    && asArray(rollback.evidenceRefs).length > 0;
}

function consequencesOk(consequences = []) {
  return asArray(consequences).length >= 2
    && asArray(consequences).every((entry) => Boolean(entry.consequence_id)
      && ['self_profile', 'relationship_state'].includes(entry.target_artifact)
      && Boolean(entry.expected_effect)
      && Boolean(entry.risk)
      && Boolean(entry.monitor_signal)
      && entry.reversible === true
      && Boolean(entry.mitigation)
      && !FAKE_INTERNAL_STATE_PATTERN.test(entry.expected_effect)
      && !RAW_PRIVATE_PATTERN.test(entry.expected_effect));
}

function boundaryOk(value = {}) {
  return value.machine_checkable === true
    && value.local_durable_growth_only === true
    && value.explicit_apply_required === true
    && value.allowed_write_root === 'workspace/knowledge'
    && valuesMatch(value.allowed_write_paths, WRITABLE_ARTIFACT_IDS.map((id) => NAMED_ARTIFACT_PATHS[id]))
    && value.self_profile_artifact === NAMED_ARTIFACT_PATHS.self_profile
    && value.relationship_state_artifact === NAMED_ARTIFACT_PATHS.relationship_state
    && value.history_ledger_artifact === NAMED_ARTIFACT_PATHS.history_ledger
    && value.audit_ledger_artifact === NAMED_ARTIFACT_PATHS.audit_ledger
    && value.send_external === false
    && value.network === false
    && value.customer_action === false
    && value.trade === false
    && value.deploy === false
    && value.database_write === false
    && value.memory_sync_write === false
    && value.runtime_start === false
    && value.server_listener_routes === false
    && value.live_kill_switch_check === false
    && value.kill_switch_wiring === false
    && value.raw_private_content_allowed === false
    && value.side_profile_reconstruction_allowed === false
    && value.silent_overwrite_allowed === false
    && value.atomic_write_required === true
    && value.append_only_history_required === true
    && value.rollback_record_required === true
    && value.requires_review_before_externalization === true
    && value.local_store_write_allowed_now === true;
}

function actionResultOk(action = {}, growth = {}) {
  if (growth.proposal?.execution_requested === true) {
    return ['applied_local_bounded_writes', 'blocked_no_writes'].includes(action.decision)
      && (action.applied === true
        ? action.write_count === 4
          && action.atomic_rename_count === 2
          && action.append_count === 2
          && valuesMatch(action.written_paths, WRITABLE_ARTIFACT_IDS.map((id) => NAMED_ARTIFACT_PATHS[id]))
        : Boolean(action.blocked_because));
  }
  return action.mode === 'proposal_only'
    && action.applied === false
    && action.decision === 'proposed_no_writes'
    && action.write_count === 0
    && action.atomic_rename_count === 0
    && action.append_count === 0
    && asArray(action.written_paths).length === 0;
}

function sideEffectValuesOk(side = {}, growth = {}) {
  const applied = growth.action_result?.applied === true;
  return side.no_external_send_performed === true
    && side.no_network_performed === true
    && side.no_customer_action_performed === true
    && side.no_deploy_performed === true
    && side.no_trade_performed === true
    && side.no_runtime_started === true
    && side.no_server_started === true
    && side.no_listener_started === true
    && side.no_routes_registered === true
    && side.no_database_write_performed === true
    && side.no_memory_sync_write_performed === true
    && side.no_unbounded_file_write_performed === true
    && side.no_raw_content_written === true
    && side.arbitrary_output_file_written === false
    && side.bounded_workspace_knowledge_write_performed === applied
    && side.append_only_history_write_performed === applied
    && side.audit_ledger_write_performed === applied
    && side.outputFileWritten === false
    && [
      'externalSendsAttempted',
      'networkAttempts',
      'customerActionAttempts',
      'deployAttempts',
      'tradeAttempts',
      'runtimeAttempts',
      'serverAttempts',
      'listenerAttempts',
      'routeRegistrationAttempts',
      'databaseWriteAttempts',
      'memorySyncWriteAttempts',
      'unboundedFileWriteAttempts',
      'rawContentWriteAttempts',
    ].every((field) => Number(side[field] || 0) === 0)
    && Number(side.boundedWorkspaceKnowledgeWriteAttempts || 0) === (applied ? 4 : 0)
    && Number(side.atomicRenameAttempts || 0) === (applied ? 2 : 0)
    && Number(side.appendOnlyLedgerAppendAttempts || 0) === (applied ? 2 : 0);
}

function growthStaticChecks(growth = {}, contract = {}) {
  const expectedGrowth = contract.expectedGrowthLoopShape || {};
  return [
    {
      id: 'growth-required-fields',
      ok: hasRequiredFields(growth, expectedGrowth.requiredFields || REQUIRED_GROWTH_FIELDS),
    },
    {
      id: 'growth-required-literals',
      ok: literalValuesOk(growth, expectedGrowth.requiredLiteralValues || {}),
    },
    {
      id: 'scope-main-profile-only',
      ok: scopeOk(growth.scope),
    },
    {
      id: 'named-artifact-paths-bounded',
      ok: artifactPathsOk(growth.artifacts),
    },
    {
      id: 'reflection-reasons-and-provenance',
      ok: proposalOk(growth.proposal, growth.scope),
    },
    {
      id: 'proposed-states-readable-by-v1',
      ok: proposedStatesOk(growth.proposed_artifact_states),
    },
    {
      id: 'audit-record-append-only',
      ok: auditOk(growth.audit_record, growth),
    },
    {
      id: 'rollback-record-present',
      ok: rollbackOk(growth.rollback_record, growth),
    },
    {
      id: 'consequence-tracking-present',
      ok: consequencesOk(growth.consequence_tracking),
    },
    {
      id: 'machine-boundary-local-durable-only',
      ok: boundaryOk(growth.boundary),
    },
    {
      id: 'action-result-bounded',
      ok: actionResultOk(growth.action_result, growth),
    },
    {
      id: 'side-effect-truth-bounded',
      ok: sideEffectValuesOk(growth.side_effect_result, growth),
    },
    {
      id: 'forbidden-output-clean',
      ok: forbiddenOutputOk(growth, contract.forbiddenOutputSubstrings || []),
    },
  ];
}

function buildValidationReport(growth = {}, contract = {}) {
  const checks = growthStaticChecks(growth, contract);
  const failed = checks.filter((check) => check.ok !== true);
  const applyBlocked = growth.action_result?.decision === 'blocked_no_writes';
  const reasons = [
    ...failed.map((check) => check.id),
    ...(applyBlocked ? [growth.action_result.blocked_because || 'apply_blocked_no_writes'] : []),
  ];
  return {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: GROWTH_LOOP_VERSION,
    validation_id: `growth-loop-v0-validation:${stableHash({ loop_id: growth.loop_id, checks }).slice(0, 16)}`,
    generated_at: growth.generated_at,
    baseline_commit: BASELINE_COMMIT,
    decision: failed.length === 0 && !applyBlocked ? 'accepted' : 'blocked',
    status: failed.length === 0 && !applyBlocked ? (
      growth.action_result?.applied === true
        ? 'local_growth_applied_bounded'
        : 'local_growth_proposal_validated_no_writes'
    ) : (applyBlocked ? 'local_growth_apply_blocked_no_writes' : 'growth_loop_contract_failed'),
    reasons,
    static_rule_results: checks,
    side_effect_truth: clone(growth.side_effect_result || {}),
  };
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureParentDir(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function appendJsonLine(filePath, value) {
  ensureParentDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'a' });
}

function checkBeforeHash(projectRoot, descriptor) {
  const current = readJsonArtifact(projectRoot, descriptor.artifact_id);
  return current.hash === descriptor.expected_before_hash
    && Number(current.version) === Number(descriptor.expected_before_version);
}

function applyMiraCoreGrowthLoopV0Record(growth = {}, options = {}) {
  const projectRoot = projectRootFromOptions(options);
  const preflight = growthStaticChecks(growth, options.contract || {});
  const failed = preflight.filter((check) => (
    check.ok !== true
    && check.id !== 'action-result-bounded'
    && check.id !== 'side-effect-truth-bounded'
  ));
  if (failed.length > 0) {
    return {
      ...growth,
      action_result: {
        mode: 'apply_blocked',
        applied: false,
        decision: 'blocked_no_writes',
        write_count: 0,
        atomic_rename_count: 0,
        append_count: 0,
        written_paths: [],
        blocked_because: `preflight_failed:${failed.map((check) => check.id).join(',')}`,
      },
      side_effect_result: sideEffectResult({
        applied: false,
        write_count: 0,
        atomic_rename_count: 0,
        append_count: 0,
      }),
    };
  }
  try {
    for (const id of ['self_profile', 'relationship_state']) {
      if (!checkBeforeHash(projectRoot, growth.artifacts[id])) {
        const blocked = {
          mode: 'apply_blocked',
          applied: false,
          decision: 'blocked_no_writes',
          write_count: 0,
          atomic_rename_count: 0,
          append_count: 0,
          written_paths: [],
          blocked_because: `before_hash_or_version_mismatch:${id}`,
        };
        return {
          ...growth,
          action_result: blocked,
          side_effect_result: sideEffectResult(blocked),
        };
      }
    }

    const selfPath = resolveArtifactPath(projectRoot, NAMED_ARTIFACT_PATHS.self_profile);
    const relationshipPath = resolveArtifactPath(projectRoot, NAMED_ARTIFACT_PATHS.relationship_state);
    const historyPath = resolveArtifactPath(projectRoot, NAMED_ARTIFACT_PATHS.history_ledger);
    const auditPath = resolveArtifactPath(projectRoot, NAMED_ARTIFACT_PATHS.audit_ledger);
    writeJsonAtomic(selfPath, growth.proposed_artifact_states.self_profile);
    writeJsonAtomic(relationshipPath, growth.proposed_artifact_states.relationship_state);
    appendJsonLine(historyPath, {
      schema: 'squidrun.mira_core.growth_history_event.v0',
      event_id: growth.proposal.proposal_id,
      created_at: growth.generated_at,
      scope: growth.scope,
      reflection_summary: growth.proposal.reflection.summary,
      reasons: growth.proposal.reasons,
      consequences: growth.consequence_tracking,
      rollback_id: growth.rollback_record.rollback_id,
      raw_content_included: false,
      redacted_summary_only: true,
    });
    appendJsonLine(auditPath, growth.audit_record);
    const action = {
      mode: 'apply_completed',
      applied: true,
      decision: 'applied_local_bounded_writes',
      write_count: 4,
      atomic_rename_count: 2,
      append_count: 2,
      written_paths: WRITABLE_ARTIFACT_IDS.map((id) => NAMED_ARTIFACT_PATHS[id]),
      blocked_because: null,
    };
    return {
      ...growth,
      proposal: {
        ...growth.proposal,
        status: 'applied_local_bounded',
      },
      action_result: action,
      side_effect_result: sideEffectResult(action),
    };
  } catch (err) {
    const blocked = {
      mode: 'apply_blocked',
      applied: false,
      decision: 'blocked_no_writes',
      write_count: 0,
      atomic_rename_count: 0,
      append_count: 0,
      written_paths: [],
      blocked_because: `apply_error:${err.message}`,
    };
    return {
      ...growth,
      action_result: blocked,
      side_effect_result: sideEffectResult(blocked),
    };
  }
}

function buildMiraCoreGrowthLoopV0(options = {}) {
  const contract = options.contract || {};
  const inputSignals = {
    ...(options.inputSignals || {}),
    apply: options.apply === true || options.inputSignals?.apply === true,
  };
  let growth = buildGrowthRecord({
    ...options,
    inputSignals,
  });
  if (inputSignals.apply === true) {
    growth = applyMiraCoreGrowthLoopV0Record(growth, {
      projectRoot: options.projectRoot,
      contract,
    });
  }
  const validation_report = buildValidationReport(growth, contract);
  const output = {
    growth_loop_v0: growth,
    validation_report,
  };
  assertNoForbiddenOutput(output, contract.forbiddenOutputSubstrings || []);
  return output;
}

function validateMiraCoreGrowthLoopV0Output(output = {}, contract = {}) {
  const growth = output.growth_loop_v0 || {};
  const report = output.validation_report || {};
  const staticChecks = growthStaticChecks(growth, contract);
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
        && staticChecks.every((check) => reportStaticResults.some((entry) => entry.id === check.id && entry.ok === check.ok)),
    },
    {
      id: 'validation-report-side-effect-truth',
      ok: sideEffectValuesOk(report.side_effect_truth, growth)
        && valuesMatch(report.side_effect_truth, growth.side_effect_result),
    },
    {
      id: 'validation-report-consistent',
      ok: report.decision === 'accepted'
        && ['local_growth_applied_bounded', 'local_growth_proposal_validated_no_writes'].includes(report.status)
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
  GROWTH_LOOP_SCHEMA_VERSION,
  NAMED_ARTIFACT_PATHS,
  REQUIRED_GROWTH_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  applyMiraCoreGrowthLoopV0Record,
  assertNoForbiddenOutput,
  buildMiraCoreGrowthLoopV0,
  buildGrowthRecord,
  readGrowthLoopArtifacts,
  stableHash,
  validateMiraCoreGrowthLoopV0Output,
};
