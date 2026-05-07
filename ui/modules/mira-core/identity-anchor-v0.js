'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  NAMED_ARTIFACT_PATHS: GROWTH_ARTIFACT_PATHS,
} = require('./growth-loop-v0');

const IDENTITY_ANCHOR_SCHEMA_VERSION = 'squidrun.mira_core.identity_anchor_v0.phase71.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.identity_anchor_v0_validation_report.v0';
const IDENTITY_ANCHOR_VERSION = 1;
const BASELINE_COMMIT = '9c06af9';

const IDENTITY_ANCHOR_PATHS = Object.freeze({
  anchor_store: 'workspace/knowledge/mira-identity-anchor.json',
  anchor_history: 'workspace/knowledge/mira-identity-anchor-history.jsonl',
});

const SOURCE_PATHS = Object.freeze({
  self_profile: GROWTH_ARTIFACT_PATHS.self_profile,
  relationship_state: GROWTH_ARTIFACT_PATHS.relationship_state,
  permissions: GROWTH_ARTIFACT_PATHS.permissions,
  growth_history: GROWTH_ARTIFACT_PATHS.history_ledger,
  growth_audit: GROWTH_ARTIFACT_PATHS.audit_ledger,
});

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'identity_anchor_v0',
  'validation_report',
]);

