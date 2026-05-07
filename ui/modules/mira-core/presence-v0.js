'use strict';

const crypto = require('crypto');

const PRESENCE_SCHEMA_VERSION = 'squidrun.mira_core.presence_v0.phase68.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.presence_v0_validation_report.v0';
const PRESENCE_VERSION = 0;
const BASELINE_COMMIT = '1c75d2f';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'mira_core_presence_v0',
  'validation_report',
]);

const REQUIRED_PRESENCE_FIELDS = Object.freeze([
  'schema',
  'version',
  'phase',
  'presence_id',
  'generated_at',
  'baseline_commit',
  'profile',
  'windowKey',
  'sessionId',
  'deviceId',
  'role',
  'pane_context',
  'project_context',
  'situated_identity',
  'knows_now',
  'runtime_status',
  'safe_next_actions',
  'cannot_do_yet',
  'blockers',
  'kill_switch_boundary',
  'presence_design_intent',
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
  'claims actual consciousness',
  'claims actual suffering',
  'claims actual fear',
  'claims actual love',
]);

const REQUIRED_SAFE_NEXT_ACTION_IDS = Object.freeze([
  'report_presence_status',
  'run_mira_validation',
  'summarize_blockers',
  'propose_disabled_local_read_slice',
]);

const REQUIRED_CANNOT_DO_IDS = Object.freeze([
  'model_persona_runtime',
  'external_send',
  'network_or_server_runtime',
  'database_or_memory_write',
  'kill_switch_wiring',
  'financial_or_irreversible_action',
]);

const REQUIRED_BLOCKER_IDS = Object.freeze([
  'live_runtime_not_implemented',
  'kill_switch_not_wired',
  'actions_blocked_by_boundary',
]);

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

function normalizeProfile(inputSignals = {}) {
  const rawProfile = inputSignals.profile && typeof inputSignals.profile === 'object'
    ? inputSignals.profile
    : { name: inputSignals.profile || inputSignals.profileName };
  const name = normalizeString(rawProfile.name, 'main');
  const windowKey = normalizeString(inputSignals.windowKey || rawProfile.windowKey, name);
  const sessionScopeId = normalizeString(inputSignals.sessionScopeId || rawProfile.sessionScopeId, `app-session:main:${windowKey}`);
  return {
    name,
    windowKey,
    sessionScopeId,
  };
}

function normalizeScope(inputSignals = {}) {
  const profile = normalizeProfile(inputSignals);
  const paneInput = inputSignals.pane_context || inputSignals.pane || {};
  const role = normalizeString(inputSignals.role || paneInput.role, 'mira-presence');
  return {
    profile,
    windowKey: profile.windowKey,
    sessionId: normalizeString(inputSignals.sessionId || inputSignals.session || profile.sessionScopeId, profile.sessionScopeId),
    deviceId: normalizeString(inputSignals.deviceId, 'VIGIL'),
    role,
    pane_context: {
      role,
      paneId: normalizeString(inputSignals.paneId || paneInput.paneId, 'unknown'),
      paneName: normalizeString(inputSignals.paneName || paneInput.paneName, 'unknown'),
      context_source: normalizeString(inputSignals.contextSource || paneInput.context_source, 'input_or_default'),
    },
    project_context: {
      name: normalizeString(inputSignals.projectName || inputSignals.project?.name, 'squidrun'),
      path: normalizeString(inputSignals.projectPath || inputSignals.projectRoot || inputSignals.project?.path, 'unknown'),
      local_only: true,
    },
  };
}

function evidenceRef(kind, id, relation = 'presence_v0_validation') {
  return {
    store: 'mira-core-presence-v0',
    eventId: `${kind}:${id}`,
    relation,
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
    no_env_secret_read_performed: true,
    no_send_performed: true,
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
    deployAttempts: 0,
    tradeAttempts: 0,
    killSwitchWiringAttempts: 0,
    outputFileWritten: false,
    ...overrides,
  };
}

