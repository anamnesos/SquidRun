'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 'squidrun.mira_core.presence_runtime_state.v0';
const STATE_VERSION = 1;
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

module.exports = {
  SCHEMA_VERSION,
  STATE_VERSION,
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
  canonicalHash,
};
