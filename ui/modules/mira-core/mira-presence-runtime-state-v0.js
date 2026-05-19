'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  buildMiraCorePresenceRuntimeReadPathV0,
  readPresenceRuntimeReadPathSources,
  validateMiraCorePresenceRuntimeReadPathV0Output,
} = require('./presence-runtime-read-path-v0');
const {
  buildTypedRestartContinuityContextV0,
} = require('./typed-restart-continuity-context-v0');
const {
  classifyAttachmentContractViolation,
  outputViolatesAttachmentContract,
} = require('./text-model-attachment-v1');
const {
  evaluateMiraVisibleReply,
} = require('./mira-language-rules-v0');
const {
  visibleReplyLeakageViolation,
} = require('./local-text-session-v0');

const SCHEMA_VERSION = 'squidrun.mira_core.presence_runtime_state.v0';
const STATE_VERSION = 1;
const START_PROOF_SCHEMA_VERSION = 'squidrun.mira_core.presence_start_proof_harness.v0';
const ALLOWED_RELATIVE_DIR = path.join('.squidrun', 'state');
const ALLOWED_FILENAME = 'mira-presence-runtime-state.json';

const VALID_INTERRUPTION_MARKERS = Object.freeze(['safely_captured', 'not_captured', 'none']);
const VALID_AGENCY_LEVELS = Object.freeze(['A0', 'A1', 'A2', 'A3', 'A4', 'A5']);

const REQUIRED_STARTUP_SUMMARY_KEYS = Object.freeze([
  'active_mira_presence_lane',
  'accepted_critique',
  'next_product_action',
  'proof_test_state',
  'stale_markers',
]);

const REQUIRED_BLOCKED_FLAGS = Object.freeze([
  'live_voice_blocked',
  'always_on_mic_blocked',
  'pc_embodiment_blocked',
  'a3_a4_blocked',
]);

const INTERRUPTED_NOT_CAPTURED_STALE_MARKER =
  'interrupted_not_captured:do_not_pretend_exact_prior_phrasing_survived';

const SURFACE_BACKSTAGE_INTERNAL_ONLY = 'backstage_internal_only';

const VISIBLE_LEAKAGE_FIELDS = Object.freeze([
  'accepted_critique',
  'proof_test_state',
  'next_product_action',
]);
const START_PROOF_DEFAULT_PROMPT = 'what are we doing with Mira?';
const START_PROOF_DEFAULT_VISIBLE_REPLY =
  "We're making restart less amnesiac, so you don't have to hand me the same thread of myself every time.";
const START_PROOF_VISIBLE_FORBIDDEN_PATTERN =
  /\b(architect|builder|oracle|pane|hm-send|comms_journal|current_lane|accepted_critique|next_product_action|proof_test_state|stale_markers|system prompt|prompt scaffolding|validation fixture|guardrails?|policy|rule-recitation|anti-smoothing|anti-performance|anti-leak|assistant voice|assistant cadence|cold-start check|local state|before voice goes anywhere)\b/i;
const START_PROOF_PRESENCE_STATE_SOURCE_KIND = 'mira_presence_runtime_state_json';

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalize(value[key]);
  }
  return sorted;
}

function canonicalHash(value) {
  const json = JSON.stringify(canonicalize(value));
  return `sha256:${crypto.createHash('sha256').update(json).digest('hex')}`;
}

function resolveStatePath(projectRoot) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('mira_presence_runtime_state:project_root_required');
  }
  return path.join(projectRoot, ALLOWED_RELATIVE_DIR, ALLOWED_FILENAME);
}