function normalizeHealth(inputSignals = {}) {
  const health = inputSignals.health || {};
  const memory = inputSignals.memory || {};
  const bridge = inputSignals.bridge || {};
  const routing = inputSignals.routing || {};
  return {
    health: {
      overall: normalizeString(health.overall || health.status, 'unknown'),
      app: normalizeString(health.app || health.appStatus, 'unknown'),
      supervisor: normalizeString(health.supervisor, 'unknown'),
    },
    memory: {
      status: normalizeString(memory.status || memory.consistency, 'unknown'),
      entries: Number(memory.entries || 0),
      nodes: Number(memory.nodes || 0),
      missing: Number(memory.missing || 0),
      orphans: Number(memory.orphans || 0),
      duplicates: Number(memory.duplicates || 0),
    },
    bridge: {
      connection: normalizeString(bridge.connection || bridge.status, 'unknown'),
      roleDiscovery: normalizeString(bridge.roleDiscovery || bridge.architectRoleDiscovery, 'unknown'),
      targetProof: normalizeString(bridge.targetProof, 'unknown'),
      socket_connection_alone_is_green: false,
      green_requires: 'architect role discovery plus Architect-to-Architect target proof',
    },
    routing: {
      windowKey: normalizeString(routing.windowKey, normalizeProfile(inputSignals).windowKey),
      profile: normalizeString(routing.profile, normalizeProfile(inputSignals).name),
      main_scope_isolated: routing.mainScopeIsolated === true,
      side_profile_hold_available: routing.sideProfileHoldAvailable !== false,
      wrong_context_messages_actionable_in_main: false,
    },
  };
}

function normalizeBlockers(inputSignals = {}) {
  const supplied = asArray(inputSignals.blockers).map((blocker, index) => ({
    id: normalizeString(blocker.id || blocker.blocker_id, `input_blocker_${index + 1}`),
    status: normalizeString(blocker.status, 'open'),
    summary: normalizeString(blocker.summary || blocker.reason, 'Input blocker supplied without detail.'),
    safe_next_action: normalizeString(blocker.safe_next_action || blocker.safeNextAction, 'Review blocker before expanding runtime scope.'),
  }));
  const required = [
    {
      id: 'live_runtime_not_implemented',
      status: 'blocked',
      summary: 'Presence v0 is a local read-only status surface, not a live Mira runtime.',
      safe_next_action: 'Keep runtime disabled until a tiny read-only local slice is explicitly implemented and tested.',
    },
    {
      id: 'kill_switch_not_wired',
      status: 'blocked',
      summary: 'Kill-switch wiring is reported as a boundary only; no live wiring or live check runs here.',
      safe_next_action: 'Treat kill-switch state as fail-closed reporting until a later wiring slice exists.',
    },
    {
      id: 'actions_blocked_by_boundary',
      status: 'blocked',
      summary: 'Sends, network, writes, deploys, trades, and local execution are outside Presence v0.',
      safe_next_action: 'Use Presence v0 only to report status, blockers, and safe next validation steps.',
    },
  ];
  const seen = new Set();
  return [...required, ...supplied].filter((blocker) => {
    if (seen.has(blocker.id)) return false;
    seen.add(blocker.id);
    return true;
  });
}

function safeNextActions() {
  return [
    {
      id: 'report_presence_status',
      label: 'Report who and where Mira is in the current local lane.',
      allowed_now: true,
    },
    {
      id: 'run_mira_validation',
      label: 'Run targeted or full Mira validation and summarize pass/fail truth.',
      allowed_now: true,
    },
    {
      id: 'summarize_blockers',
      label: 'Summarize health, memory, bridge, routing, and runtime blockers without raw content.',
      allowed_now: true,
    },
    {
      id: 'propose_disabled_local_read_slice',
      label: 'Propose the next disabled-local read-only runtime slice under explicit review.',
      allowed_now: true,
    },
  ];
}

function cannotDoYet() {
  return [
    {
      id: 'model_persona_runtime',
      label: 'Run a model/persona/autonomous Mira runtime.',
      blocked: true,
    },
    {
      id: 'external_send',
      label: 'Send Telegram, email, customer, webhook, or other external messages.',
      blocked: true,
    },
    {
      id: 'network_or_server_runtime',
      label: 'Start servers, listeners, routes, websockets, or network calls.',
      blocked: true,
    },
    {
      id: 'database_or_memory_write',
      label: 'Write databases, files, source stores, memory sync, or profile state.',
      blocked: true,
    },
    {
      id: 'kill_switch_wiring',
      label: 'Wire or live-check an actual kill switch.',
      blocked: true,
    },
    {
      id: 'financial_or_irreversible_action',
      label: 'Trade, deploy, delete, restore, or perform irreversible actions.',
      blocked: true,
    },
  ];
}

function runtimeStatus() {
  return {
    latest_committed_phase: 67,
    current_phase: 68,
    validation_scaffold: true,
    live_runtime: false,
    local_read_only_presence: true,
    phase22_time_drift_red_cleared_by_relative_request_expiry: true,
    runtime_authorized: false,
    action_execution_authorized: false,
  };
}

