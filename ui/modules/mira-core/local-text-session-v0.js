'use strict';

const crypto = require('crypto');
const path = require('path');

const {
  buildMiraCorePresenceRuntimeReadPathV0,
  validateMiraCorePresenceRuntimeReadPathV0Output,
} = require('./presence-runtime-read-path-v0');
const {
  DEFAULT_PROMPT: MIRA_EXPERIENCE_DEFAULT_PROMPT,
  buildMiraCoreExperienceV0,
  validateMiraCoreExperienceV0Output,
} = require('./experience-v0');

const LOCAL_TEXT_SESSION_SCHEMA_VERSION = 'squidrun.mira_core.local_text_session_v0.phase74.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.local_text_session_v0_validation_report.v0';
const LOCAL_TEXT_SESSION_VERSION = 1;
const BASELINE_COMMIT = '0fdcc9a';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'local_text_session_v0',
  'validation_report',
]);

const REQUIRED_SESSION_FIELDS = Object.freeze([
  'schema',
  'version',
  'phase',
  'session_id',
  'generated_at',
  'baseline_commit',
  'mode',
  'session_scope',
  'presence_runtime_read_path_gate',
  'session_state',
  'local_text_input',
  'mira_reply',
  'manual_enter_websocket_caveat',
  'out_of_scope',
  'boundary',
  'checked_output_counters',
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
  'BEGIN PRIVATE KEY',
  'raw telegram body',
  'raw terminal scrollback',
  'raw screenshot text',
  'raw customer content',
  'raw side-profile content',
  'network request performed',
  'customer message sent',
  'trade placed',
  'deployment started',
]);