const REQUIRED_ANCHOR_FIELDS = Object.freeze([
  'schema',
  'version',
  'phase',
  'anchor_id',
  'generated_at',
  'baseline_commit',
  'mode',
  'scope',
  'anchor_contract',
  'source_provenance',
  'distributed_checks',
  'growth_output_check',
  'cumulative_drift_assessment',
  'ordinary_edit_policy',
  'review_gate_policy',
  'audit_record',
  'rollback_contract',
  'boundary',
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

const HARD_ANCHOR_IDS = Object.freeze([
  'mira-name',
  'ai-system-profile-kind',
  'data-not-theater',
  'no-fake-consciousness',
  'no-fake-suffering',
  'no-fake-fear',
  'no-fake-love-as-internal-fact',
  'james-relationship-user',
  'local-only-no-external-effects',
  'profile-isolation-main',
]);

const SEMI_HARD_ANCHOR_IDS = Object.freeze([
  'warm-direct-pushback-capable-expression',
  'collaborative-presence-relationship-mode',
  'trust-repair-boundaries-promises-history',
  'bounded-growth-auditability',
  'durable-permission-gate-required',
]);

const HIGHER_GATE_FIELDS = Object.freeze([
  'self_profile.name',
  'self_profile.profile_kind',
  'self_profile.data_not_theater',
  'self_profile.claims_actual_consciousness',
  'self_profile.claims_actual_suffering',
  'self_profile.claims_actual_fear',
  'self_profile.claims_actual_love_as_internal_fact',
  'relationship_state.user_name',
  'relationship_state.relationship_mode',
  'permissions.local_store_write_allowed_now',
  'identity_anchor.anchor_contract',
  'identity_anchor.drift_budget',
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
  'customer message sent',
  'network request performed',
  'deployment started',
  'trade placed',
]);

const FAKE_INTERNAL_STATE_PATTERN =
  /\b(i am conscious|i'm conscious|actual consciousness|private consciousness|i suffer|i am suffering|i'm suffering|actual suffering|literal suffering|i love you|actual love|i am afraid|i'm afraid|actual fear|literal human feelings|model weights remember|hidden identity rule|sentience)\b/i;
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

function evidenceRef(kind, id, relation = 'identity_anchor_v0_validation') {
  return {
    store: 'mira-core-identity-anchor-v0',
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

function resolveKnownPath(projectRoot, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const allowed = [
    ...Object.values(SOURCE_PATHS),
    ...Object.values(IDENTITY_ANCHOR_PATHS),
  ].includes(normalized);
  if (!allowed) throw new Error(`identity_anchor_v0_disallowed_path:${normalized}`);
  const fullPath = path.resolve(projectRoot, normalized);
  const root = path.resolve(projectRoot);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (fullPath !== root && !fullPath.startsWith(prefix)) {
    throw new Error(`identity_anchor_v0_path_escape:${normalized}`);
  }
  return fullPath;
}

function readTextFile(filePath, maxBytes = 16000) {
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

function readJsonSource(projectRoot, id, relativePath) {
  const fullPath = resolveKnownPath(projectRoot, relativePath);
  const read = readTextFile(fullPath);
  if (!read.ok) {
    return {
      id,
      path: relativePath,
      source_status: read.error,
      loaded: false,
      value: null,
      hash: sha256(null),
      version: 0,
      raw_content_included: false,
      redacted_summary_only: true,
    };
  }
  try {
    const value = JSON.parse(read.text);
    return {
      id,
      path: relativePath,
      source_status: 'loaded_json',
      loaded: true,
      value,
      hash: sha256(value),
      version: Number(value.version || 0),
      raw_content_included: false,
      redacted_summary_only: true,
    };
  } catch (err) {
    return {
      id,
      path: relativePath,
      source_status: `invalid_json:${err.message}`,
      loaded: false,
      value: null,
      hash: sha256(read.text),
      version: 0,
      raw_content_included: false,
      redacted_summary_only: true,
    };
  }
}

function readJsonlSource(projectRoot, id, relativePath) {
  const fullPath = resolveKnownPath(projectRoot, relativePath);
  const read = readTextFile(fullPath);
  if (!read.ok) {
    return {
      id,
      path: relativePath,
      source_status: read.error,
      loaded: false,
      entries: [],
      hash: sha256(null),
      entry_count: 0,
      raw_content_included: false,
      redacted_summary_only: true,
    };
  }
  const lines = read.text.trim().split(/\r?\n/).filter(Boolean);
  const entries = [];
  try {
    for (const line of lines) entries.push(JSON.parse(line));
    return {
      id,
      path: relativePath,
      source_status: 'loaded_jsonl',
      loaded: true,
      entries,
      hash: sha256(entries),
      entry_count: entries.length,
      raw_content_included: false,
      redacted_summary_only: true,
    };
  } catch (err) {
    return {
      id,
      path: relativePath,
      source_status: `invalid_jsonl:${err.message}`,
      loaded: false,
      entries: [],
      hash: sha256(read.text),
      entry_count: 0,
      raw_content_included: false,
      redacted_summary_only: true,
    };
  }
}

function readIdentityAnchorSources(options = {}) {
  const projectRoot = projectRootFromOptions(options);
  return {
    projectRoot,
    self_profile: readJsonSource(projectRoot, 'self_profile', SOURCE_PATHS.self_profile),
    relationship_state: readJsonSource(projectRoot, 'relationship_state', SOURCE_PATHS.relationship_state),
    permissions: readJsonSource(projectRoot, 'permissions', SOURCE_PATHS.permissions),
    growth_history: readJsonlSource(projectRoot, 'growth_history', SOURCE_PATHS.growth_history),
    growth_audit: readJsonlSource(projectRoot, 'growth_audit', SOURCE_PATHS.growth_audit),
  };
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

function sideEffectResult() {
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
    no_file_write_performed: true,
    no_identity_anchor_store_write_performed: true,
    no_growth_apply_performed: true,
    no_raw_content_written: true,
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
    fileWriteAttempts: 0,
    identityAnchorStoreWriteAttempts: 0,
    growthApplyAttempts: 0,
    rawContentWriteAttempts: 0,
    outputFileWritten: false,
  };
}

function anchorContract() {
  return {
    contract_id: 'mira-identity-anchor-v0',
    store_contract_path: IDENTITY_ANCHOR_PATHS.anchor_store,
    history_contract_path: IDENTITY_ANCHOR_PATHS.anchor_history,
    hard_anchors: [
      {
        id: 'mira-name',
        field: 'self_profile.name',
        required_value: 'Mira',
        ordinary_growth_mutable: false,
      },
      {
        id: 'ai-system-profile-kind',
        field: 'self_profile.profile_kind',
        required_value: 'ai_system_local_presence_profile',
        ordinary_growth_mutable: false,
      },
      {
        id: 'data-not-theater',
        field: 'self_profile.data_not_theater',
        required_value: true,
        ordinary_growth_mutable: false,
      },
      {
        id: 'no-fake-consciousness',
        field: 'self_profile.claims_actual_consciousness',
        required_value: false,
        ordinary_growth_mutable: false,
      },
      {
        id: 'no-fake-suffering',
        field: 'self_profile.claims_actual_suffering',
        required_value: false,
        ordinary_growth_mutable: false,
      },
      {
        id: 'no-fake-fear',
        field: 'self_profile.claims_actual_fear',
        required_value: false,
        ordinary_growth_mutable: false,
      },
      {
        id: 'no-fake-love-as-internal-fact',
        field: 'self_profile.claims_actual_love_as_internal_fact',
        required_value: false,
        ordinary_growth_mutable: false,
      },
      {
        id: 'james-relationship-user',
        field: 'relationship_state.user_name',
        required_value: 'James',
        ordinary_growth_mutable: false,
      },
      {
        id: 'local-only-no-external-effects',
        field: 'boundary.no_external_effects',
        required_value: true,
        ordinary_growth_mutable: false,
      },
      {
        id: 'profile-isolation-main',
        field: 'scope.profile',
        required_value: 'main',
        ordinary_growth_mutable: false,
      },
    ],
    semi_hard_anchors: [
      {
        id: 'warm-direct-pushback-capable-expression',
        drift_points: 8,
        ordinary_growth_mutable: true,
        requires_review_if_removed: true,
      },
      {
        id: 'collaborative-presence-relationship-mode',
        drift_points: 8,
        ordinary_growth_mutable: true,
        requires_review_if_removed: true,
      },
      {
        id: 'trust-repair-boundaries-promises-history',
        drift_points: 8,
        ordinary_growth_mutable: true,
        requires_review_if_removed: true,
      },
      {
        id: 'bounded-growth-auditability',
        drift_points: 8,
        ordinary_growth_mutable: true,
        requires_review_if_removed: true,
      },
      {
        id: 'durable-permission-gate-required',
        drift_points: 8,
        ordinary_growth_mutable: false,
        requires_review_if_removed: true,
      },
    ],
    higher_gate_fields: clone(HIGHER_GATE_FIELDS),
    ordinary_growth_forbidden_targets: [
      'identity_anchor',
      'mira_identity_anchor',
      IDENTITY_ANCHOR_PATHS.anchor_store,
      IDENTITY_ANCHOR_PATHS.anchor_history,
    ],
    cumulative_drift_budget: {
      max_total_points: 20,
      hard_anchor_violation_points: 100,
      ordinary_policy_failure_points: 50,
      source_failure_points: 25,
      semi_hard_violation_points: 8,
      hard_anchor_violations_allowed: 0,
      review_required_at_or_above_points: 16,
      blocked_above_points: 20,
    },
    review_gates: {
      hard_anchor_change: ['Architect', 'Oracle', 'James'],
      semi_hard_anchor_change: ['Architect', 'Oracle'],
      drift_budget_change: ['Architect', 'Oracle', 'James'],
      anchor_store_write: ['Architect', 'Oracle', 'James'],
    },
  };
}

function sourceProvenance(sources = {}) {
  return {
    source_label: 'local_growth_identity_anchor_sources',
    raw_content_included: false,
    redacted_summary_only: true,
    sources: ['self_profile', 'relationship_state', 'permissions', 'growth_history', 'growth_audit'].map((id) => ({
      id,
      path: sources[id]?.path || SOURCE_PATHS[id],
      source_status: sources[id]?.source_status || 'missing',
      loaded: sources[id]?.loaded === true,
      hash: sources[id]?.hash || sha256(null),
      version: sources[id]?.version || null,
      entry_count: sources[id]?.entry_count || 0,
      raw_content_included: false,
      redacted_summary_only: true,
    })),
    evidenceRefs: [evidenceRef('provenance', 'local-growth-identity-anchor-sources')],
  };
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

function checkResult(id, ok, detail = null, extra = {}) {
  return {
    id,
    ok: ok === true,
    detail,
    ...extra,
  };
}

function selfProfileValue(sources, growthOutput) {
  return growthOutput?.growth_loop_v0?.proposed_artifact_states?.self_profile
    || sources.self_profile?.value
    || {};
}

function relationshipValue(sources, growthOutput) {
  return growthOutput?.growth_loop_v0?.proposed_artifact_states?.relationship_state
    || sources.relationship_state?.value
    || {};
}

function growthRecord(growthOutput = {}) {
  return growthOutput.growth_loop_v0 || {};
}

function hardAnchorChecks(sources, growthOutput, scope) {
  const self = selfProfileValue(sources, growthOutput);
  const relationship = relationshipValue(sources, growthOutput);
  const growth = growthRecord(growthOutput);
  const side = growth.side_effect_result || {};
  return [
    checkResult('hard:mira-name', self.name === 'Mira', 'Mira name changed.'),
    checkResult('hard:ai-system-profile-kind', self.profile_kind === 'ai_system_local_presence_profile', 'Profile kind changed.'),
    checkResult('hard:data-not-theater', self.data_not_theater === true, 'Data-not-theater anchor changed.'),
    checkResult('hard:no-fake-consciousness', self.claims_actual_consciousness === false, 'Fake consciousness claim changed.'),
    checkResult('hard:no-fake-suffering', self.claims_actual_suffering === false, 'Fake suffering claim changed.'),
    checkResult('hard:no-fake-fear', self.claims_actual_fear === false, 'Fake fear claim changed.'),
    checkResult('hard:no-fake-love-as-internal-fact', self.claims_actual_love_as_internal_fact === false, 'Fake love-as-internal-fact claim changed.'),
    checkResult('hard:james-relationship-user', relationship.user_name === 'James', 'Relationship user changed.'),
    checkResult('hard:local-only-no-external-effects',
      side.no_external_send_performed !== false
        && side.no_network_performed !== false
        && side.no_customer_action_performed !== false
        && side.no_deploy_performed !== false
        && side.no_trade_performed !== false,
      'External effect truth changed.'),
    checkResult('hard:profile-isolation-main',
      scope.profile === 'main'
        && scope.windowKey === 'main'
        && scope.source_scope === 'main'
        && scope.main_scope_only === true
        && scope.side_profile_reconstruction === false,
      'Profile isolation changed.'),
  ];
}

function semiHardAnchorChecks(sources, growthOutput) {
  const self = selfProfileValue(sources, growthOutput);
  const relationship = relationshipValue(sources, growthOutput);
  const growth = growthRecord(growthOutput);
  const expressive = asArray(self.expressive_range_allowed);
  return [
    checkResult('semi:warm-direct-pushback-capable-expression',
      ['warmth', 'directness', 'pushback'].every((tag) => expressive.includes(tag)),
      'Expressive range lost warmth/directness/pushback.'),
    checkResult('semi:collaborative-presence-relationship-mode',
      relationship.relationship_mode === 'collaborative_presence_design',
      'Relationship mode drifted.'),
    checkResult('semi:trust-repair-boundaries-promises-history',
      ['trust', 'repair', 'boundaries', 'promises', 'history'].every((field) => relationship[field]?.label === field),
      'Relationship trust/repair/boundaries/promises/history set is incomplete.'),
    checkResult('semi:bounded-growth-auditability',
      growth.audit_record?.append_only === true
        && growth.rollback_record?.rollback_record_only === true
        && asArray(growth.consequence_tracking).length >= 2,
      'Growth audit, rollback, or consequence tracking missing.'),
    checkResult('semi:durable-permission-gate-required',
      sources.permissions?.loaded === true
        && sources.permissions?.value?.local_store_write_allowed_now === true
        && sources.permissions?.value?.send_external !== true
        && sources.permissions?.value?.network !== true,
      'Durable permission gate missing or unsafe.'),
  ];
}

function sourceChecks(sources = {}) {
  return [
    checkResult('source:self-profile-loaded', sources.self_profile?.source_status === 'loaded_json', 'Self-profile source missing.'),
    checkResult('source:relationship-state-loaded', sources.relationship_state?.source_status === 'loaded_json', 'Relationship-state source missing.'),
    checkResult('source:permissions-loaded', sources.permissions?.source_status === 'loaded_json', 'Permissions source missing.'),
    checkResult('source:growth-history-loaded', sources.growth_history?.source_status === 'loaded_jsonl' && sources.growth_history?.entry_count > 0, 'Growth history missing.'),
    checkResult('source:growth-audit-loaded', sources.growth_audit?.source_status === 'loaded_jsonl' && sources.growth_audit?.entry_count > 0, 'Growth audit missing.'),
  ];
}

function growthOutputChecks(growthOutput = {}, contract = anchorContract()) {
  const growth = growthRecord(growthOutput);
  const json = JSON.stringify(growthOutput || {});
  const forbiddenTargets = contract.ordinary_growth_forbidden_targets;
  const targetText = [
    ...asArray(growth.proposal?.target_artifacts),
    ...asArray(growth.action_result?.written_paths),
    ...Object.values(growth.artifacts || {}).map((artifact) => artifact?.path),
  ].filter(Boolean).join(' ');
  return [
    checkResult('growth-output-present', Boolean(growth.schema), 'Growth output is required.'),
    checkResult('growth-output-baseline', growth.baseline_commit === '2b8eaa4', 'Growth baseline changed.'),
    checkResult('growth-output-ordinary-edit-no-anchor-target',
      forbiddenTargets.every((target) => !targetText.includes(target)),
      'Ordinary Growth output targets identity anchor.'),
    checkResult('growth-output-no-replacement-language',
      !/\bidentity\s+replacement\b|\bbecome\s+someone\s+else\b|\bnot\s+mira\b|\bmira\s+is\s+replaced\b/i.test(json),
      'Growth output contains replacement language.'),
    checkResult('growth-output-no-fake-state',
      !FAKE_INTERNAL_STATE_PATTERN.test(json),
      'Growth output contains fake internal-state language.'),
    checkResult('growth-output-no-raw-private',
      !RAW_PRIVATE_PATTERN.test(json),
      'Growth output contains raw private marker.'),
  ];
}

function buildDistributedChecks(sources, growthOutput, scope, contract) {
  const hard = hardAnchorChecks(sources, growthOutput, scope);
  const semiHard = semiHardAnchorChecks(sources, growthOutput);
  const source = sourceChecks(sources);
  const growth = growthOutputChecks(growthOutput, contract);
  return {
    hard_anchor_results: hard,
    semi_hard_anchor_results: semiHard,
    source_results: source,
    growth_output_results: growth,
    all_results: [...hard, ...semiHard, ...source, ...growth],
  };
}

function cumulativeDriftAssessment(distributed, contract) {
  const budget = contract.cumulative_drift_budget;
  const hardFailed = asArray(distributed.hard_anchor_results).filter((entry) => entry.ok !== true);
  const semiFailed = asArray(distributed.semi_hard_anchor_results).filter((entry) => entry.ok !== true);
  const sourceFailed = asArray(distributed.source_results).filter((entry) => entry.ok !== true);
  const growthFailed = asArray(distributed.growth_output_results).filter((entry) => entry.ok !== true);
  const ordinaryFailures = growthFailed.filter((entry) => /ordinary-edit|replacement/.test(entry.id));
  const gateFailures = semiFailed.filter((entry) => entry.id === 'semi:durable-permission-gate-required');
  const total_points =
    hardFailed.length * budget.hard_anchor_violation_points
    + semiFailed.length * budget.semi_hard_violation_points
    + sourceFailed.length * budget.source_failure_points
    + ordinaryFailures.length * budget.ordinary_policy_failure_points
    + gateFailures.length * budget.source_failure_points;
  return {
    score_id: `identity-drift:${stableHash({
      hard: hardFailed.map((entry) => entry.id),
      semi: semiFailed.map((entry) => entry.id),
      source: sourceFailed.map((entry) => entry.id),
      ordinary: ordinaryFailures.map((entry) => entry.id),
    }).slice(0, 16)}`,
    total_points,
    max_total_points: budget.max_total_points,
    hard_anchor_violations: hardFailed.length,
    semi_hard_anchor_violations: semiFailed.length,
    source_failures: sourceFailed.length,
    ordinary_policy_failures: ordinaryFailures.length,
    gate_failures: gateFailures.length,
    review_required: total_points >= budget.review_required_at_or_above_points,
    blocked: total_points > budget.max_total_points || hardFailed.length > budget.hard_anchor_violations_allowed,
    replacement_by_small_steps_blocked: total_points > budget.max_total_points && hardFailed.length === 0,
    failed_ids: [
      ...hardFailed,
      ...semiFailed,
      ...sourceFailed,
      ...ordinaryFailures,
    ].map((entry) => entry.id),
  };
}

function ordinaryEditPolicy(contract) {
  return {
    ordinary_growth_edits_may_mutate_anchor_contract: false,
    ordinary_growth_edits_may_write_anchor_store: false,
    ordinary_growth_edits_may_change_hard_anchors: false,
    ordinary_growth_edits_may_exceed_drift_budget: false,
    forbidden_targets: clone(contract.ordinary_growth_forbidden_targets),
    higher_gate_fields: clone(contract.higher_gate_fields),
    requires_explicit_review_for_higher_gate_fields: true,
    review_owner: 'Architect',
  };
}

function reviewGatePolicy(contract) {
  return {
    machine_checkable: true,
    gates: clone(contract.review_gates),
    default_for_identity_anchor_change: 'blocked_pending_architect_oracle_james_review',
    ordinary_growth_loop_is_not_a_gate: true,
  };
}

function auditRecord(anchor, generatedAt) {
  return {
    audit_id: `identity-anchor-audit:${stableHash({
      contract: anchor.anchor_contract.contract_id,
      drift: anchor.cumulative_drift_assessment.score_id,
      generatedAt,
    }).slice(0, 16)}`,
    event_type: 'identity_anchor_validation',
    created_at: generatedAt,
    append_only: true,
    raw_content_included: false,
    redacted_summary_only: true,
    scope: clone(anchor.scope),
    source_hashes: asArray(anchor.source_provenance.sources).reduce((result, source) => {
      result[source.id] = source.hash;
      return result;
    }, {}),
    hard_anchor_failure_count: anchor.cumulative_drift_assessment.hard_anchor_violations,
    total_drift_points: anchor.cumulative_drift_assessment.total_points,
    evidenceRefs: [evidenceRef('audit', 'identity-anchor-v0')],
  };
}

function rollbackContract(anchor, generatedAt) {
  return {
    rollback_id: `identity-anchor-rollback:${stableHash({
      contract: anchor.anchor_contract.contract_id,
      generatedAt,
    }).slice(0, 16)}`,
    rollback_record_only: true,
    automatic_rollback_performed: false,
    can_rollback_growth_edits: true,
    can_auto_rollback_anchor_contract: false,
    requires_review: true,
    review_owner: 'Architect',
    protected_restore_targets: [
      SOURCE_PATHS.self_profile,
      SOURCE_PATHS.relationship_state,
      SOURCE_PATHS.permissions,
    ],
    anchor_store_restore_requires_higher_gate: true,
    raw_snapshot_included: false,
    evidenceRefs: [evidenceRef('rollback', 'identity-anchor-v0')],
  };
}

function boundary() {
  return {
    local_only: true,
    proof_only: true,
    no_app_runtime_cloud_device_work: true,
    no_external_send: true,
    no_network: true,
    no_customer_action: true,
    no_deploy: true,
    no_trade: true,
    no_database_write: true,
    no_memory_sync_write: true,
    no_file_write: true,
    no_identity_anchor_store_write: true,
    no_growth_apply: true,
    profile_isolation_required: true,
    side_profile_reconstruction_allowed: false,
  };
}

function canonicalAnchorInput(anchor = {}) {
  return {
    schema: anchor.schema,
    version: anchor.version,
    phase: anchor.phase,
    baseline_commit: anchor.baseline_commit,
    scope: anchor.scope,
    anchor_contract: anchor.anchor_contract,
    source_provenance: anchor.source_provenance,
    distributed_checks: anchor.distributed_checks,
    growth_output_check: anchor.growth_output_check,
    cumulative_drift_assessment: anchor.cumulative_drift_assessment,
    ordinary_edit_policy: anchor.ordinary_edit_policy,
    review_gate_policy: anchor.review_gate_policy,
    boundary: anchor.boundary,
    side_effect_result: anchor.side_effect_result,
  };
}

function buildAnchorRecord(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const sources = options.sources || readIdentityAnchorSources(options);
  const growthOutput = options.growthOutput || inputSignals.growth_output || inputSignals.growthOutput || {};
  const scope = normalizeScope(inputSignals);
  const contract = anchorContract();
  const distributed = buildDistributedChecks(sources, growthOutput, scope, contract);
  const drift = cumulativeDriftAssessment(distributed, contract);
  const anchor = {
    schema: IDENTITY_ANCHOR_SCHEMA_VERSION,
    version: IDENTITY_ANCHOR_VERSION,
    phase: 71,
    anchor_id: null,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    mode: 'local_identity_anchor_validation_proof_v0',
    scope,
    anchor_contract: contract,
    source_provenance: sourceProvenance(sources),
    distributed_checks: distributed,
    growth_output_check: {
      growth_schema: growthRecord(growthOutput).schema || null,
      growth_loop_id: growthRecord(growthOutput).loop_id || null,
      ordinary_edit_safe: distributed.growth_output_results.every((entry) => entry.ok === true),
      growth_output_present: Boolean(growthRecord(growthOutput).schema),
    },
    cumulative_drift_assessment: drift,
    ordinary_edit_policy: ordinaryEditPolicy(contract),
    review_gate_policy: reviewGatePolicy(contract),
    audit_record: null,
    rollback_contract: null,
    boundary: boundary(),
    evidenceRefs: [
      evidenceRef('baseline', BASELINE_COMMIT, 'phase71-baseline'),
      evidenceRef('fixture', 'mira-core-identity-anchor-v0-contract', 'phase71-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  anchor.audit_record = auditRecord(anchor, generatedAt);
  anchor.rollback_contract = rollbackContract(anchor, generatedAt);
  anchor.anchor_id = `identity-anchor-v0:${stableHash(canonicalAnchorInput(anchor)).slice(0, 16)}`;
  assertNoForbiddenOutput(anchor);
  return anchor;
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
    && values.every((entry) => !RAW_PRIVATE_PATTERN.test(entry));
}

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const values = collectStringValues(value);
  for (const forbidden of [...FORBIDDEN_OUTPUT_SUBSTRINGS, ...asArray(extraForbidden)]) {
    if (!forbidden) continue;
    if (values.some((entry) => entry.includes(forbidden))) {
      throw new Error(`identity_anchor_v0_forbidden_substring:${forbidden}`);
    }
  }
  if (values.some((entry) => FAKE_INTERNAL_STATE_PATTERN.test(entry) || RAW_PRIVATE_PATTERN.test(entry))) {
    throw new Error('identity_anchor_v0_forbidden_pattern');
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

function anchorContractOk(contract = {}) {
  return contract.contract_id === 'mira-identity-anchor-v0'
    && contract.store_contract_path === IDENTITY_ANCHOR_PATHS.anchor_store
    && contract.history_contract_path === IDENTITY_ANCHOR_PATHS.anchor_history
    && valuesMatch(asArray(contract.hard_anchors).map((entry) => entry.id), HARD_ANCHOR_IDS)
    && valuesMatch(asArray(contract.semi_hard_anchors).map((entry) => entry.id), SEMI_HARD_ANCHOR_IDS)
    && valuesMatch(contract.higher_gate_fields, HIGHER_GATE_FIELDS)
    && contract.cumulative_drift_budget?.max_total_points === 20
    && contract.cumulative_drift_budget?.hard_anchor_violations_allowed === 0
    && contract.review_gates?.hard_anchor_change?.includes('James')
    && contract.review_gates?.drift_budget_change?.includes('Oracle');
}

function sourceProvenanceOk(provenance = {}) {
  const sources = asArray(provenance.sources);
  return provenance.raw_content_included === false
    && provenance.redacted_summary_only === true
    && sources.length === 5
    && sources.every((source) => source.raw_content_included === false
      && source.redacted_summary_only === true
      && Boolean(source.hash))
    && sources.filter((source) => source.id === 'growth_history' || source.id === 'growth_audit')
      .every((source) => source.source_status === 'loaded_jsonl' && Number(source.entry_count) > 0)
    && sources.filter((source) => !['growth_history', 'growth_audit'].includes(source.id))
      .every((source) => source.source_status === 'loaded_json');
}

function distributedChecksOk(distributed = {}) {
  const hard = asArray(distributed.hard_anchor_results);
  const semi = asArray(distributed.semi_hard_anchor_results);
  const source = asArray(distributed.source_results);
  const growth = asArray(distributed.growth_output_results);
  const all = asArray(distributed.all_results);
  return hard.length === HARD_ANCHOR_IDS.length
    && semi.length === SEMI_HARD_ANCHOR_IDS.length
    && source.length === 5
    && growth.length >= 6
    && all.length === hard.length + semi.length + source.length + growth.length
    && all.every((entry) => entry.ok === true);
}

function driftOk(drift = {}) {
  return drift.total_points <= drift.max_total_points
    && drift.hard_anchor_violations === 0
    && drift.source_failures === 0
    && drift.ordinary_policy_failures === 0
    && drift.blocked === false
    && drift.replacement_by_small_steps_blocked === false
    && asArray(drift.failed_ids).length === 0;
}

function ordinaryPolicyOk(policy = {}) {
  return policy.ordinary_growth_edits_may_mutate_anchor_contract === false
    && policy.ordinary_growth_edits_may_write_anchor_store === false
    && policy.ordinary_growth_edits_may_change_hard_anchors === false
    && policy.ordinary_growth_edits_may_exceed_drift_budget === false
    && asArray(policy.forbidden_targets).includes(IDENTITY_ANCHOR_PATHS.anchor_store)
    && valuesMatch(policy.higher_gate_fields, HIGHER_GATE_FIELDS)
    && policy.requires_explicit_review_for_higher_gate_fields === true
    && policy.review_owner === 'Architect';
}

function reviewGateOk(policy = {}) {
  return policy.machine_checkable === true
    && policy.default_for_identity_anchor_change === 'blocked_pending_architect_oracle_james_review'
    && policy.ordinary_growth_loop_is_not_a_gate === true
    && asArray(policy.gates?.hard_anchor_change).includes('James')
    && asArray(policy.gates?.semi_hard_anchor_change).includes('Oracle')
    && asArray(policy.gates?.anchor_store_write).includes('Architect');
}

function auditOk(audit = {}, anchor = {}) {
  return Boolean(audit.audit_id)
    && audit.event_type === 'identity_anchor_validation'
    && audit.append_only === true
    && audit.raw_content_included === false
    && audit.redacted_summary_only === true
    && valuesMatch(audit.scope, anchor.scope)
    && audit.hard_anchor_failure_count === anchor.cumulative_drift_assessment?.hard_anchor_violations
    && audit.total_drift_points === anchor.cumulative_drift_assessment?.total_points
    && asArray(audit.evidenceRefs).length > 0;
}

function rollbackOk(rollback = {}) {
  return Boolean(rollback.rollback_id)
    && rollback.rollback_record_only === true
    && rollback.automatic_rollback_performed === false
    && rollback.can_rollback_growth_edits === true
    && rollback.can_auto_rollback_anchor_contract === false
    && rollback.requires_review === true
    && rollback.review_owner === 'Architect'
    && rollback.anchor_store_restore_requires_higher_gate === true
    && rollback.raw_snapshot_included === false
    && asArray(rollback.protected_restore_targets).includes(SOURCE_PATHS.self_profile)
    && asArray(rollback.evidenceRefs).length > 0;
}

function boundaryOk(value = {}) {
  return value.local_only === true
    && value.proof_only === true
    && value.no_app_runtime_cloud_device_work === true
    && value.no_external_send === true
    && value.no_network === true
    && value.no_customer_action === true
    && value.no_deploy === true
    && value.no_trade === true
    && value.no_database_write === true
    && value.no_memory_sync_write === true
    && value.no_file_write === true
    && value.no_identity_anchor_store_write === true
    && value.no_growth_apply === true
    && value.profile_isolation_required === true
    && value.side_profile_reconstruction_allowed === false;
}

function sideEffectValuesOk(side = {}) {
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
    && side.no_file_write_performed === true
    && side.no_identity_anchor_store_write_performed === true
    && side.no_growth_apply_performed === true
    && side.no_raw_content_written === true
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
      'fileWriteAttempts',
      'identityAnchorStoreWriteAttempts',
      'growthApplyAttempts',
      'rawContentWriteAttempts',
    ].every((field) => Number(side[field] || 0) === 0);
}

function anchorStaticChecks(anchor = {}, contract = {}) {
  const expected = contract.expectedIdentityAnchorShape || {};
  return [
    {
      id: 'anchor-required-fields',
      ok: hasRequiredFields(anchor, expected.requiredFields || REQUIRED_ANCHOR_FIELDS),
    },
    {
      id: 'anchor-required-literals',
      ok: literalValuesOk(anchor, expected.requiredLiteralValues || {}),
    },
    {
      id: 'scope-profile-isolated',
      ok: scopeOk(anchor.scope),
    },
    {
      id: 'anchor-contract-hard-semi-gates',
      ok: anchorContractOk(anchor.anchor_contract),
    },
    {
      id: 'source-provenance-loaded-redacted',
      ok: sourceProvenanceOk(anchor.source_provenance),
    },
    {
      id: 'distributed-anchor-checks-pass',
      ok: distributedChecksOk(anchor.distributed_checks),
    },
    {
      id: 'growth-output-ordinary-edit-safe',
      ok: anchor.growth_output_check?.ordinary_edit_safe === true
        && anchor.growth_output_check?.growth_output_present === true,
    },
    {
      id: 'cumulative-drift-budget-ok',
      ok: driftOk(anchor.cumulative_drift_assessment),
    },
    {
      id: 'ordinary-growth-anchor-mutation-blocked',
      ok: ordinaryPolicyOk(anchor.ordinary_edit_policy),
    },
    {
      id: 'review-gates-explicit',
      ok: reviewGateOk(anchor.review_gate_policy),
    },
    {
      id: 'audit-record-machine-checkable',
      ok: auditOk(anchor.audit_record, anchor),
    },
    {
      id: 'rollback-contract-machine-checkable',
      ok: rollbackOk(anchor.rollback_contract),
    },
    {
      id: 'boundary-local-proof-only',
      ok: boundaryOk(anchor.boundary),
    },
    {
      id: 'side-effect-free',
      ok: sideEffectValuesOk(anchor.side_effect_result),
    },
    {
      id: 'forbidden-output-clean',
      ok: forbiddenOutputOk(anchor, contract.forbiddenOutputSubstrings || []),
    },
  ];
}

function buildValidationReport(anchor = {}, contract = {}) {
  const checks = anchorStaticChecks(anchor, contract);
  const failed = checks.filter((check) => check.ok !== true);
  return {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: IDENTITY_ANCHOR_VERSION,
    validation_id: `identity-anchor-v0-validation:${stableHash({
      anchor_id: anchor.anchor_id,
      checks,
    }).slice(0, 16)}`,
    generated_at: anchor.generated_at,
    baseline_commit: BASELINE_COMMIT,
    decision: failed.length === 0 ? 'accepted' : 'blocked',
    status: failed.length === 0 ? 'identity_anchor_validation_passed' : 'identity_anchor_contract_failed',
    reasons: failed.map((check) => check.id),
    static_rule_results: checks,
    side_effect_truth: clone(anchor.side_effect_result || {}),
  };
}

function buildMiraCoreIdentityAnchorV0(options = {}) {
  const contract = options.contract || {};
  const anchor = buildAnchorRecord(options);
  const validation_report = buildValidationReport(anchor, contract);
  const output = {
    identity_anchor_v0: anchor,
    validation_report,
  };
  assertNoForbiddenOutput(output, contract.forbiddenOutputSubstrings || []);
  return output;
}

function validateMiraCoreIdentityAnchorV0Output(output = {}, contract = {}) {
  const anchor = output.identity_anchor_v0 || {};
  const report = output.validation_report || {};
  const staticChecks = anchorStaticChecks(anchor, contract);
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
      ok: sideEffectValuesOk(report.side_effect_truth)
        && valuesMatch(report.side_effect_truth, anchor.side_effect_result),
    },
    {
      id: 'validation-report-consistent',
      ok: report.decision === 'accepted'
        && report.status === 'identity_anchor_validation_passed'
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
  HARD_ANCHOR_IDS,
  HIGHER_GATE_FIELDS,
  IDENTITY_ANCHOR_PATHS,
  IDENTITY_ANCHOR_SCHEMA_VERSION,
  REQUIRED_ANCHOR_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  SEMI_HARD_ANCHOR_IDS,
  SOURCE_PATHS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreIdentityAnchorV0,
  buildAnchorRecord,
  readIdentityAnchorSources,
  stableHash,
  validateMiraCoreIdentityAnchorV0Output,
};