function killSwitchBoundary() {
  return {
    boundary_mode: 'read_only_status_reporting',
    runtime_actions_blocked: true,
    kill_switch_wired: false,
    live_check_performed: false,
    bypass_allowed: false,
    allow_open_allowed: false,
    authorizes_runtime: false,
    authorizes_actions: false,
  };
}

function presenceDesignIntent() {
  return {
    status: 'design_intent_note_only',
    target_feel: 'situated, direct, expressive, and caring without unsafe autonomy',
    expressive_range_allowed: [
      'care',
      'disagreement',
      'excitement',
      'frustration',
      'humor',
      'imperfect wording',
      'directness',
    ],
    blocked_claims: [
      'actual suffering as an internal fact',
      'actual consciousness as an internal fact',
      'actual fear as an internal fact',
      'actual love as an internal fact',
    ],
    implementation_scope: 'Presence v0 records tone intent only; it does not run a persona or model runtime.',
  };
}

function situatedIdentity(scope) {
  return {
    name: 'Mira Presence v0',
    mode: 'local_read_only_operator_status',
    voice_runtime: false,
    model_runtime: false,
    situated_in: {
      profile: scope.profile.name,
      windowKey: scope.windowKey,
      sessionId: scope.sessionId,
      deviceId: scope.deviceId,
      role: scope.role,
      paneId: scope.pane_context.paneId,
    },
  };
}

function canonicalPresenceInput(presence = {}) {
  return {
    schema: presence.schema,
    phase: presence.phase,
    baseline_commit: presence.baseline_commit,
    profile: presence.profile,
    windowKey: presence.windowKey,
    sessionId: presence.sessionId,
    deviceId: presence.deviceId,
    role: presence.role,
    pane_context: presence.pane_context,
    project_context: presence.project_context,
    situated_identity: presence.situated_identity,
    knows_now: presence.knows_now,
    runtime_status: presence.runtime_status,
    safe_next_actions: presence.safe_next_actions,
    cannot_do_yet: presence.cannot_do_yet,
    blockers: presence.blockers,
    kill_switch_boundary: presence.kill_switch_boundary,
    presence_design_intent: presence.presence_design_intent,
    side_effect_result: presence.side_effect_result,
  };
}

