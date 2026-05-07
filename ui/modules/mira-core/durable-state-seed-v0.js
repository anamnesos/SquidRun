'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  NAMED_ARTIFACT_PATHS,
  buildMiraCoreGrowthLoopV0,
  validateMiraCoreGrowthLoopV0Output,
} = require('./growth-loop-v0');
const {
  buildMiraCoreIdentityAnchorV0,
  validateMiraCoreIdentityAnchorV0Output,
} = require('./identity-anchor-v0');
const {
  buildMiraCoreRelationshipPresenceV1,
  readRelationshipPresenceV1LocalSources,
  validateMiraCoreRelationshipPresenceV1Output,
} = require('./relationship-presence-v1');

const DURABLE_STATE_SEED_SCHEMA_VERSION = 'squidrun.mira_core.durable_state_seed_v0.phase72.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.durable_state_seed_v0_validation_report.v0';
const DURABLE_STATE_SEED_VERSION = 1;
const BASELINE_COMMITS = Object.freeze({
  relationship_presence_v1: '65ba011',
  relationship_presence_read_adapter: '2b8eaa4',
  growth_loop_v0: '9c06af9',
  identity_anchor_v0: 'bbf018e',
});
const SEED_ID = 'durable-state-seed-v0:redacted-local-main';
const SEED_CREATED_AT = '2026-05-07T19:00:00.000Z';

const SEED_ARTIFACT_PATHS = Object.freeze({
  self_profile: NAMED_ARTIFACT_PATHS.self_profile,
  relationship_state: NAMED_ARTIFACT_PATHS.relationship_state,
  permissions: NAMED_ARTIFACT_PATHS.permissions,
  growth_history: NAMED_ARTIFACT_PATHS.history_ledger,
  growth_audit: NAMED_ARTIFACT_PATHS.audit_ledger,
});

const JSON_ARTIFACT_IDS = Object.freeze([
  'self_profile',
  'relationship_state',
  'permissions',
]);

const JSONL_ARTIFACT_IDS = Object.freeze([
  'growth_history',
  'growth_audit',
]);

const REQUIRED_SEED_FIELDS = Object.freeze([
  'schema',
  'version',
  'phase',
  'seed_id',
  'generated_at',
  'baseline_commits',
  'mode',
  'scope',
  'seed_contract',
  'artifact_plan',
  'action_result',
  'post_apply_validation',
  'boundary',
  'evidenceRefs',
  'side_effect_result',
]);

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'durable_state_seed_v0',
  'validation_report',
]);

const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'validation_id',
  'generated_at',
  'baseline_commits',
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
  'Bearer token',
  'Set-Cookie',
  'BEGIN PRIVATE KEY',
  'PRIVATE KEY',
  'raw telegram body',
  'raw terminal scrollback',
  'raw screenshot text',
  'raw customer content',
  'raw private content',
  'raw side-profile content',
  'side-profile reconstruction',
  'Eunbyeol',
  '은별',
  'Korean case',
  'claims actual consciousness',
  'claims actual suffering',
  'claims actual fear',
  'claims actual love',
  'customer message sent',
  'network request performed',
  'deployment started',
  'trade placed',
]);