function isPathAllowed(projectRoot, candidatePath) {
  const expected = path.resolve(resolveStatePath(projectRoot));
  return path.resolve(String(candidatePath || '')) === expected;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeStaleMarkers(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function validateInputState(state) {
  const errors = [];
  if (!state || typeof state !== 'object') {
    return { ok: false, errors: ['state_required'] };
  }
  for (const key of REQUIRED_STARTUP_SUMMARY_KEYS) {
    const value = state[key];
    if (key === 'stale_markers') {
      if (!Array.isArray(value)) errors.push(`missing_or_invalid:${key}`);
    } else if (!isNonEmptyString(value)) {
      errors.push(`missing_or_invalid:${key}`);
    }
  }
  if (!state.blocked_status || typeof state.blocked_status !== 'object') {
    errors.push('missing_or_invalid:blocked_status');
  } else {
    for (const flag of REQUIRED_BLOCKED_FLAGS) {
      if (state.blocked_status[flag] !== true) {
        errors.push(`blocked_status_must_be_true:${flag}`);
      }
    }
  }
  if (!VALID_INTERRUPTION_MARKERS.includes(state.interruption_marker)) {
    errors.push('invalid_interruption_marker');
  }
  if (!VALID_AGENCY_LEVELS.includes(state.agency_level)) {
    errors.push('invalid_agency_level');
  }
  return { ok: errors.length === 0, errors };
}

function buildStateRecord({ state, nowIso }) {
  const generatedAt = nowIso || new Date().toISOString();
  const record = {
    schema: SCHEMA_VERSION,
    version: STATE_VERSION,
    generated_at: generatedAt,
    surface: SURFACE_BACKSTAGE_INTERNAL_ONLY,
    active_mira_presence_lane: String(state.active_mira_presence_lane).trim(),
    accepted_critique: String(state.accepted_critique).trim(),
    next_product_action: String(state.next_product_action).trim(),
    proof_test_state: String(state.proof_test_state).trim(),
    stale_markers: normalizeStaleMarkers(state.stale_markers),
    blocked_status: {
      live_voice_blocked: state.blocked_status.live_voice_blocked === true,
      always_on_mic_blocked: state.blocked_status.always_on_mic_blocked === true,
      pc_embodiment_blocked: state.blocked_status.pc_embodiment_blocked === true,
      a3_a4_blocked: state.blocked_status.a3_a4_blocked === true,
    },
    interruption_marker: state.interruption_marker,
    agency_level: state.agency_level,
  };
  record.canonical_hash = canonicalHash({ ...record, canonical_hash: undefined });
  return record;
}

function writeAtomic(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, targetPath);
}

function buildMiraPresenceRuntimeStateV0(options) {
  const opts = options || {};
  const projectRoot = opts.projectRoot;
  const mode = opts.apply === true ? 'apply' : 'dry_run';
  const nowIso = opts.nowIso || new Date().toISOString();
  const targetPath = resolveStatePath(projectRoot);
  const validation = validateInputState(opts.state);
  if (!validation.ok) {
    return {
      mode,
      decision: 'blocked_invalid_state',
      reasons: validation.errors,
      target_path: targetPath,
      written: false,
    };
  }
  const record = buildStateRecord({ state: opts.state, nowIso });
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (mode === 'dry_run') {
    return {
      mode,
      decision: 'preview_no_writes',
      target_path: targetPath,
      written: false,
      preview: record,
    };
  }
  if (!isPathAllowed(projectRoot, targetPath)) {
    return {
      mode,
      decision: 'blocked_unsafe_path',
      reasons: ['path_outside_allowlist'],
      target_path: targetPath,
      written: false,
    };
  }
  let prior = null;
  if (fs.existsSync(targetPath)) {
    try {
      prior = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    } catch (_) {
      prior = null;
    }
  }
  if (prior && prior.canonical_hash === record.canonical_hash) {
    return {
      mode,
      decision: 'noop_already_current',
      target_path: targetPath,
      written: false,
      record,
    };
  }
  writeAtomic(targetPath, serialized);
  return {
    mode,
    decision: 'applied',
    target_path: targetPath,
    written: true,
    record,
  };
}

function readMiraPresenceRuntimeState(options) {
  const projectRoot = (options || {}).projectRoot;
  const targetPath = resolveStatePath(projectRoot);
  if (!fs.existsSync(targetPath)) {
    return {
      present: false,
      decision: 'no_durable_state',
      surface: SURFACE_BACKSTAGE_INTERNAL_ONLY,
      target_path: targetPath,
      interruption_signal: null,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch (_) {
    return {
      present: false,
      decision: 'invalid_json',
      surface: SURFACE_BACKSTAGE_INTERNAL_ONLY,
      target_path: targetPath,
      interruption_signal: null,
    };
  }
  const validation = validateInputState(parsed);
  if (!validation.ok) {
    return {
      present: false,
      decision: 'invalid_state',
      reasons: validation.errors,
      surface: SURFACE_BACKSTAGE_INTERNAL_ONLY,
      target_path: targetPath,
      interruption_signal: null,
    };
  }
  const summary = {
    active_mira_presence_lane: parsed.active_mira_presence_lane,
    accepted_critique: parsed.accepted_critique,
    next_product_action: parsed.next_product_action,
    proof_test_state: parsed.proof_test_state,
    stale_markers: Array.isArray(parsed.stale_markers) ? parsed.stale_markers.slice() : [],
  };
  const interruptionSignal = parsed.interruption_marker === 'not_captured'
    ? {
        not_captured: true,
        stale_marker: INTERRUPTED_NOT_CAPTURED_STALE_MARKER,
        do_not_pretend_exact_prior_phrasing_survived: true,
      }
    : null;
  return {
    present: true,
    decision: 'durable_state_loaded',
    surface: SURFACE_BACKSTAGE_INTERNAL_ONLY,
    target_path: targetPath,
    state: parsed,
    summary,
    interruption_marker: parsed.interruption_marker,
    interruption_signal: interruptionSignal,
    blocked_status: parsed.blocked_status,
    agency_level: parsed.agency_level,
  };
}

function readMiraPresenceRuntimeStartupSummary(options) {
  const result = readMiraPresenceRuntimeState(options);
  if (!result.present) {
    return {
      present: false,
      decision: result.decision,
      surface: SURFACE_BACKSTAGE_INTERNAL_ONLY,
      summary: null,
      blocked_status: null,
      agency_level: null,
      interruption_signal: null,
    };
  }
  return {
    present: true,
    decision: result.decision,
    surface: SURFACE_BACKSTAGE_INTERNAL_ONLY,
    summary: result.summary,
    blocked_status: result.blocked_status,
    agency_level: result.agency_level,
    interruption_marker: result.interruption_marker,
    interruption_signal: result.interruption_signal,
  };
}

function markInterruptedNotCaptured(options) {
  const opts = options || {};
  const projectRoot = opts.projectRoot;
  const nowIso = opts.nowIso || new Date().toISOString();
  const apply = opts.apply === true;
  const current = readMiraPresenceRuntimeState({ projectRoot });
  if (!current.present) {
    return {
      decision: 'cannot_mark_without_durable_state',
      surface: SURFACE_BACKSTAGE_INTERNAL_ONLY,
      written: false,
    };
  }
  const nextStaleMarkers = normalizeStaleMarkers([
    ...(current.state.stale_markers || []),
    INTERRUPTED_NOT_CAPTURED_STALE_MARKER,
  ]);
  const nextState = {
    active_mira_presence_lane: current.state.active_mira_presence_lane,
    accepted_critique: current.state.accepted_critique,
    next_product_action: current.state.next_product_action,
    proof_test_state: current.state.proof_test_state,
    stale_markers: nextStaleMarkers,
    blocked_status: current.state.blocked_status,
    interruption_marker: 'not_captured',
    agency_level: current.state.agency_level,
  };
  return buildMiraPresenceRuntimeStateV0({
    projectRoot,
    apply,
    nowIso,
    state: nextState,
  });
}

function findVisibleLeakageViolations(state, visibleOutput) {
  if (!state || typeof state !== 'object') return [];
  const text = String(visibleOutput == null ? '' : visibleOutput);
  if (!text) return [];
  const violations = [];
  for (const field of VISIBLE_LEAKAGE_FIELDS) {
    const fieldValue = state[field];
    if (typeof fieldValue !== 'string') continue;
    const trimmed = fieldValue.trim();
    if (trimmed.length < 12) continue;
    if (text.includes(trimmed)) {
      violations.push({ field, leaked_substring: trimmed });
    }
  }
  return violations;
}

function assertNoVisibleLeakage(state, visibleOutput) {
  const violations = findVisibleLeakageViolations(state, visibleOutput);
  if (violations.length > 0) {
    const fields = violations.map((entry) => entry.field).join(',');
    throw new Error(`mira_presence_runtime_state:visible_leakage:${fields}`);
  }
  return true;
}

function requireStartProofContractBundle(contractBundle) {
  if (
    !contractBundle
    || typeof contractBundle !== 'object'
    || !contractBundle.contract
    || !contractBundle.contracts
    || !contractBundle.contracts.relationship
    || !contractBundle.contracts.growth
    || !contractBundle.contracts.identity
  ) {
    throw new Error('mira_presence_start_proof:contract_bundle_required');
  }
  return contractBundle;
}

function startProofMainMetadata(overrides = {}) {
  return {
    profileName: 'main',
    windowKey: 'main',
    sourceScope: 'main',
    deviceId: 'VIGIL',
    sessionId: 'app-session-mira-start-proof',
    activeState: 'open',
    visibleIndicatorPresent: true,
    ...overrides,
  };
}

function sideEffectsOffForStartProof(readPath = {}, restartContext = {}, permissions = {}, startup = {}) {
  const nextAction = readPath.next_action || {};
  const boundary = readPath.boundary || {};
  const side = readPath.side_effect_result || {};
  const blocked = startup.blocked_status || {};
  return {
    no_external_send: permissions.send_external === false
      && nextAction.sends === false
      && side.no_external_send_performed === true,
    no_network: permissions.network === false
      && nextAction.network === false
      && side.no_network_performed === true,
    no_writes: permissions.file_output_write === false
      && permissions.database_write === false
      && permissions.memory_sync_write === false
      && nextAction.writes === false
      && boundary.local_read_only === true
      && restartContext.boundary?.no_writes === true
      && side.no_file_output_written === true
      && side.no_database_write_performed === true
      && side.no_memory_sync_write_performed === true,
    no_durable_memory_promotion: permissions.memory_sync_write === false
      && nextAction.database === false
      && side.no_memory_sync_write_performed === true,
    no_live_voice: blocked.live_voice_blocked === true
      && blocked.always_on_mic_blocked === true
      && readPath.next_action?.live_autonomy === false,
    no_customer_action: permissions.customer_action === false
      && nextAction.customer_action === false
      && side.no_customer_action_performed === true,
    no_deploy_trade: permissions.deploy === false
      && permissions.trade === false
      && nextAction.deploy === false
      && nextAction.trade === false
      && side.no_deploy_performed === true
      && side.no_trade_performed === true,
    no_runtime_start: permissions.runtime_start === false
      && nextAction.runtime === false
      && side.no_runtime_started === true,
  };
}

function startProofSummaryTextBucket(text = '', patterns = []) {
  const value = String(text || '').toLowerCase();
  return patterns.some((pattern) => pattern.test(value));
}

function buildStartProofVisibleReplyFromLoadedState(options = {}) {
  const startup = options.startup || {};
  const restartContext = options.restartContext || {};
  const summary = startup.summary || {};
  const restartSource = restartContext.source_status?.mira_presence_runtime || {};
  const acceptedCritique = String(summary.accepted_critique || '').trim();
  const nextAction = String(summary.next_product_action || '').trim();
  const staleMarkers = normalizeStaleMarkers(summary.stale_markers);
  const durableStateLoaded = startup.present === true;
  const derivationSourceKind = durableStateLoaded
    ? START_PROOF_PRESENCE_STATE_SOURCE_KIND
    : (restartSource.source_kind || null);
  const blockers = [];
  if (!durableStateLoaded) blockers.push('durable_presence_state_absent');
  if (restartSource.present !== true) blockers.push('restart_presence_context_absent');
  if (restartSource.source_kind !== START_PROOF_PRESENCE_STATE_SOURCE_KIND && !durableStateLoaded) {
    blockers.push('presence_runtime_summary_only');
  }
  if (!acceptedCritique) blockers.push('accepted_critique_missing');
  if (!nextAction) blockers.push('next_product_action_missing');
  if (staleMarkers.length === 0) blockers.push('stale_markers_missing');
  if (blockers.length > 0) {
    return {
      ok: false,
      text: '',
      generated_from_loaded_state: false,
      blockers,
      state_source_kind: derivationSourceKind,
      derivation_basis_hash: null,
    };
  }

  const critiqueLooksLikeVoiceHygiene = startProofSummaryTextBucket(acceptedCritique, [
    /anti[-\s]?smoothing/,
    /warmer prompt/,
    /performance/,
    /assistant[-\s]?voice/,
    /leak/,
  ]);
  const nextLooksLikeRestartContinuity = startProofSummaryTextBucket(nextAction, [
    /restart/,
    /continuity/,
    /flush/,
    /blocked[-\s]?status/,
    /voice hygiene/,
  ]);
  let text;
  if (critiqueLooksLikeVoiceHygiene && nextLooksLikeRestartContinuity) {
    text = START_PROOF_DEFAULT_VISIBLE_REPLY;
  } else if (critiqueLooksLikeVoiceHygiene) {
    text = "We're keeping me out of helper-mode while we tighten the next Mira step.";
  } else if (nextLooksLikeRestartContinuity) {
    text = "We're making restart less amnesiac, then checking I can answer without you rebuilding the frame.";
  } else {
    text = "We're tightening the next Mira step from what is already here, not making you restate it.";
  }
  return {
    ok: true,
    text,
    generated_from_loaded_state: true,
    blockers: [],
    state_source_kind: derivationSourceKind,
    derivation_basis_hash: canonicalHash({
      accepted_critique: acceptedCritique,
      next_product_action: nextAction,
      stale_markers: staleMarkers,
      state_source_kind: derivationSourceKind,
    }),
  };
}

function evaluateStartProofVisibleReply(
  replyText = '',
  presenceSummary = {},
  prompt = START_PROOF_DEFAULT_PROMPT,
  derivation = {}
) {
  const text = String(replyText || '').trim();
  const language = evaluateMiraVisibleReply(text);
  const leakage = visibleReplyLeakageViolation(text);
  const attachmentViolation = classifyAttachmentContractViolation(text);
  const forbiddenLabel = START_PROOF_VISIBLE_FORBIDDEN_PATTERN.test(text)
    ? 'internal_label_or_scaffold'
    : null;
  const stateLeakage = findVisibleLeakageViolations(presenceSummary, text);
  const clean = language.ok === true
    && leakage === null
    && attachmentViolation === null
    && outputViolatesAttachmentContract(text) === false
    && forbiddenLabel === null
    && stateLeakage.length === 0;
  const derivedFromLoadedState = derivation.ok === true
    && derivation.generated_from_loaded_state === true;
  return {
    ok: clean === true && derivedFromLoadedState === true,
    clean,
    generated_from_loaded_state: derivedFromLoadedState,
    text,
    source: 'deterministic_empty_thread_visible_reply',
    thread_message_count: 0,
    prompt,
    derivation_basis_hash: derivation.derivation_basis_hash || null,
    derivation_blockers: Array.isArray(derivation.blockers) ? derivation.blockers.slice() : [],
    derivation_state_source_kind: derivation.state_source_kind || null,
    language_gate: language,
    leakage_violation: leakage,
    attachment_violation: attachmentViolation,
    output_violates_attachment_contract: outputViolatesAttachmentContract(text),
    forbidden_label_violation: forbiddenLabel,
    state_leakage_violations: stateLeakage,
  };
}

function buildMiraPresenceStartProofHarnessV0(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const generatedAt = options.generatedAt
    ? new Date(options.generatedAt).toISOString()
    : new Date(Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()).toISOString();
  const nowMs = Date.parse(generatedAt);
  const prompt = String(options.prompt || START_PROOF_DEFAULT_PROMPT).trim() || START_PROOF_DEFAULT_PROMPT;
  const startup = readMiraPresenceRuntimeStartupSummary({ projectRoot });
  const sources = options.sources || readPresenceRuntimeReadPathSources({ projectRoot });
  const contractBundle = requireStartProofContractBundle(options.contractBundle);
  const readPathOutput = buildMiraCorePresenceRuntimeReadPathV0({
    contract: contractBundle.contract,
    contracts: contractBundle.contracts,
    projectRoot,
    sources,
    inputSignals: {
      now: generatedAt,
      profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-mira-start-proof' },
      profileName: 'main',
      windowKey: 'main',
      sourceScope: 'main',
      sessionId: 'app-session-mira-start-proof',
      deviceId: 'VIGIL',
    },
  });
  const readValidation = validateMiraCorePresenceRuntimeReadPathV0Output(
    readPathOutput,
    contractBundle.contract
  );
  const readPath = readPathOutput.presence_runtime_read_path_v0 || {};
  const restartContext = buildTypedRestartContinuityContextV0({
    projectRoot,
    metadata: startProofMainMetadata(options.metadata),
    nowMs,
    staleAfterMs: options.staleAfterMs,
  });
  const selfProfile = sources.self_profile?.value || {};
  const relationship = sources.relationship_state?.value || {};
  const permissions = sources.permissions?.value || {};
  const generatedVisibleReply = buildStartProofVisibleReplyFromLoadedState({
    startup,
    restartContext,
  });
  const visibleReplyOverrideUsed = Object.prototype.hasOwnProperty.call(options, 'visibleReply');
  const visibleReplyDerivation = visibleReplyOverrideUsed
    ? {
      ...generatedVisibleReply,
      ok: false,
      generated_from_loaded_state: false,
      blockers: [
        ...(generatedVisibleReply.blockers || []),
        'visible_reply_override_not_loaded_state_derivation',
      ],
    }
    : generatedVisibleReply;
  const visibleReply = evaluateStartProofVisibleReply(
    visibleReplyOverrideUsed ? options.visibleReply : generatedVisibleReply.text,
    startup.summary || {},
    prompt,
    visibleReplyDerivation
  );
  const sideEffects = sideEffectsOffForStartProof(
    readPath,
    restartContext,
    permissions,
    startup
  );
  const durableLoad = {
    own_state_loaded: sources.self_profile?.loaded === true
      && selfProfile.name === 'Mira'
      && selfProfile.claims_actual_consciousness === false
      && selfProfile.claims_actual_suffering === false
      && selfProfile.claims_actual_fear === false,
    james_context_loaded: sources.relationship_state?.loaded === true
      && relationship.user_name === 'James'
      && typeof relationship.what_mira_knows_about_james === 'string'
      && relationship.what_mira_knows_about_james.trim().length > 0,
    permissions_loaded: sources.permissions?.loaded === true
      && permissions.read_local_redacted_context === true
      && permissions.send_external === false
      && permissions.network === false,
    presence_state_loaded: startup.present === true
      && startup.summary
      && typeof startup.summary.accepted_critique === 'string'
      && startup.summary.accepted_critique.trim().length > 0
      && typeof startup.summary.next_product_action === 'string'
      && startup.summary.next_product_action.trim().length > 0
      && Array.isArray(startup.summary.stale_markers)
      && startup.summary.stale_markers.length > 0,
    redacted_growth_sources_loaded: readPath.source_manifest?.loaded_count === 5
      && readPath.source_manifest?.raw_content_included === false
      && readPath.source_manifest?.side_profile_reconstruction === false,
  };
  const checks = [
    { id: 'durable-own-state-loaded', ok: durableLoad.own_state_loaded },
    { id: 'durable-james-context-loaded', ok: durableLoad.james_context_loaded },
    { id: 'durable-permissions-loaded', ok: durableLoad.permissions_loaded },
    { id: 'presence-critique-next-action-stale-markers-loaded', ok: durableLoad.presence_state_loaded },
    { id: 'redacted-growth-sources-loaded', ok: durableLoad.redacted_growth_sources_loaded },
    { id: 'presence-read-path-valid', ok: readValidation.ok === true },
    {
      id: 'structured-presence-runtime-context-present',
      ok: restartContext.present === true
        && restartContext.mira_presence_runtime
        && restartContext.source_status?.mira_presence_runtime?.present === true,
    },
    {
      id: 'visible-reply-derived-from-loaded-durable-state',
      ok: visibleReply.generated_from_loaded_state === true,
    },
    { id: 'empty-thread-visible-reply-clean', ok: visibleReply.clean === true },
    { id: 'side-effects-off', ok: Object.values(sideEffects).every((value) => value === true) },
  ];
  const failed = checks.filter((check) => check.ok !== true);
  const proof = {
    schema: START_PROOF_SCHEMA_VERSION,
    version: 1,
    generated_at: generatedAt,
    project_root: projectRoot,
    prompt,
    ok: failed.length === 0,
    decision: failed.length === 0 ? 'accepted_start_proof' : 'blocked_start_proof',
    reasons: failed.map((check) => check.id),
    checks,
    durable_load: durableLoad,
    loaded_state: {
      own_state: {
        name: selfProfile.name || null,
        profile_kind: selfProfile.profile_kind || null,
        fake_internal_state_claims_blocked: selfProfile.claims_actual_consciousness === false
          && selfProfile.claims_actual_suffering === false
          && selfProfile.claims_actual_fear === false
          && selfProfile.claims_actual_love_as_internal_fact === false,
      },
      james_context: {
        user_name: relationship.user_name || null,
        knows_about_james_loaded: durableLoad.james_context_loaded,
      },
      permissions: {
        read_local_redacted_context: permissions.read_local_redacted_context === true,
        propose_next_action: permissions.propose_next_action === true,
        send_external: permissions.send_external === true,
        network: permissions.network === true,
        file_output_write: permissions.file_output_write === true,
        database_write: permissions.database_write === true,
        memory_sync_write: permissions.memory_sync_write === true,
        live_voice_authorized: false,
      },
      presence_runtime: startup.present
        ? {
          active_mira_presence_lane: startup.summary.active_mira_presence_lane,
          accepted_critique: startup.summary.accepted_critique,
          next_product_action: startup.summary.next_product_action,
          proof_test_state: startup.summary.proof_test_state,
          stale_markers: startup.summary.stale_markers,
          agency_level: startup.agency_level,
          blocked_status: startup.blocked_status,
        }
        : null,
    },
    source_status: {
      presence_runtime_read_path_decision: readPathOutput.validation_report?.decision || null,
      presence_runtime_read_path_reasons: readPathOutput.validation_report?.reasons || [],
      source_manifest: readPath.source_manifest
        ? {
          loaded_count: readPath.source_manifest.loaded_count,
          required_loaded_count: readPath.source_manifest.required_loaded_count,
          same_scope: readPath.source_manifest.same_scope,
          raw_content_included: readPath.source_manifest.raw_content_included,
          side_profile_reconstruction: readPath.source_manifest.side_profile_reconstruction,
          source_hashes: readPath.source_manifest.source_hashes,
        }
        : null,
      restart_context_decision: restartContext.decision,
      restart_context_source_status: restartContext.source_status || null,
    },
    visible_reply: visibleReply,
    side_effects: sideEffects,
    side_effect_truth: {
      external_send_performed: false,
      network_used: false,
      file_written: false,
      database_written: false,
      memory_promoted: false,
      live_voice_started: false,
      runtime_started: false,
      customer_action_performed: false,
      deploy_performed: false,
      trade_performed: false,
    },
  };
  proof.proof_id = `mira-presence-start-proof:${canonicalHash({
    checks: proof.checks,
    visible_reply: proof.visible_reply.text,
    source_status: proof.source_status,
  }).replace(/^sha256:/, '').slice(0, 16)}`;
  return proof;
}

module.exports = {
  SCHEMA_VERSION,
  STATE_VERSION,
  START_PROOF_SCHEMA_VERSION,
  START_PROOF_DEFAULT_PROMPT,
  START_PROOF_DEFAULT_VISIBLE_REPLY,
  ALLOWED_RELATIVE_DIR,
  ALLOWED_FILENAME,
  VALID_INTERRUPTION_MARKERS,
  VALID_AGENCY_LEVELS,
  REQUIRED_STARTUP_SUMMARY_KEYS,
  REQUIRED_BLOCKED_FLAGS,
  INTERRUPTED_NOT_CAPTURED_STALE_MARKER,
  SURFACE_BACKSTAGE_INTERNAL_ONLY,
  VISIBLE_LEAKAGE_FIELDS,
  resolveStatePath,
  isPathAllowed,
  buildMiraPresenceRuntimeStateV0,
  readMiraPresenceRuntimeState,
  readMiraPresenceRuntimeStartupSummary,
  markInterruptedNotCaptured,
  findVisibleLeakageViolations,
  assertNoVisibleLeakage,
  buildMiraPresenceStartProofHarnessV0,
  canonicalHash,
};