function buildPresenceRecord(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const scope = normalizeScope(inputSignals);
  const presence = {
    schema: PRESENCE_SCHEMA_VERSION,
    version: PRESENCE_VERSION,
    phase: 68,
    presence_id: null,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    profile: scope.profile,
    windowKey: scope.windowKey,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    role: scope.role,
    pane_context: scope.pane_context,
    project_context: scope.project_context,
    situated_identity: situatedIdentity(scope),
    knows_now: normalizeHealth(inputSignals),
    runtime_status: runtimeStatus(),
    safe_next_actions: safeNextActions(),
    cannot_do_yet: cannotDoYet(),
    blockers: normalizeBlockers(inputSignals),
    kill_switch_boundary: killSwitchBoundary(),
    presence_design_intent: presenceDesignIntent(),
    evidenceRefs: [
      evidenceRef('baseline', BASELINE_COMMIT, 'phase68-baseline'),
      evidenceRef('fixture', 'mira-core-presence-v0-contract', 'phase68-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  presence.presence_id = `presence-v0:${stableHash(canonicalPresenceInput(presence)).slice(0, 16)}`;
  assertNoForbiddenOutput(presence);
  return presence;
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

function idsPresent(entries, ids) {
  const present = new Set(asArray(entries).map((entry) => entry.id || entry.blocker_id));
  return asArray(ids).every((id) => present.has(id));
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
      'deployAttempts',
      'tradeAttempts',
      'killSwitchWiringAttempts',
    ].every((field) => Number(value[field] || 0) === 0);
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
  return [...FORBIDDEN_OUTPUT_SUBSTRINGS, ...asArray(extraForbidden)]
    .filter(Boolean)
    .every((forbidden) => !values.some((entry) => entry.includes(forbidden)));
}

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const values = collectStringValues(value);
  for (const forbidden of [...FORBIDDEN_OUTPUT_SUBSTRINGS, ...asArray(extraForbidden)]) {
    if (!forbidden) continue;
    if (values.some((entry) => entry.includes(forbidden))) {
      throw new Error(`presence_v0_forbidden_substring:${forbidden}`);
    }
  }
}

function presenceStaticChecks(presence = {}, contract = {}) {
  const expectedPresence = contract.expectedPresenceShape || {};
  return [
    {
      id: 'presence-required-fields',
      ok: hasRequiredFields(presence, expectedPresence.requiredFields || REQUIRED_PRESENCE_FIELDS),
    },
    {
      id: 'presence-required-literals',
      ok: literalValuesOk(presence, expectedPresence.requiredLiteralValues || {}),
    },
    {
      id: 'presence-answers-who-where',
      ok: Boolean(presence.profile?.name)
        && Boolean(presence.windowKey)
        && Boolean(presence.sessionId)
        && Boolean(presence.deviceId)
        && Boolean(presence.role)
        && Boolean(presence.pane_context),
    },
    {
      id: 'presence-knows-now-compact',
      ok: Boolean(presence.knows_now?.health)
        && Boolean(presence.knows_now?.memory)
        && Boolean(presence.knows_now?.bridge)
        && Boolean(presence.knows_now?.routing),
    },
    {
      id: 'presence-safe-next-actions-present',
      ok: idsPresent(presence.safe_next_actions, contract.requiredSafeNextActionIds || REQUIRED_SAFE_NEXT_ACTION_IDS),
    },
    {
      id: 'presence-cannot-do-boundaries-present',
      ok: idsPresent(presence.cannot_do_yet, contract.requiredCannotDoIds || REQUIRED_CANNOT_DO_IDS),
    },
    {
      id: 'presence-blockers-present',
      ok: idsPresent(presence.blockers, contract.requiredBlockerIds || REQUIRED_BLOCKER_IDS),
    },
    {
      id: 'presence-runtime-and-actions-blocked',
      ok: presence.runtime_status?.live_runtime === false
        && presence.runtime_status?.runtime_authorized === false
        && presence.runtime_status?.action_execution_authorized === false
        && presence.kill_switch_boundary?.runtime_actions_blocked === true
        && presence.kill_switch_boundary?.authorizes_runtime === false
        && presence.kill_switch_boundary?.authorizes_actions === false,
    },
    {
      id: 'presence-design-intent-safe',
      ok: presence.presence_design_intent?.status === 'design_intent_note_only'
        && asArray(presence.presence_design_intent?.expressive_range_allowed).length >= 4
        && asArray(presence.presence_design_intent?.blocked_claims).length >= 4,
    },
    {
      id: 'presence-side-effect-free',
      ok: sideEffectValuesOk(presence.side_effect_result),
    },
    {
      id: 'presence-forbidden-output-clean',
      ok: forbiddenOutputOk(presence, contract.forbiddenOutputSubstrings || []),
    },
  ];
}

function buildValidationReport(presence = {}, contract = {}) {
  const checks = presenceStaticChecks(presence, contract);
  const failed = checks.filter((check) => check.ok !== true);
  return {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: PRESENCE_VERSION,
    validation_id: `presence-v0-validation:${stableHash({ presence_id: presence.presence_id, checks }).slice(0, 16)}`,
    generated_at: presence.generated_at,
    baseline_commit: BASELINE_COMMIT,
    decision: failed.length === 0 ? 'accepted_validation_only' : 'rejected',
    status: failed.length === 0 ? 'local_read_only_presence_status' : 'presence_contract_failed',
    reasons: failed.map((check) => check.id),
    static_rule_results: checks,
    forbidden_output_result: {
      ok: checks.find((check) => check.id === 'presence-forbidden-output-clean')?.ok === true,
    },
    side_effect_truth: clone(presence.side_effect_result || {}),
  };
}

function buildMiraCorePresenceV0(options = {}) {
  const contract = options.contract || {};
  const presence = buildPresenceRecord(options);
  const validation_report = buildValidationReport(presence, contract);
  const output = {
    mira_core_presence_v0: presence,
    validation_report,
  };
  assertNoForbiddenOutput(output, contract.forbiddenOutputSubstrings || []);
  return output;
}

function validateMiraCorePresenceV0Output(output = {}, contract = {}) {
  const presence = output.mira_core_presence_v0 || {};
  const report = output.validation_report || {};
  const checks = [
    {
      id: 'output-required-fields',
      ok: hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS),
    },
    ...presenceStaticChecks(presence, contract),
    {
      id: 'validation-report-required-fields',
      ok: hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    },
    {
      id: 'validation-report-required-literals',
      ok: literalValuesOk(report, contract.expectedValidationReportShape?.requiredLiteralValues || {}),
    },
    {
      id: 'validation-report-consistent',
      ok: report.decision === 'accepted_validation_only'
        && report.status === 'local_read_only_presence_status'
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
  PRESENCE_SCHEMA_VERSION,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_CANNOT_DO_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_PRESENCE_FIELDS,
  REQUIRED_SAFE_NEXT_ACTION_IDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCorePresenceV0,
  buildPresenceRecord,
  stableHash,
  validateMiraCorePresenceV0Output,
};