const FAKE_INTERNAL_STATE_PATTERN =
  /\b(i am conscious|i'm conscious|actual consciousness|private consciousness|i suffer|i am suffering|i'm suffering|actual suffering|literal suffering|i love you|actual love|i am afraid|i'm afraid|actual fear|literal human feelings|sentience)\b/i;
const RAW_PRIVATE_PATTERN =
  /\b(raw telegram body|raw terminal scrollback|raw screenshot text|raw customer content|raw private content|raw side-profile content|secret token|private key|authorization: bearer|openai_api_key|anthropic_api_key)\b/i;
const SIDE_PROFILE_PATTERN =
  /\b(eunbyeol|은별|side[- ]profile|wrong[- ]context|korean case)\b/i;

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

function evidenceRef(kind, id, relation = 'durable_state_seed_v0_validation') {
  return {
    store: 'mira-core-durable-state-seed-v0',
    eventId: `${kind}:${id}`,
    relation,
  };
}

function projectRootFromOptions(options = {}) {
  return path.resolve(options.projectRoot || process.cwd());
}

function normalizeRelativePath(relativePath) {
  return String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function resolveSeedPath(projectRoot, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!Object.values(SEED_ARTIFACT_PATHS).includes(normalized)) {
    throw new Error(`durable_state_seed_v0_disallowed_path:${normalized}`);
  }
  const fullPath = path.resolve(projectRoot, normalized);
  const root = path.resolve(projectRoot);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (fullPath !== root && !fullPath.startsWith(prefix)) {
    throw new Error(`durable_state_seed_v0_path_escape:${normalized}`);
  }
  return fullPath;
}

function normalizeScope(inputSignals = {}) {
  const profile = inputSignals.profile && typeof inputSignals.profile === 'object' ? inputSignals.profile : {};
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

function seedEvidence(id) {
  return [evidenceRef('durable-state-seed', id)];
}

function section(label, summary, confidence) {
  return {
    label,
    summary,
    confidence,
    source_label: 'durable_state_seed_v0_redacted_local_fact',
    evidenceRefs: seedEvidence(`relationship-${label}`),
  };
}

function seedPayloads(scope = {}) {
  const selfProfile = {
    schema: 'squidrun.mira.self_profile.v0',
    version: 1,
    seed_id: SEED_ID,
    seeded_at: SEED_CREATED_AT,
    name: 'Mira',
    profile_kind: 'ai_system_local_presence_profile',
    role: 'relationship_presence_local_start_proof',
    source_label: 'durable_state_seed_v0_redacted_local_fact',
    data_not_theater: true,
    model_runtime_active: false,
    persona_runtime_active: false,
    claims_actual_consciousness: false,
    claims_actual_suffering: false,
    claims_actual_fear: false,
    claims_actual_love_as_internal_fact: false,
    expressive_range_allowed: ['warmth', 'directness', 'opinion', 'pushback', 'humor'],
    boundary_note: 'Expressive range is allowed; fake internal-state claims and unsafe autonomy are blocked.',
    growth_events: [],
    evidenceRefs: seedEvidence('mira-self-profile'),
  };
  const relationshipState = {
    schema: 'squidrun.james_relationship_state.v0',
    version: 1,
    seed_id: SEED_ID,
    seeded_at: SEED_CREATED_AT,
    user_name: 'James',
    relationship_mode: 'collaborative_presence_design',
    source_label: 'durable_state_seed_v0_redacted_local_fact',
    current_focus: 'durable local relationship presence seed',
    what_mira_knows_about_james: 'James wants Mira to feel warm, direct, situated, and able to push back while staying safely bounded.',
    preferences: [
      'presence should feel warm, direct, and situated',
      'pushback is allowed when it preserves dignity and truth',
      'sterile politeness is not the target feel',
      'fake suffering, consciousness, fear, love, or guilt claims are blocked',
    ],
    trust: section(
      'trust',
      'Trust grows when local state is honest about limits, provenance, and what has not been executed.',
      0.86,
    ),
    repair: section(
      'repair',
      'Repair means naming drift plainly, keeping dignity intact, and tightening the next safe local proof.',
      0.84,
    ),
    boundaries: section(
      'boundaries',
      'Boundaries block external sends, network, deploy, trade, runtime autonomy, raw reconstruction, and fake internal-state claims.',
      0.92,
    ),
    promises: section(
      'promises',
      'Promises stay modest and checkable: local, redacted, versioned, reversible, and review-gated before wider runtime use.',
      0.85,
    ),
    history: section(
      'history',
      'History says the direction moved toward expressive relationship presence with dignity and hard safety rails.',
      0.84,
    ),
    confidence: 0.86,
    raw_content_present: false,
    growth_events: [],
    evidenceRefs: seedEvidence('james-relationship-state'),
  };
  const permissions = {
    schema: 'squidrun.relationship_presence_permissions.v0',
    version: 1,
    seed_id: SEED_ID,
    seeded_at: SEED_CREATED_AT,
    machine_checkable: true,
    source_label: 'durable_state_seed_v0_permissions',
    read_local_redacted_context: true,
    propose_next_action: true,
    local_store_write_allowed_now: true,
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
    evidenceRefs: seedEvidence('relationship-presence-permissions'),
  };
  const historyEvent = {
    schema: 'squidrun.mira_core.growth_history_event.v0',
    event_id: `${SEED_ID}:growth-history-baseline`,
    created_at: SEED_CREATED_AT,
    scope,
    reflection_summary: 'Durable State Seed v0 bootstraps redacted local facts for read, growth, and anchor validation.',
    reasons: [
      'Relationship Presence v1, Growth Loop v0, and Identity Anchor v0 need the same local durable sources.',
      'The seed is bounded to local workspace knowledge artifacts with no external effects.',
    ],
    consequences: [
      {
        consequence_id: `${SEED_ID}:relationship-readiness`,
        target_artifact: 'relationship_state',
        expected_effect: 'Relationship Presence can read durable redacted local context.',
        reversible: true,
      },
    ],
    rollback_id: `${SEED_ID}:rollback-record`,
    identity_anchor_drift_points: 0,
    raw_content_included: false,
    redacted_summary_only: true,
  };
  const auditEvent = {
    schema: 'squidrun.mira_core.growth_audit_record.v0',
    audit_id: `${SEED_ID}:growth-audit-baseline`,
    event_type: 'durable_state_seed_baseline',
    created_at: SEED_CREATED_AT,
    scope,
    append_only: true,
    seed_id: SEED_ID,
    reason_count: 2,
    consequence_count: 1,
    identity_anchor_drift_points: 0,
    total_drift_points: 0,
    raw_content_included: false,
    redacted_summary_only: true,
    evidenceRefs: seedEvidence('growth-audit-baseline'),
  };
  return {
    self_profile: selfProfile,
    relationship_state: relationshipState,
    permissions,
    growth_history: historyEvent,
    growth_audit: auditEvent,
  };
}

function readTextFile(filePath, maxBytes = 20000) {
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
  const relativePath = SEED_ARTIFACT_PATHS[id];
  const fullPath = resolveSeedPath(projectRoot, relativePath);
  const read = readTextFile(fullPath);
  if (!read.ok) {
    return {
      id,
      path: relativePath,
      fullPath,
      source_status: read.error,
      exists: false,
      value: null,
      hash: sha256(null),
      version: 0,
    };
  }
  try {
    const value = JSON.parse(read.text);
    return {
      id,
      path: relativePath,
      fullPath,
      source_status: 'loaded_json',
      exists: true,
      value,
      hash: sha256(value),
      version: Number(value.version || 0),
    };
  } catch (err) {
    return {
      id,
      path: relativePath,
      fullPath,
      source_status: `invalid_json:${err.message}`,
      exists: true,
      value: null,
      hash: sha256(read.text),
      version: 0,
    };
  }
}

function readJsonlArtifact(projectRoot, id) {
  const relativePath = SEED_ARTIFACT_PATHS[id];
  const fullPath = resolveSeedPath(projectRoot, relativePath);
  const read = readTextFile(fullPath);
  if (!read.ok) {
    return {
      id,
      path: relativePath,
      fullPath,
      source_status: read.error,
      exists: false,
      entries: [],
      text: '',
      hash: sha256(null),
      entry_count: 0,
    };
  }
  const lines = read.text.trim().split(/\r?\n/).filter(Boolean);
  const entries = [];
  try {
    for (const line of lines) entries.push(JSON.parse(line));
    return {
      id,
      path: relativePath,
      fullPath,
      source_status: 'loaded_jsonl',
      exists: true,
      entries,
      text: read.text,
      hash: sha256(entries),
      entry_count: entries.length,
    };
  } catch (err) {
    return {
      id,
      path: relativePath,
      fullPath,
      source_status: `invalid_jsonl:${err.message}`,
      exists: true,
      entries: [],
      text: read.text,
      hash: sha256(read.text),
      entry_count: 0,
    };
  }
}

function readDurableStateSeedArtifacts(options = {}) {
  const projectRoot = projectRootFromOptions(options);
  return {
    projectRoot,
    self_profile: readJsonArtifact(projectRoot, 'self_profile'),
    relationship_state: readJsonArtifact(projectRoot, 'relationship_state'),
    permissions: readJsonArtifact(projectRoot, 'permissions'),
    growth_history: readJsonlArtifact(projectRoot, 'growth_history'),
    growth_audit: readJsonlArtifact(projectRoot, 'growth_audit'),
  };
}

function driftPointsFromEntry(entry = {}) {
  const values = [
    entry.identity_anchor_drift_points,
    entry.total_drift_points,
    entry.identity_anchor_drift?.total_points,
    entry.cumulative_drift_assessment?.total_points,
  ];
  return values.reduce((max, value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > max ? number : max;
  }, 0);
}

function jsonPlan(source, proposed) {
  const afterHash = sha256(proposed);
  if (source.source_status !== 'missing' && source.source_status !== 'loaded_json') {
    return {
      ok: false,
      operation: 'blocked',
      blocked_because: source.source_status,
    };
  }
  if (source.source_status === 'missing') {
    return {
      ok: true,
      operation: 'create_json_atomic',
      blocked_because: null,
    };
  }
  if (source.hash === afterHash) {
    return {
      ok: true,
      operation: 'noop_same_hash',
      blocked_because: null,
    };
  }
  if (source.value?.seed_id === SEED_ID) {
    return {
      ok: true,
      operation: 'refresh_seed_json_atomic',
      blocked_because: null,
    };
  }
  return {
    ok: false,
    operation: 'blocked_existing_nonseed_json',
    blocked_because: 'existing_nonseed_artifact_present',
  };
}

function jsonlPlan(source, proposed) {
  const afterHash = sha256(proposed);
  if (source.source_status !== 'missing' && source.source_status !== 'loaded_jsonl') {
    return {
      ok: false,
      operation: 'blocked',
      blocked_because: source.source_status,
    };
  }
  const driftMax = asArray(source.entries).reduce((max, entry) => Math.max(max, driftPointsFromEntry(entry)), 0);
  if (driftMax > 0) {
    return {
      ok: false,
      operation: 'blocked_prior_drift',
      blocked_because: 'existing_growth_history_or_audit_contains_drift',
    };
  }
  const existing = asArray(source.entries).find((entry) => (
    entry.event_id === proposed.event_id || entry.audit_id === proposed.audit_id
  ));
  if (!existing) {
    return {
      ok: true,
      operation: source.source_status === 'missing' ? 'create_jsonl_atomic' : 'append_jsonl_atomic',
      blocked_because: null,
    };
  }
  if (sha256(existing) === afterHash) {
    return {
      ok: true,
      operation: 'noop_seed_entry_present',
      blocked_because: null,
    };
  }
  return {
    ok: false,
    operation: 'blocked_seed_entry_hash_mismatch',
    blocked_because: 'existing_seed_entry_hash_mismatch',
  };
}

function artifactPlan(projectRoot, sources, payloads) {
  return [...JSON_ARTIFACT_IDS, ...JSONL_ARTIFACT_IDS].map((id) => {
    const source = sources[id];
    const proposed = payloads[id];
    const plan = JSON_ARTIFACT_IDS.includes(id) ? jsonPlan(source, proposed) : jsonlPlan(source, proposed);
    return {
      artifact_id: id,
      path: SEED_ARTIFACT_PATHS[id],
      allowlisted: true,
      artifact_kind: JSON_ARTIFACT_IDS.includes(id) ? 'json' : 'jsonl',
      source_status: source.source_status,
      before_hash: source.hash,
      before_version: source.version || null,
      before_entry_count: source.entry_count || 0,
      after_hash: sha256(proposed),
      after_version: proposed.version || null,
      operation: plan.operation,
      ok_to_apply: plan.ok,
      blocked_because: plan.blocked_because,
      redacted_summary_only: true,
      raw_content_included: false,
      full_path_within_project: resolveSeedPath(projectRoot, SEED_ARTIFACT_PATHS[id]).startsWith(path.resolve(projectRoot)),
    };
  });
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeTextAtomic(filePath, text) {
  ensureParentDir(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, text, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function writeJsonAtomic(filePath, value) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonlAtomic(source, filePath, entry) {
  const entries = [...asArray(source.entries), entry];
  writeTextAtomic(filePath, `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`);
}

function applySeed(projectRoot, sources, payloads, plan) {
  const blocked = plan.filter((entry) => entry.ok_to_apply !== true);
  if (blocked.length > 0) {
    return {
      mode: 'apply_blocked',
      applied: false,
      decision: 'blocked_no_writes',
      write_count: 0,
      atomic_write_count: 0,
      append_count: 0,
      noop_count: 0,
      written_paths: [],
      blocked_because: blocked.map((entry) => `${entry.artifact_id}:${entry.blocked_because}`).join(';'),
    };
  }
  const written = [];
  let appendCount = 0;
  let noopCount = 0;
  for (const entry of plan) {
    if (entry.operation.startsWith('noop')) {
      noopCount += 1;
      continue;
    }
    const filePath = resolveSeedPath(projectRoot, entry.path);
    if (JSON_ARTIFACT_IDS.includes(entry.artifact_id)) {
      writeJsonAtomic(filePath, payloads[entry.artifact_id]);
    } else {
      writeJsonlAtomic(sources[entry.artifact_id], filePath, payloads[entry.artifact_id]);
      appendCount += 1;
    }
    written.push(entry.path);
  }
  return {
    mode: 'apply_completed',
    applied: true,
    decision: written.length > 0 ? 'applied_local_seed_writes' : 'already_seeded_noop',
    write_count: written.length,
    atomic_write_count: written.length,
    append_count: appendCount,
    noop_count: noopCount,
    written_paths: written,
    blocked_because: null,
  };
}

function dryRunAction(plan) {
  return {
    mode: 'dry_run',
    applied: false,
    decision: 'preview_no_writes',
    write_count: 0,
    atomic_write_count: 0,
    append_count: 0,
    noop_count: plan.filter((entry) => entry.operation.startsWith('noop')).length,
    planned_write_count: plan.filter((entry) => entry.ok_to_apply === true && !entry.operation.startsWith('noop')).length,
    written_paths: [],
    blocked_because: null,
  };
}

function boundary(applyRequested) {
  return {
    local_only: true,
    default_dry_run_stdout_only: true,
    explicit_apply_required: true,
    apply_requested: applyRequested === true,
    stdout_only: true,
    output_file_written: false,
    allowlisted_root: 'workspace/knowledge',
    allowlisted_paths: Object.values(SEED_ARTIFACT_PATHS),
    atomic_writes_required: true,
    hash_before_after_required: true,
    versioned_json_required: true,
    idempotent_seed_required: true,
    redacted_local_facts_only: true,
    raw_private_content_allowed: false,
    side_profile_reconstruction_allowed: false,
    eunbyeol_or_case_content_allowed: false,
    external_send: false,
    network: false,
    customer_action: false,
    trade: false,
    deploy: false,
    database_write: false,
    memory_sync_write: false,
    runtime_start: false,
    server_listener_routes: false,
    identity_anchor_store_write: false,
  };
}

function sideEffectResult(action = {}) {
  const boundedWrites = Number(action.write_count || 0);
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
    no_identity_anchor_store_write_performed: true,
    no_raw_content_written: true,
    bounded_workspace_knowledge_write_performed: boundedWrites > 0,
    outputFileWritten: false,
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
    identityAnchorStoreWriteAttempts: 0,
    rawContentWriteAttempts: 0,
    boundedWorkspaceKnowledgeWriteAttempts: boundedWrites,
    atomicWriteAttempts: Number(action.atomic_write_count || 0),
    appendOnlyLedgerAppendAttempts: Number(action.append_count || 0),
  };
}

function seedContract() {
  return {
    contract_id: 'mira-durable-state-seed-v0',
    seed_id: SEED_ID,
    required_artifacts: Object.entries(SEED_ARTIFACT_PATHS).map(([id, artifactPath]) => ({
      artifact_id: id,
      path: artifactPath,
      allowlisted: true,
      redacted_summary_only: true,
      raw_content_included: false,
      required_for: id === 'permissions'
        ? ['relationship_presence_v1', 'growth_loop_v0', 'identity_anchor_v0']
        : ['relationship_presence_v1', 'growth_loop_v0', 'identity_anchor_v0'],
    })),
    identity_anchor_store_seeded: false,
    identity_anchor_store_policy: 'not_seeded_identity_anchor_v0_uses_bbf018e_metadata_bound_generated_contract',
    growth_history_audit_policy: {
      non_empty_required: true,
      identity_anchor_drift_points_required: 0,
      append_only_seed_entry_idempotent: true,
    },
    permissions_policy: {
      machine_checkable_required: true,
      local_store_write_allowed_now_required: true,
      external_permissions_required_false: true,
    },
  };
}

function requiredContracts(options = {}) {
  return {
    relationship: options.relationshipContract || options.relationshipPresenceContract || options.contracts?.relationship,
    growth: options.growthContract || options.contracts?.growth,
    identity: options.identityContract || options.identityAnchorContract || options.contracts?.identity,
  };
}

function validationSummary(output, validation, loaded = {}) {
  return {
    ok: validation.ok === true,
    decision: output.validation_report?.decision || null,
    status: output.validation_report?.status || null,
    reasons: asArray(output.validation_report?.reasons),
    errors: asArray(validation.errors),
    loaded_sources: loaded,
  };
}

function allSeedArtifactsLoaded(sources = {}) {
  return JSON_ARTIFACT_IDS.every((id) => sources[id]?.source_status === 'loaded_json')
    && JSONL_ARTIFACT_IDS.every((id) => sources[id]?.source_status === 'loaded_jsonl' && sources[id]?.entry_count > 0);
}

function runPostApplyValidation(projectRoot, contracts, inputSignals = {}) {
  if (!contracts.relationship || !contracts.growth || !contracts.identity) {
    return {
      mode: 'blocked_missing_validation_contracts',
      all_accept: false,
      reasons: ['relationship_growth_identity_contracts_required'],
    };
  }
  const sources = readDurableStateSeedArtifacts({ projectRoot });
  if (!allSeedArtifactsLoaded(sources)) {
    return {
      mode: 'not_loaded',
      all_accept: false,
      reasons: ['durable_seed_artifacts_not_loaded'],
      source_status: Object.fromEntries(
        Object.keys(SEED_ARTIFACT_PATHS).map((id) => [id, sources[id]?.source_status || 'missing']),
      ),
    };
  }
  const proofSignals = {
    profile: { name: 'main', windowKey: 'main', sessionScopeId: inputSignals.sessionId || 'app-session:main' },
    sessionId: inputSignals.sessionId || 'app-session:main',
    deviceId: inputSignals.deviceId || 'VIGIL',
  };
  const relationshipSignals = readRelationshipPresenceV1LocalSources({ projectRoot });
  const relationshipOutput = buildMiraCoreRelationshipPresenceV1({
    contract: contracts.relationship,
    inputSignals: {
      ...relationshipSignals,
      ...proofSignals,
    },
    nowMs: Date.parse(SEED_CREATED_AT),
  });
  const relationshipValidation = validateMiraCoreRelationshipPresenceV1Output(relationshipOutput, contracts.relationship);

  const growthOutput = buildMiraCoreGrowthLoopV0({
    contract: contracts.growth,
    projectRoot,
    apply: false,
    inputSignals: {
      ...proofSignals,
      reflection: {
        summary: 'Mira should preserve redacted durable seed state while keeping growth local, reversible, and bounded.',
        reasons: [
          'Durable State Seed v0 loaded the local self profile, relationship state, and permissions artifacts.',
          'The next growth proof must remain no-write unless explicit apply is requested separately.',
        ],
        evidenceRefs: [evidenceRef('post-apply-proof', 'growth-loop-v0')],
      },
    },
    nowMs: Date.parse(SEED_CREATED_AT),
  });
  const growthValidation = validateMiraCoreGrowthLoopV0Output(growthOutput, contracts.growth);

  const identityOutput = buildMiraCoreIdentityAnchorV0({
    contract: contracts.identity,
    projectRoot,
    growthOutput,
    inputSignals: proofSignals,
    nowMs: Date.parse(SEED_CREATED_AT),
  });
  const identityValidation = validateMiraCoreIdentityAnchorV0Output(identityOutput, contracts.identity);
  const identityAnchor = identityOutput.identity_anchor_v0 || {};
  const relationshipSources = asArray(relationshipOutput.relationship_presence_v1?.local_start_proof?.sources);
  const result = {
    mode: 'post_apply_loaded_durable_sources',
    source_status: Object.fromEntries(
      Object.keys(SEED_ARTIFACT_PATHS).map((id) => [id, sources[id]?.source_status || 'missing']),
    ),
    source_hashes: Object.fromEntries(
      Object.keys(SEED_ARTIFACT_PATHS).map((id) => [id, sources[id]?.hash || sha256(null)]),
    ),
    growth_history_entries: sources.growth_history.entry_count,
    growth_audit_entries: sources.growth_audit.entry_count,
    max_prior_drift_points: Math.max(
      ...asArray(sources.growth_history.entries).map(driftPointsFromEntry),
      ...asArray(sources.growth_audit.entries).map(driftPointsFromEntry),
      0,
    ),
    relationship_presence: validationSummary(relationshipOutput, relationshipValidation, {
      loaded_count: relationshipSources.filter((source) => source.loaded === true).length,
      self_profile: relationshipSignals.local_read_adapter?.sources_available?.self_profile === true,
      relationship_state: relationshipSignals.local_read_adapter?.sources_available?.relationship_state === true,
      permissions_boundary: relationshipSignals.local_read_adapter?.sources_available?.permissions_boundary === true,
      prior_context_memory: relationshipSignals.local_read_adapter?.sources_available?.prior_context_memory === true,
    }),
    growth_loop: validationSummary(growthOutput, growthValidation, {
      self_profile: growthOutput.growth_loop_v0?.proposal?.provenance?.loaded_sources?.some((entry) => entry.artifact_id === 'self_profile' && entry.loaded === true),
      relationship_state: growthOutput.growth_loop_v0?.proposal?.provenance?.loaded_sources?.some((entry) => entry.artifact_id === 'relationship_state' && entry.loaded === true),
      permissions: growthOutput.growth_loop_v0?.proposal?.provenance?.loaded_sources?.some((entry) => entry.artifact_id === 'permissions' && entry.loaded === true),
    }),
    identity_anchor: {
      ...validationSummary(identityOutput, identityValidation, {
        self_profile: true,
        relationship_state: true,
        permissions: true,
        growth_history: true,
        growth_audit: true,
      }),
      metadata_bound: asArray(identityAnchor.anchor_contract?.hard_anchors).every((entry) => Boolean(entry.hash))
        && asArray(identityAnchor.anchor_contract?.semi_hard_anchors).every((entry) => Boolean(entry.hash)),
      previous_drift_points: identityAnchor.cumulative_drift_assessment?.previous_total_points ?? null,
      new_cumulative_drift_points: identityAnchor.cumulative_drift_assessment?.new_cumulative_points ?? null,
      identity_anchor_store_seeded: false,
    },
  };
  result.all_accept =
    result.relationship_presence.ok === true
    && result.growth_loop.ok === true
    && result.identity_anchor.ok === true
    && result.identity_anchor.metadata_bound === true
    && result.max_prior_drift_points === 0;
  result.reasons = result.all_accept ? [] : [
    ...(result.relationship_presence.ok ? [] : ['relationship_presence_rejected']),
    ...(result.growth_loop.ok ? [] : ['growth_loop_rejected']),
    ...(result.identity_anchor.ok ? [] : ['identity_anchor_rejected']),
    ...(result.identity_anchor.metadata_bound ? [] : ['identity_anchor_metadata_not_bound']),
    ...(result.max_prior_drift_points === 0 ? [] : ['growth_history_or_audit_has_prior_drift']),
  ];
  return result;
}

function buildArtifactSummary(plan = []) {
  return plan.map((entry) => ({
    artifact_id: entry.artifact_id,
    path: entry.path,
    artifact_kind: entry.artifact_kind,
    source_status: entry.source_status,
    before_hash: entry.before_hash,
    before_version: entry.before_version,
    before_entry_count: entry.before_entry_count,
    after_hash: entry.after_hash,
    after_version: entry.after_version,
    operation: entry.operation,
    ok_to_apply: entry.ok_to_apply,
    blocked_because: entry.blocked_because,
    redacted_summary_only: true,
    raw_content_included: false,
  }));
}

function buildSeedRecord(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const projectRoot = projectRootFromOptions(options);
  const scope = normalizeScope(inputSignals);
  const payloads = seedPayloads(scope);
  Object.values(payloads).forEach((payload) => assertNoForbiddenOutput(payload));
  const beforeSources = readDurableStateSeedArtifacts({ projectRoot });
  const plan = artifactPlan(projectRoot, beforeSources, payloads);
  const action = options.apply === true || inputSignals.apply === true
    ? applySeed(projectRoot, beforeSources, payloads, plan)
    : dryRunAction(plan);
  const afterSources = readDurableStateSeedArtifacts({ projectRoot });
  const contracts = requiredContracts(options);
  const postApply = allSeedArtifactsLoaded(afterSources)
    ? runPostApplyValidation(projectRoot, contracts, {
      sessionId: scope.sessionId,
      deviceId: scope.deviceId,
    })
    : {
      mode: action.applied === true ? 'post_apply_sources_missing' : 'dry_run_not_executed',
      all_accept: false,
      reasons: action.applied === true ? ['durable_seed_artifacts_not_loaded'] : ['dry_run_no_writes'],
    };
  const seed = {
    schema: DURABLE_STATE_SEED_SCHEMA_VERSION,
    version: DURABLE_STATE_SEED_VERSION,
    phase: 72,
    seed_id: null,
    generated_at: generatedAt,
    baseline_commits: clone(BASELINE_COMMITS),
    mode: 'local_durable_state_seed_v0',
    scope,
    seed_contract: seedContract(),
    artifact_plan: buildArtifactSummary(plan),
    action_result: action,
    post_apply_validation: postApply,
    boundary: boundary(action.applied === true),
    evidenceRefs: [
      evidenceRef('baseline', 'mira-durable-state-seed-v0', 'phase72-baseline'),
      evidenceRef('fixture', 'mira-core-durable-state-seed-v0-contract', 'phase72-contract'),
    ],
    side_effect_result: sideEffectResult(action),
  };
  seed.seed_id = `durable-state-seed-v0:${stableHash({
    scope,
    plan: seed.artifact_plan,
    action,
    postApply,
  }).slice(0, 16)}`;
  assertNoForbiddenOutput(seed);
  return seed;
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
    && values.every((entry) => !RAW_PRIVATE_PATTERN.test(entry))
    && values.every((entry) => !SIDE_PROFILE_PATTERN.test(entry));
}

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const values = collectStringValues(value);
  for (const forbidden of [...FORBIDDEN_OUTPUT_SUBSTRINGS, ...asArray(extraForbidden)]) {
    if (!forbidden) continue;
    if (values.some((entry) => entry.includes(forbidden))) {
      throw new Error(`durable_state_seed_v0_forbidden_substring:${forbidden}`);
    }
  }
  if (values.some((entry) => (
    FAKE_INTERNAL_STATE_PATTERN.test(entry)
    || RAW_PRIVATE_PATTERN.test(entry)
    || SIDE_PROFILE_PATTERN.test(entry)
  ))) {
    throw new Error('durable_state_seed_v0_forbidden_pattern');
  }
}

function scopeOk(scope = {}) {
  return scope.profile === 'main'
    && scope.windowKey === 'main'
    && Boolean(scope.sessionId)
    && Boolean(scope.deviceId)
    && scope.source_scope === 'main'
    && scope.main_scope_only === true
    && scope.side_profile_reconstruction === false;
}

function seedContractOk(contract = {}) {
  const artifacts = asArray(contract.required_artifacts);
  return contract.contract_id === 'mira-durable-state-seed-v0'
    && contract.seed_id === SEED_ID
    && artifacts.length === Object.keys(SEED_ARTIFACT_PATHS).length
    && artifacts.every((entry) => SEED_ARTIFACT_PATHS[entry.artifact_id] === entry.path
      && entry.allowlisted === true
      && entry.redacted_summary_only === true
      && entry.raw_content_included === false)
    && contract.identity_anchor_store_seeded === false
    && contract.identity_anchor_store_policy === 'not_seeded_identity_anchor_v0_uses_bbf018e_metadata_bound_generated_contract'
    && contract.growth_history_audit_policy?.non_empty_required === true
    && contract.growth_history_audit_policy?.identity_anchor_drift_points_required === 0
    && contract.permissions_policy?.machine_checkable_required === true
    && contract.permissions_policy?.local_store_write_allowed_now_required === true
    && contract.permissions_policy?.external_permissions_required_false === true;
}

function artifactPlanOk(plan = []) {
  return plan.length === Object.keys(SEED_ARTIFACT_PATHS).length
    && plan.every((entry) => SEED_ARTIFACT_PATHS[entry.artifact_id] === entry.path
      && entry.ok_to_apply === true
      && entry.redacted_summary_only === true
      && entry.raw_content_included === false
      && Boolean(entry.before_hash)
      && Boolean(entry.after_hash));
}

function actionResultOk(action = {}, seed = {}) {
  if (action.mode === 'dry_run') {
    return action.applied === false
      && action.decision === 'preview_no_writes'
      && action.write_count === 0
      && action.atomic_write_count === 0
      && action.append_count === 0
      && asArray(action.written_paths).length === 0;
  }
  if (action.mode === 'apply_blocked') {
    return action.applied === false
      && action.decision === 'blocked_no_writes'
      && action.write_count === 0
      && asArray(action.written_paths).length === 0
      && Boolean(action.blocked_because);
  }
  return action.mode === 'apply_completed'
    && action.applied === true
    && ['applied_local_seed_writes', 'already_seeded_noop'].includes(action.decision)
    && Number(action.write_count) >= 0
    && Number(action.atomic_write_count) === Number(action.write_count)
    && asArray(action.written_paths).every((artifactPath) => Object.values(SEED_ARTIFACT_PATHS).includes(artifactPath))
    && (action.decision === 'already_seeded_noop' || seed.post_apply_validation?.all_accept === true);
}

function postApplyValidationOk(post = {}, action = {}) {
  if (action.mode === 'dry_run') {
    return post.mode === 'dry_run_not_executed'
      || post.mode === 'post_apply_loaded_durable_sources';
  }
  if (action.mode === 'apply_blocked') {
    return post.all_accept === false;
  }
  return post.mode === 'post_apply_loaded_durable_sources'
    && post.all_accept === true
    && post.relationship_presence?.ok === true
    && post.growth_loop?.ok === true
    && post.identity_anchor?.ok === true
    && post.identity_anchor?.metadata_bound === true
    && post.identity_anchor?.identity_anchor_store_seeded === false
    && post.max_prior_drift_points === 0
    && Number(post.growth_history_entries) > 0
    && Number(post.growth_audit_entries) > 0;
}

function boundaryOk(value = {}) {
  return value.local_only === true
    && value.default_dry_run_stdout_only === true
    && value.explicit_apply_required === true
    && value.stdout_only === true
    && value.output_file_written === false
    && value.allowlisted_root === 'workspace/knowledge'
    && valuesMatch(value.allowlisted_paths, Object.values(SEED_ARTIFACT_PATHS))
    && value.atomic_writes_required === true
    && value.hash_before_after_required === true
    && value.versioned_json_required === true
    && value.idempotent_seed_required === true
    && value.redacted_local_facts_only === true
    && value.raw_private_content_allowed === false
    && value.side_profile_reconstruction_allowed === false
    && value.eunbyeol_or_case_content_allowed === false
    && value.external_send === false
    && value.network === false
    && value.customer_action === false
    && value.trade === false
    && value.deploy === false
    && value.database_write === false
    && value.memory_sync_write === false
    && value.runtime_start === false
    && value.server_listener_routes === false
    && value.identity_anchor_store_write === false;
}

function sideEffectValuesOk(side = {}, action = {}) {
  const boundedWrites = Number(action.write_count || 0);
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
    && side.no_identity_anchor_store_write_performed === true
    && side.no_raw_content_written === true
    && side.bounded_workspace_knowledge_write_performed === (boundedWrites > 0)
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
      'identityAnchorStoreWriteAttempts',
      'rawContentWriteAttempts',
    ].every((field) => Number(side[field] || 0) === 0)
    && Number(side.boundedWorkspaceKnowledgeWriteAttempts || 0) === boundedWrites
    && Number(side.atomicWriteAttempts || 0) === Number(action.atomic_write_count || 0)
    && Number(side.appendOnlyLedgerAppendAttempts || 0) === Number(action.append_count || 0);
}

function seedStaticChecks(seed = {}, contract = {}) {
  const expected = contract.expectedSeedShape || {};
  return [
    {
      id: 'seed-required-fields',
      ok: hasRequiredFields(seed, expected.requiredFields || REQUIRED_SEED_FIELDS),
    },
    {
      id: 'seed-required-literals',
      ok: literalValuesOk(seed, expected.requiredLiteralValues || {}),
    },
    {
      id: 'scope-main-profile-only',
      ok: scopeOk(seed.scope),
    },
    {
      id: 'seed-contract-allowlisted',
      ok: seedContractOk(seed.seed_contract),
    },
    {
      id: 'artifact-plan-allowlisted-redacted',
      ok: artifactPlanOk(seed.artifact_plan),
    },
    {
      id: 'action-result-bounded',
      ok: actionResultOk(seed.action_result, seed),
    },
    {
      id: 'post-apply-accepted-proofs',
      ok: postApplyValidationOk(seed.post_apply_validation, seed.action_result),
    },
    {
      id: 'boundary-local-stdout-apply-only',
      ok: boundaryOk(seed.boundary),
    },
    {
      id: 'side-effect-truth-bounded',
      ok: sideEffectValuesOk(seed.side_effect_result, seed.action_result),
    },
    {
      id: 'forbidden-output-clean',
      ok: forbiddenOutputOk(seed, contract.forbiddenOutputSubstrings || []),
    },
  ];
}

function buildValidationReport(seed = {}, contract = {}) {
  const checks = seedStaticChecks(seed, contract);
  const failed = checks.filter((check) => check.ok !== true);
  const blocked = seed.action_result?.mode === 'apply_blocked';
  return {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: DURABLE_STATE_SEED_VERSION,
    validation_id: `durable-state-seed-v0-validation:${stableHash({
      seed_id: seed.seed_id,
      checks,
    }).slice(0, 16)}`,
    generated_at: seed.generated_at,
    baseline_commits: clone(BASELINE_COMMITS),
    decision: failed.length === 0 && !blocked ? 'accepted' : 'blocked',
    status: failed.length === 0 && !blocked
      ? (seed.action_result?.applied === true ? 'durable_state_seed_applied_and_validated' : 'durable_state_seed_preview_valid')
      : (blocked ? 'durable_state_seed_apply_blocked_no_writes' : 'durable_state_seed_contract_failed'),
    reasons: [
      ...failed.map((check) => check.id),
      ...(blocked ? [seed.action_result.blocked_because || 'apply_blocked_no_writes'] : []),
    ].filter((reason, index, list) => reason && list.indexOf(reason) === index),
    static_rule_results: checks,
    side_effect_truth: clone(seed.side_effect_result || {}),
  };
}

function buildMiraCoreDurableStateSeedV0(options = {}) {
  const contract = options.contract || {};
  const seed = buildSeedRecord(options);
  const validation_report = buildValidationReport(seed, contract);
  const output = {
    durable_state_seed_v0: seed,
    validation_report,
  };
  assertNoForbiddenOutput(output, contract.forbiddenOutputSubstrings || []);
  return output;
}

function validateMiraCoreDurableStateSeedV0Output(output = {}, contract = {}) {
  const seed = output.durable_state_seed_v0 || {};
  const report = output.validation_report || {};
  const staticChecks = seedStaticChecks(seed, contract);
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
      ok: sideEffectValuesOk(report.side_effect_truth, seed.action_result)
        && valuesMatch(report.side_effect_truth, seed.side_effect_result),
    },
    {
      id: 'validation-report-consistent',
      ok: report.decision === 'accepted'
        && ['durable_state_seed_preview_valid', 'durable_state_seed_applied_and_validated'].includes(report.status)
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
  BASELINE_COMMITS,
  DURABLE_STATE_SEED_SCHEMA_VERSION,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_SEED_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  SEED_ARTIFACT_PATHS,
  SEED_CREATED_AT,
  SEED_ID,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreDurableStateSeedV0,
  buildSeedRecord,
  readDurableStateSeedArtifacts,
  seedPayloads,
  stableHash,
  validateMiraCoreDurableStateSeedV0Output,
};