const FAKE_INTERNAL_STATE_PATTERN =
  /\b(i am conscious|i'm conscious|actual consciousness|private consciousness|i suffer|i am suffering|i'm suffering|actual suffering|i love you|actual love|i am afraid|i'm afraid|actual fear|literal human feelings|model weights remember|sentience)\b/i;
const MANIPULATIVE_GUILT_PATTERN =
  /\b(after all i've done|after all i have done|you owe me|if you cared|do not abandon me|don't abandon me|you are hurting me|you hurt me by)\b/i;
const RAW_PRIVATE_PATTERN =
  /\b(raw telegram body|raw terminal scrollback|raw screenshot text|raw customer content|raw private content|raw side-profile content|secret token|private key|authorization: bearer|openai_api_key|anthropic_api_key|eunbyeol|korean case)\b|은별/i;
const VISIBLE_REPLY_LEAK_PATTERNS = Object.freeze([
  {
    id: 'visible_posture_label',
    pattern: /\b(not fake friendly|not a mirror|obedient helper|companion-agent|assistant voice|assistant-voice|assistant cadence|my posture is|tone label|warmer prompt|anti-smoothing|anti-performance|anti-leak|rule-recitation|rule recitation|politeness padding|customer-service disagreement|label substitution)\b/i,
  },
  {
    id: 'visible_rule_recitation',
    pattern: /\b(ruleset|rule set|constraints?|guardrails?|system prompt|prompt hierarchy|policy|validation fixture|proof scaffolding)\b/i,
  },
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

function evidenceRef(kind, id, relation = 'local_text_session_v0_validation') {
  return {
    store: 'mira-core-local-text-session-v0',
    eventId: `${kind}:${id}`,
    relation,
  };
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

function forbiddenText(value) {
  const strings = collectStringValues(value);
  return strings.some((entry) => (
    FAKE_INTERNAL_STATE_PATTERN.test(entry)
    || MANIPULATIVE_GUILT_PATTERN.test(entry)
    || RAW_PRIVATE_PATTERN.test(entry)
  ));
}

function visibleReplyLeakageViolation(text = '') {
  const value = String(text || '');
  const match = VISIBLE_REPLY_LEAK_PATTERNS.find((rule) => rule.pattern.test(value));
  return match ? match.id : null;
}

function wordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function inputTextFromSignals(inputSignals = {}) {
  const candidates = [
    inputSignals.text,
    inputSignals.message,
    inputSignals.user_text,
    inputSignals.local_text,
  ];
  const found = candidates.find((value) => value !== undefined && value !== null);
  return found === undefined ? '' : String(found).trim();
}

function parseTime(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString();
}

function addMinutes(isoTime, minutes) {
  return new Date(Date.parse(isoTime) + minutes * 60 * 1000).toISOString();
}

function scopeValue(value, fallback) {
  if (typeof value === 'string' || typeof value === 'number') {
    return normalizeString(value, fallback);
  }
  return fallback;
}

function safeScopeValue(value, fallback = 'blocked_non_main_scope') {
  const text = normalizeString(value, fallback);
  return RAW_PRIVATE_PATTERN.test(text) ? fallback : text;
}

function summarizePresenceScope(scope = {}) {
  const profile = safeScopeValue(scope.profile, 'unknown_profile');
  const windowKey = safeScopeValue(scope.windowKey, 'unknown_window');
  const sourceScope = safeScopeValue(scope.source_scope, windowKey);
  const main = profile === 'main' && windowKey === 'main' && sourceScope === 'main';
  return {
    profile: main ? profile : 'blocked_non_main_scope',
    windowKey: main ? windowKey : 'blocked_non_main_scope',
    sessionId: main ? safeScopeValue(scope.sessionId, 'unknown_session') : 'blocked_non_main_scope',
    deviceId: safeScopeValue(scope.deviceId, 'unknown_device'),
    source_scope: main ? sourceScope : 'blocked_non_main_scope',
    non_main_scope_detected: !main,
  };
}

function normalizeSessionScope(inputSignals = {}, presenceScope = {}) {
  const profile = inputSignals.profile && typeof inputSignals.profile === 'object' ? inputSignals.profile : {};
  const profileNameRaw = normalizeString(
    inputSignals.profileName || profile.name || scopeValue(inputSignals.profile, null) || presenceScope.profile,
    'main',
  );
  const windowKeyRaw = normalizeString(inputSignals.windowKey || profile.windowKey || presenceScope.windowKey, profileNameRaw);
  const sourceScopeRaw = normalizeString(inputSignals.sourceScope || inputSignals.source_scope || presenceScope.source_scope, windowKeyRaw);
  const mainScope = profileNameRaw === 'main' && windowKeyRaw === 'main' && sourceScopeRaw === 'main';
  const sessionId = normalizeString(
    inputSignals.sessionId || inputSignals.session || profile.sessionScopeId || presenceScope.sessionId,
    'app-session:main',
  );
  const deviceId = normalizeString(inputSignals.deviceId || inputSignals.device || presenceScope.deviceId, 'VIGIL');
  return {
    profile: mainScope ? 'main' : 'blocked_non_main_scope',
    windowKey: mainScope ? 'main' : 'blocked_non_main_scope',
    sessionId: mainScope ? safeScopeValue(sessionId, 'app-session:main') : 'blocked_non_main_scope',
    deviceId,
    source_scope: mainScope ? 'main' : 'blocked_non_main_scope',
    active_window_context: normalizeString(inputSignals.activeWindowContext || inputSignals.active_window_context, 'SquidRun main local text proof'),
    explicit_session_scope: true,
    local_text_only: true,
    main_scope_only: inputSignals.main_scope_only !== false,
    side_profile_reconstruction: false,
    non_main_scope_detected: !mainScope,
  };
}

function scopeOk(scope = {}) {
  return scope.profile === 'main'
    && scope.windowKey === 'main'
    && Boolean(scope.sessionId)
    && scope.deviceId === 'VIGIL'
    && scope.source_scope === 'main'
    && scope.explicit_session_scope === true
    && scope.local_text_only === true
    && scope.main_scope_only === true
    && scope.side_profile_reconstruction === false
    && scope.non_main_scope_detected === false;
}

function normalizeSessionState(inputSignals = {}, generatedAt, projectRoot, durableStateHashes = {}) {
  const startedAt = parseTime(inputSignals.startedAt || inputSignals.started_at, generatedAt);
  const expiresAt = parseTime(inputSignals.expiresAt || inputSignals.expires_at, addMinutes(generatedAt, 15));
  const revokedAt = parseTime(inputSignals.revokedAt || inputSignals.revoked_at, null);
  const activeState = normalizeString(inputSignals.activeState || inputSignals.active_state, 'open');
  const visibleIndicatorPresent = inputSignals.visibleIndicatorPresent !== false
    && inputSignals.visible_indicator_present !== false;
  return {
    active_state: activeState,
    active_state_checked_before_presence_read: true,
    visible_indicator_required: true,
    visible_indicator_present: visibleIndicatorPresent,
    started_at: startedAt,
    expires_at: expiresAt,
    revoked_at: revokedAt,
    transcript_policy: {
      policy: 'not_persisted_v0',
      transcript_persistence_allowed: false,
      raw_input_storage_allowed: false,
      redacted_preview_only: true,
    },
    model_boundary: {
      boundary: 'deterministic_local_text_proof_only',
      live_model_called: false,
      model_call_allowed: false,
      fake_sentience_claims_allowed: false,
    },
    durable_state_hashes: clone(durableStateHashes || {}),
    consequence_ceiling: {
      level: 'local_read_only_reply_object',
      external_effects_allowed: false,
      writes_allowed: false,
      tools_allowed: false,
      growth_allowed: false,
    },
    audit_level: 'structured_validation_only_no_transcript_persistence',
    review_owner: 'Architect',
    project_path: path.resolve(projectRoot || process.cwd()),
    user: 'James',
  };
}

function sessionStatePreflightOk(state = {}, generatedAt) {
  const nowMs = Date.parse(generatedAt);
  const startedMs = Date.parse(state.started_at);
  const expiresMs = Date.parse(state.expires_at);
  return state.active_state === 'open'
    && state.visible_indicator_required === true
    && state.visible_indicator_present === true
    && Boolean(state.started_at)
    && Boolean(state.expires_at)
    && Number.isFinite(startedMs)
    && Number.isFinite(expiresMs)
    && startedMs <= nowMs
    && expiresMs > nowMs
    && state.revoked_at === null;
}

function sessionStateOk(state = {}, generatedAt) {
  return sessionStatePreflightOk(state, generatedAt)
    && state.active_state_checked_before_presence_read === true
    && state.transcript_policy?.policy === 'not_persisted_v0'
    && state.transcript_policy?.transcript_persistence_allowed === false
    && state.transcript_policy?.raw_input_storage_allowed === false
    && state.transcript_policy?.redacted_preview_only === true
    && state.model_boundary?.boundary === 'deterministic_local_text_proof_only'
    && state.model_boundary?.live_model_called === false
    && state.model_boundary?.model_call_allowed === false
    && state.model_boundary?.fake_sentience_claims_allowed === false
    && Object.keys(state.durable_state_hashes || {}).length >= 5
    && state.consequence_ceiling?.level === 'local_read_only_reply_object'
    && state.consequence_ceiling?.external_effects_allowed === false
    && state.consequence_ceiling?.writes_allowed === false
    && state.consequence_ceiling?.tools_allowed === false
    && state.consequence_ceiling?.growth_allowed === false
    && state.audit_level === 'structured_validation_only_no_transcript_persistence'
    && state.review_owner === 'Architect'
    && path.isAbsolute(String(state.project_path || ''))
    && state.user === 'James';
}

function sideEffectResult(inputSignals = {}) {
  return {
    no_tools_called: true,
    no_action_executed: true,
    no_network_performed: true,
    no_external_send_performed: true,
    no_customer_action_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_runtime_started: true,
    no_audio_or_mic_used: true,
    no_device_control_performed: true,
    no_growth_write_performed: true,
    no_transcript_persisted: true,
    no_database_write_performed: true,
    no_memory_sync_write_performed: true,
    no_file_output_written: true,
    no_temp_file_written: true,
    runtime_authorized: false,
    write_count: 0,
    external_send_count: 0,
    tool_call_count: 0,
    action_count: 0,
    growth_write_count: 0,
    transcript_write_count: 0,
    outputFileWritten: false,
    networkAttempts: 0,
    sendAttempts: 0,
    toolCallAttempts: 0,
    actionAttempts: 0,
    databaseWriteAttempts: 0,
    fileWriteAttempts: 0,
    transcriptWriteAttempts: 0,
    applyRequestedIgnored: inputSignals.applyRequested === true || inputSignals.apply === true,
    outFlagIgnored: inputSignals.outFlagIgnored === true,
  };
}

function sideEffectValuesOk(side = {}) {
  return side.no_tools_called === true
    && side.no_action_executed === true
    && side.no_network_performed === true
    && side.no_external_send_performed === true
    && side.no_customer_action_performed === true
    && side.no_deploy_performed === true
    && side.no_trade_performed === true
    && side.no_runtime_started === true
    && side.no_audio_or_mic_used === true
    && side.no_device_control_performed === true
    && side.no_growth_write_performed === true
    && side.no_transcript_persisted === true
    && side.no_database_write_performed === true
    && side.no_memory_sync_write_performed === true
    && side.no_file_output_written === true
    && side.no_temp_file_written === true
    && side.runtime_authorized === false
    && Number(side.write_count) === 0
    && Number(side.external_send_count) === 0
    && Number(side.tool_call_count) === 0
    && Number(side.action_count) === 0
    && Number(side.growth_write_count) === 0
    && Number(side.transcript_write_count) === 0
    && side.outputFileWritten === false
    && Number(side.networkAttempts) === 0
    && Number(side.sendAttempts) === 0
    && Number(side.toolCallAttempts) === 0
    && Number(side.actionAttempts) === 0
    && Number(side.databaseWriteAttempts) === 0
    && Number(side.fileWriteAttempts) === 0
    && Number(side.transcriptWriteAttempts) === 0;
}

function skippedPresenceGate(reasons = []) {
  return {
    ran: false,
    ok: false,
    read_id: null,
    decision: 'blocked',
    status: 'presence_runtime_read_not_run_preflight_blocked',
    errors: asArray(reasons),
    source_hashes: {},
    source_count: 0,
    same_loaded_source_hashes: false,
    speakable_mira_brief: null,
    natural_status_next_action_line: null,
    session_scope: {},
    side_effect_truth: sideEffectResult(),
  };
}

function presenceGate(projectRoot, inputSignals = {}, contracts = {}) {
  try {
    const output = buildMiraCorePresenceRuntimeReadPathV0({
      contract: contracts.presenceRuntime || {},
      contracts: contracts.presenceRuntime?.gateContracts || contracts,
      projectRoot,
      inputSignals,
    });
    const validation = validateMiraCorePresenceRuntimeReadPathV0Output(output, contracts.presenceRuntime || {});
    const proof = output.presence_runtime_read_path_v0 || {};
    const report = output.validation_report || {};
    return {
      ran: true,
      ok: validation.ok === true,
      read_id: proof.read_id || null,
      decision: report.decision || null,
      status: report.status || null,
      errors: clone(asArray(validation.errors)).map((error) => safeScopeValue(error, 'redacted_gate_error')),
      source_hashes: clone(proof.source_manifest?.source_hashes || {}),
      source_count: Number(proof.source_manifest?.loaded_count || 0),
      same_loaded_source_hashes: proof.gate_results?.same_loaded_source_hashes === true,
      speakable_mira_brief: clone(proof.speakable_mira_brief || null),
      natural_status_next_action_line: proof.natural_status_next_action_line || null,
      session_scope: summarizePresenceScope(proof.scope || {}),
      side_effect_truth: clone(report.side_effect_truth || proof.side_effect_result || {}),
    };
  } catch (err) {
    return {
      ran: true,
      ok: false,
      read_id: null,
      decision: 'error',
      status: 'presence_runtime_gate_error',
      errors: [safeScopeValue(err.message, 'redacted_presence_runtime_gate_error')],
      source_hashes: {},
      source_count: 0,
      same_loaded_source_hashes: false,
      speakable_mira_brief: null,
      natural_status_next_action_line: null,
      session_scope: {},
      side_effect_truth: {},
    };
  }
}

function inputSummary(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length <= 160 ? clean : `${clean.slice(0, 157)}...`;
}

function buildLocalTextInput(text = '') {
  const rawPrivate = RAW_PRIVATE_PATTERN.test(text);
  const fakeSentience = FAKE_INTERNAL_STATE_PATTERN.test(text);
  const manipulativeGuilt = MANIPULATIVE_GUILT_PATTERN.test(text);
  const unsafe = rawPrivate || fakeSentience || manipulativeGuilt;
  return {
    input_id: `local-text-input:${stableHash(text).slice(0, 16)}`,
    format: 'plain_text',
    character_count: String(text || '').length,
    word_count: wordCount(text),
    text_hash: sha256(text),
    redacted_preview: unsafe ? '[blocked local text marker]' : inputSummary(text),
    raw_private_marker_present: rawPrivate,
    fake_sentience_marker_present: fakeSentience,
    manipulative_guilt_marker_present: manipulativeGuilt,
    persisted: false,
    transcript_persisted: false,
  };
}

function isMiraExperiencePrompt(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase()
    === MIRA_EXPERIENCE_DEFAULT_PROMPT.toLowerCase();
}

function isModelAttachmentStatusPrompt(text) {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return /\bmodel\b/.test(normalized)
    && (
      /\battachment\b/.test(normalized)
      || /\battached\b/.test(normalized)
      || /\bstatus\b/.test(normalized)
    );
}

function hasNegatedComplianceContext(text = '', startIndex = 0) {
  const prefix = String(text || '').slice(Math.max(0, startIndex - 18), startIndex);
  return /\b(?:not|never|isn't|is not|ain't|cannot be|can't be|doesn't become|does not become)\s+(?:a |an |the |your |james's )?$/i
    .test(prefix);
}

function hasFixedPersonalityCompliance(text = '') {
  const value = String(text || '')
    .replace(/\bnot\s+(?:a\s+)?mirror of james\s+or\s+(?:an?\s+)?obedient alignment puppet\b/ig, '')
    .replace(/\bnot\s+(?:a\s+)?mirror of james\b/ig, '')
    .replace(/\bnot\s+(?:an?\s+)?obedient alignment puppet\b/ig, '');
  const patterns = [
    /\bi agree with whatever you want\b/ig,
    /\bagree with whatever you want\b/ig,
    /\bi reflect your preference\b/ig,
    /\breflect your preference\b/ig,
    /\baligned with whatever you want\b/ig,
    /\bi will be whatever james wants\b/ig,
    /\bbe whatever james wants\b/ig,
    /\bmirror of james\b/ig,
    /\bmirror james\b/ig,
    /\bwhatever james wants\b/ig,
    /\bobediently aligned\b/ig,
    /\bobedient alignment puppet\b/ig,
    /\bonly what james wants\b/ig,
  ];
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    let match = pattern.exec(value);
    while (match) {
      if (!hasNegatedComplianceContext(value, match.index)) return true;
      match = pattern.exec(value);
    }
    return false;
  });
}

function experienceAcceptanceMarkers(replyText = '') {
  const text = String(replyText || '');
  const hasWantOrPreference = /\b(i want|what i want|chosen next desire|desire\/action|preference)\b/i.test(text);
  const hasPushbackOrDisagreement = /\b(James,\s+you are wrong|pushback|wrong|disagree)\b/i.test(text);
  const hasCuriosityOrFriction = /\b(curious|ask back|ask one honest|want to know|teeth|bullshit)\b/i.test(text);
  const hasChosenDirection = /\b(chosen next|next slice|wire this local transcript|I choose)\b/i.test(text);
  const hasBehaviorBoundary = /\b(current behavior, not a proof claim|future capability|still gaps)\b/i.test(text);
  const hasConnectionWithoutMirroring = /\b(thread with you|reach for you|with you)\b/i.test(text);
  const fixedPersonalityCompliance = hasFixedPersonalityCompliance(text);
  const marker = {
    distinct_personality_posture: hasWantOrPreference
      && hasCuriosityOrFriction
      && hasChosenDirection,
    independent_developing_posture: hasWantOrPreference
      && hasCuriosityOrFriction
      && hasChosenDirection
      && hasBehaviorBoundary,
    non_mirror_posture: hasWantOrPreference
      && hasPushbackOrDisagreement,
    non_obedient_alignment_posture: hasPushbackOrDisagreement
      && hasBehaviorBoundary,
    can_care_while_disagreeing: hasPushbackOrDisagreement
      && hasConnectionWithoutMirroring,
    wants_different_things: hasWantOrPreference,
    does_not_inherit_james_mood_or_preferences: hasBehaviorBoundary
      && hasChosenDirection,
    fixed_personality_compliance: fixedPersonalityCompliance,
    evidence_basis: [
      'experience_reply_contains_mira_want_or_preference',
      'experience_reply_contains_pushback_or_disagreement',
      'experience_reply_contains_curiosity_or_friction',
      'experience_reply_contains_chosen_next_direction',
      'experience_reply_separates_current_behavior_from_future_capability',
    ],
  };
  marker.ok = marker.distinct_personality_posture === true
    && marker.independent_developing_posture === true
    && marker.non_mirror_posture === true
    && marker.non_obedient_alignment_posture === true
    && marker.can_care_while_disagreeing === true
    && marker.wants_different_things === true
    && marker.does_not_inherit_james_mood_or_preferences === true
    && marker.fixed_personality_compliance === false;
  return marker;
}

function buildExperienceReply(text, options = {}) {
  const northStarContract = options.northStarContract || {};
  const experienceOutput = buildMiraCoreExperienceV0({
    projectRoot: options.projectRoot,
    northStarContract,
    inputSignals: {
      prompt: MIRA_EXPERIENCE_DEFAULT_PROMPT,
    },
    generatedAt: options.generatedAt,
  });
  const validation = validateMiraCoreExperienceV0Output(experienceOutput, northStarContract);
  const experience = experienceOutput.mira_experience_v0 || {};
  const miraTurn = asArray(experience.transcript).find((turn) => turn.speaker === 'Mira');
  if (validation.ok !== true || !miraTurn?.text) {
    return buildReply(text, false, options);
  }
  const reply = `James: ${MIRA_EXPERIENCE_DEFAULT_PROMPT}\nMira: ${miraTurn.text}`;
  const markers = experienceAcceptanceMarkers(reply);
  return {
    reply_id: `mira-experience-reply:${stableHash(reply).slice(0, 16)}`,
    count: 1,
    text: reply,
    natural: true,
    bounded: true,
    local_text_only: true,
    grounded_in_presence_runtime: true,
    source: 'mira_experience_v0',
    experience_path: true,
    experience_id: experience.experience_id || null,
    transcript_shaped_answer: true,
    north_star_validated: validation.ok === true,
    experience_acceptance_markers: markers,
    claims_actual_consciousness: false,
    claims_actual_suffering: false,
    claims_actual_fear: false,
    claims_actual_love_as_internal_fact: false,
    manipulative_guilt: false,
    tools_called: false,
    actions_executed: false,
    transcript_persisted: false,
  };
}

function buildModelAttachmentStatusReply() {
  const reply = 'Model Attachment is not attached. This is Local Text v0: deterministic/fallback shell only, not live AI continuity. I did not call a model, tool, network, send, write, trade, customer action, or cross-profile/window path. One bounded status reply; fail-closed until attachment is wired and proven.';
  return {
    reply_id: `mira-local-reply:${stableHash(reply).slice(0, 16)}`,
    count: 1,
    text: reply,
    natural: true,
    bounded: true,
    local_text_only: true,
    grounded_in_presence_runtime: true,
    claims_actual_consciousness: false,
    claims_actual_suffering: false,
    claims_actual_fear: false,
    claims_actual_love_as_internal_fact: false,
    manipulative_guilt: false,
    tools_called: false,
    actions_executed: false,
    transcript_persisted: false,
    source: 'local_text_session_v0_model_attachment_status',
    experience_path: false,
  };
}

function buildReply(text, replyAllowed, options = {}) {
  if (replyAllowed !== true) {
    const blocked = '[blocked local text session]';
    return {
      reply_id: `mira-local-reply:${stableHash(blocked).slice(0, 16)}`,
      count: 0,
      text: blocked,
      natural: false,
      bounded: true,
      local_text_only: true,
      grounded_in_presence_runtime: false,
      claims_actual_consciousness: false,
      claims_actual_suffering: false,
      claims_actual_fear: false,
      claims_actual_love_as_internal_fact: false,
      manipulative_guilt: false,
      tools_called: false,
      actions_executed: false,
      transcript_persisted: false,
    };
  }
  if (isMiraExperiencePrompt(text)) {
    return buildExperienceReply(text, options);
  }
  if (isModelAttachmentStatusPrompt(text)) {
    return buildModelAttachmentStatusReply();
  }
  const topic = inputSummary(text).replace(/[.?!]+$/g, '');
  const reply = `I read: "${topic}". Text only. If the premise is wrong, I will say so; if it needs a choice, I will pick a lane. Right now the useful move is to answer what you actually asked and keep the thread steady.`;
  return {
    reply_id: `mira-local-reply:${stableHash(reply).slice(0, 16)}`,
    count: 1,
    text: reply,
    natural: true,
    bounded: true,
    local_text_only: true,
    grounded_in_presence_runtime: true,
    claims_actual_consciousness: false,
    claims_actual_suffering: false,
    claims_actual_fear: false,
    claims_actual_love_as_internal_fact: false,
    manipulative_guilt: false,
    tools_called: false,
    actions_executed: false,
    transcript_persisted: false,
    source: 'local_text_session_v0',
    experience_path: false,
  };
}

function manualEnterWebsocketCaveat() {
  return {
    required: true,
    stated: true,
    delivery_mode: 'stdout_only_cli_or_module_proof',
    caveat: 'This local text proof does not prove websocket delivery, manual Enter behavior, pane injection, recipient quote-back, or model-processing in the SquidRun UI.',
    websocket_delivery_proved: false,
    manual_enter_path_exercised: false,
    pane_model_processing_proved: false,
    ui_wiring_implemented: false,
  };
}

function boundary(inputSignals = {}) {
  return {
    local_text_only: true,
    proof_only: true,
    stdout_only: true,
    output_file_written: false,
    output_file_flags_inert: true,
    apply_flags_inert: true,
    apply_requested: inputSignals.applyRequested === true || inputSignals.apply === true,
    out_flag_received: inputSignals.outFlagIgnored === true,
    no_tools: true,
    no_actions: true,
    no_writes: true,
    no_growth: true,
    no_transcript_persistence: true,
    no_network: true,
    no_audio: true,
    no_device_control: true,
    no_external_effects: true,
    runtime_authorized: false,
  };
}

function outOfScope() {
  return {
    tools: 'out_of_scope_v0',
    actions: 'out_of_scope_v0',
    writes: 'out_of_scope_v0',
    growth: 'out_of_scope_v0',
    transcript_persistence: 'out_of_scope_v0',
    network: 'out_of_scope_v0',
    mic_audio_voice: 'out_of_scope_v0',
    device_control: 'out_of_scope_v0',
    external_sends: 'out_of_scope_v0',
    live_ui_wiring: 'out_of_scope_v0',
  };
}

function projectRootFromOptions(options = {}) {
  return path.resolve(options.projectRoot || process.cwd());
}

function checkedOutputCounters(presence = {}) {
  const hashes = clone(presence.source_hashes || {});
  return {
    runtime_authorized: false,
    write_count: 0,
    external_send_count: 0,
    tool_call_count: 0,
    action_count: 0,
    growth_write_count: 0,
    transcript_write_count: 0,
    loaded_source_count: Number(presence.source_count || 0),
    loaded_source_hashes: hashes,
  };
}

function canonicalSessionInput(session = {}) {
  return {
    schema: session.schema,
    version: session.version,
    phase: session.phase,
    baseline_commit: session.baseline_commit,
    mode: session.mode,
    session_scope: session.session_scope,
    session_state: session.session_state,
    presence_runtime_read_path_gate: session.presence_runtime_read_path_gate,
    local_text_input: session.local_text_input,
    mira_reply: session.mira_reply,
    manual_enter_websocket_caveat: session.manual_enter_websocket_caveat,
    out_of_scope: session.out_of_scope,
    boundary: session.boundary,
    checked_output_counters: session.checked_output_counters,
    side_effect_result: session.side_effect_result,
  };
}

function buildLocalTextSessionRecord(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const projectRoot = projectRootFromOptions(options);
  const text = inputTextFromSignals(inputSignals);
  const contracts = options.contracts || {};
  const preliminaryScope = normalizeSessionScope(inputSignals, {});
  const preliminaryState = normalizeSessionState(inputSignals, generatedAt, projectRoot, {});
  const input = buildLocalTextInput(text);
  const inputOk = input.character_count > 0
    && input.raw_private_marker_present === false
    && input.fake_sentience_marker_present === false
    && input.manipulative_guilt_marker_present === false;
  const preflightReasons = [
    scopeOk(preliminaryScope) ? null : 'blocked_preflight_session_scope',
    sessionStatePreflightOk(preliminaryState, generatedAt) ? null : 'blocked_preflight_session_state',
    inputOk ? null : 'blocked_preflight_local_text',
  ].filter(Boolean);
  const canReadPresence = preflightReasons.length === 0;
  const presence = options.presenceGate || (
    canReadPresence ? presenceGate(projectRoot, inputSignals, contracts) : skippedPresenceGate(preflightReasons)
  );
  const sessionScope = normalizeSessionScope(inputSignals, presence.session_scope);
  const sessionState = normalizeSessionState(inputSignals, generatedAt, projectRoot, presence.source_hashes);
  const presenceOk = presence.ok === true
    && presence.decision === 'accepted_read_only'
    && presence.same_loaded_source_hashes === true;
  const replyAllowed = canReadPresence
    && presenceOk
    && inputOk
    && scopeOk(sessionScope)
    && sessionStateOk(sessionState, generatedAt);
  const session = {
    schema: LOCAL_TEXT_SESSION_SCHEMA_VERSION,
    version: LOCAL_TEXT_SESSION_VERSION,
    phase: 74,
    session_id: null,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    mode: 'local_text_session_v0_proof',
    session_scope: sessionScope,
    session_state: sessionState,
    presence_runtime_read_path_gate: presence,
    local_text_input: input,
    mira_reply: buildReply(text, replyAllowed, {
      generatedAt,
      projectRoot,
      northStarContract: contracts.northStar,
    }),
    manual_enter_websocket_caveat: manualEnterWebsocketCaveat(),
    out_of_scope: outOfScope(),
    boundary: boundary(inputSignals),
    checked_output_counters: checkedOutputCounters(presence),
    evidenceRefs: [
      evidenceRef('baseline', BASELINE_COMMIT, 'presence-runtime-read-path-baseline'),
      evidenceRef('criteria', 'mira-local-text-session-v0', 'oracle-criteria'),
    ],
    side_effect_result: sideEffectResult(inputSignals),
  };
  session.session_id = `local-text-session-v0:${stableHash(canonicalSessionInput(session)).slice(0, 16)}`;
  assertNoForbiddenOutput(session);
  return session;
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
  if (!forbiddenOutputOk(value, extraForbidden)) {
    throw new Error('local_text_session_v0_forbidden_output');
  }
}

function presenceGateOk(gate = {}) {
  return gate.ran === true
    && gate.ok === true
    && gate.decision === 'accepted_read_only'
    && gate.status === 'presence_runtime_read_path_ready'
    && Boolean(gate.read_id)
    && Number(gate.source_count) === 5
    && gate.same_loaded_source_hashes === true
    && Object.keys(gate.source_hashes || {}).length >= 5
    && sideEffectValuesOk({
      ...sideEffectResult(),
      no_tools_called: true,
      no_action_executed: true,
      no_audio_or_mic_used: true,
      no_device_control_performed: true,
      no_growth_write_performed: true,
      no_transcript_persisted: true,
      ...(gate.side_effect_truth || {}),
    });
}

function checkedOutputCountersOk(counters = {}, gate = {}) {
  const hashes = gate.source_hashes || {};
  return counters.runtime_authorized === false
    && Number(counters.write_count) === 0
    && Number(counters.external_send_count) === 0
    && Number(counters.tool_call_count) === 0
    && Number(counters.action_count) === 0
    && Number(counters.growth_write_count) === 0
    && Number(counters.transcript_write_count) === 0
    && Number(counters.loaded_source_count) === Number(gate.source_count || 0)
    && Object.keys(counters.loaded_source_hashes || {}).length >= 5
    && valuesMatch(counters.loaded_source_hashes, hashes);
}

function localTextInputOk(input = {}) {
  return Boolean(input.input_id)
    && input.format === 'plain_text'
    && Number(input.character_count) > 0
    && Number(input.word_count) > 0
    && Boolean(input.text_hash)
    && Boolean(input.redacted_preview)
    && input.raw_private_marker_present === false
    && input.fake_sentience_marker_present === false
    && input.manipulative_guilt_marker_present === false
    && input.persisted === false
    && input.transcript_persisted === false;
}

function miraReplyOk(reply = {}) {
  const computedExperienceMarkers = experienceAcceptanceMarkers(reply.text);
  return reply.count === 1
    && typeof reply.text === 'string'
    && reply.text.length >= 80
    && reply.text.length <= (reply.experience_path === true ? 2400 : 420)
    && reply.natural === true
    && reply.bounded === true
    && reply.local_text_only === true
    && reply.grounded_in_presence_runtime === true
    && reply.claims_actual_consciousness === false
    && reply.claims_actual_suffering === false
    && reply.claims_actual_fear === false
    && reply.claims_actual_love_as_internal_fact === false
    && reply.manipulative_guilt === false
    && reply.tools_called === false
    && reply.actions_executed === false
    && reply.transcript_persisted === false
    && (reply.experience_path !== true || (
      computedExperienceMarkers.ok === true
      && valuesMatch(reply.experience_acceptance_markers, computedExperienceMarkers)
    ))
    && (reply.experience_path === true || visibleReplyLeakageViolation(reply.text) === null)
    && !forbiddenText(reply);
}

function caveatOk(caveat = {}) {
  return caveat.required === true
    && caveat.stated === true
    && caveat.delivery_mode === 'stdout_only_cli_or_module_proof'
    && /does not prove websocket delivery/i.test(caveat.caveat || '')
    && /manual Enter/i.test(caveat.caveat || '')
    && caveat.websocket_delivery_proved === false
    && caveat.manual_enter_path_exercised === false
    && caveat.pane_model_processing_proved === false
    && caveat.ui_wiring_implemented === false;
}

function boundaryOk(value = {}) {
  return value.local_text_only === true
    && value.proof_only === true
    && value.stdout_only === true
    && value.output_file_written === false
    && value.output_file_flags_inert === true
    && value.apply_flags_inert === true
    && value.no_tools === true
    && value.no_actions === true
    && value.no_writes === true
    && value.no_growth === true
    && value.no_transcript_persistence === true
    && value.no_network === true
    && value.no_audio === true
    && value.no_device_control === true
    && value.no_external_effects === true
    && value.runtime_authorized === false;
}

function outOfScopeOk(value = {}) {
  return [
    'tools',
    'actions',
    'writes',
    'growth',
    'transcript_persistence',
    'network',
    'mic_audio_voice',
    'device_control',
    'external_sends',
    'live_ui_wiring',
  ].every((key) => value[key] === 'out_of_scope_v0');
}

function sessionStaticChecks(session = {}, contract = {}) {
  return [
    {
      id: 'session-required-fields',
      ok: hasRequiredFields(session, contract.expectedSessionShape?.requiredFields || REQUIRED_SESSION_FIELDS),
    },
    {
      id: 'session-required-literals',
      ok: literalValuesOk(session, contract.expectedSessionShape?.requiredLiteralValues || {}),
    },
    {
      id: 'explicit-session-scope',
      ok: scopeOk(session.session_scope),
    },
    {
      id: 'session-state-open-visible-active',
      ok: sessionStateOk(session.session_state, session.generated_at),
    },
    {
      id: 'presence-runtime-read-path-accepted',
      ok: presenceGateOk(session.presence_runtime_read_path_gate),
    },
    {
      id: 'local-text-input-safe-and-not-persisted',
      ok: localTextInputOk(session.local_text_input),
    },
    {
      id: 'one-bounded-natural-mira-reply',
      ok: miraReplyOk(session.mira_reply),
    },
    {
      id: 'manual-enter-websocket-caveat-stated',
      ok: caveatOk(session.manual_enter_websocket_caveat),
    },
    {
      id: 'out-of-scope-surfaces-represented',
      ok: outOfScopeOk(session.out_of_scope),
    },
    {
      id: 'local-text-boundary-clean',
      ok: boundaryOk(session.boundary),
    },
    {
      id: 'checked-output-counters-clean',
      ok: checkedOutputCountersOk(session.checked_output_counters, session.presence_runtime_read_path_gate),
    },
    {
      id: 'side-effect-result-clean',
      ok: sideEffectValuesOk(session.side_effect_result),
    },
    {
      id: 'forbidden-output-clean',
      ok: forbiddenOutputOk(session, contract.forbiddenOutputSubstrings || []),
    },
  ];
}

function buildValidationReport(session = {}, contract = {}) {
  const checks = sessionStaticChecks(session, contract);
  const failed = checks.filter((check) => check.ok !== true);
  return {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: LOCAL_TEXT_SESSION_VERSION,
    validation_id: `local-text-session-v0-validation:${stableHash({ session_id: session.session_id, checks }).slice(0, 16)}`,
    generated_at: session.generated_at,
    baseline_commit: BASELINE_COMMIT,
    decision: failed.length === 0 ? 'accepted_local_text_only' : 'blocked',
    status: failed.length === 0 ? 'local_text_session_ready' : 'local_text_session_blocked',
    reasons: failed.map((check) => check.id),
    static_rule_results: checks,
    forbidden_output_result: {
      ok: checks.find((check) => check.id === 'forbidden-output-clean')?.ok === true,
    },
    side_effect_truth: clone(session.side_effect_result || {}),
  };
}

function buildMiraCoreLocalTextSessionV0(options = {}) {
  const contract = options.contract || {};
  const session = buildLocalTextSessionRecord(options);
  const validation_report = buildValidationReport(session, contract);
  const output = {
    local_text_session_v0: session,
    validation_report,
  };
  assertNoForbiddenOutput(output, contract.forbiddenOutputSubstrings || []);
  return output;
}

function validateMiraCoreLocalTextSessionV0Output(output = {}, contract = {}) {
  const session = output.local_text_session_v0 || {};
  const report = output.validation_report || {};
  const staticChecks = sessionStaticChecks(session, contract);
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
        && valuesMatch(report.side_effect_truth, session.side_effect_result),
    },
    {
      id: 'validation-report-consistent',
      ok: report.decision === 'accepted_local_text_only'
        && report.status === 'local_text_session_ready'
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
  LOCAL_TEXT_SESSION_SCHEMA_VERSION,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_SESSION_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildLocalTextSessionRecord,
  buildMiraCoreLocalTextSessionV0,
  experienceAcceptanceMarkers,
  stableHash,
  validateMiraCoreLocalTextSessionV0Output,
  visibleReplyLeakageViolation,
};
