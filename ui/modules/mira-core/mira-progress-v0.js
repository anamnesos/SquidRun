'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  readMiraPresenceRuntimeState,
  resolveStatePath: resolveMiraPresenceRuntimeStatePath,
} = require('./mira-presence-runtime-state-v0');
const {
  readDefaultProgressProofInputs,
} = require('./mira-progress-proof-inputs-v0');

const PROGRESS_CONTRACT_SCHEMA = 'squidrun.mira.progress_contract.v0';
const PROGRESS_REPORT_SCHEMA = 'squidrun.mira.progress_report.v0';
const DEFAULT_CONTRACT_RELATIVE_PATH = path.join(
  'ui',
  '__tests__',
  'fixtures',
  'mira-progress-contract-v0.json'
);

const PASS_STATUSES = new Set(['pass', 'passed', 'green', 'ok']);
const FAIL_STATUSES = new Set(['fail', 'failed', 'red', 'blocked']);
const STALE_STATUSES = new Set(['stale', 'degraded']);
const ALLOWED_SIGNAL_KINDS = new Set([
  'presence_state_fields',
  'presence_state_fresh_for_head',
  'json_contract_schema',
  'proof_input',
]);

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    sorted[key] = canonicalize(value[key]);
  }
  return sorted;
}

function stableHash(value) {
  const json = JSON.stringify(canonicalize(value));
  return `sha256:${crypto.createHash('sha256').update(json).digest('hex')}`;
}

function readJsonFile(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_json_object');
  }
  return parsed;
}

function safeReadJsonFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, decision: 'missing', path: filePath };
    }
    return { ok: true, parsed: readJsonFile(filePath), path: filePath };
  } catch (err) {
    return {
      ok: false,
      decision: 'invalid_json',
      path: filePath,
      error: err && err.message ? err.message : String(err),
    };
  }
}

function resolveProjectRoot(options = {}) {
  return path.resolve(String(options.projectRoot || process.cwd()));
}

function resolveContractPath(options = {}) {
  if (options.contractPath) return path.resolve(String(options.contractPath));
  return path.join(resolveProjectRoot(options), DEFAULT_CONTRACT_RELATIVE_PATH);
}

function normalizeRelative(projectRoot, filePath) {
  if (!filePath) return null;
  const relative = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  return relative && !relative.startsWith('..') ? relative : filePath.replace(/\\/g, '/');
}

function getPathFromProject(projectRoot, relativePath) {
  return path.join(projectRoot, String(relativePath || ''));
}

function toIsoFromMs(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (PASS_STATUSES.has(status)) return 'PASS';
  if (FAIL_STATUSES.has(status)) return 'FAIL';
  if (STALE_STATUSES.has(status)) return 'STALE';
  if (status === 'unknown' || status === 'missing') return 'UNKNOWN';
  return status ? status.toUpperCase() : 'UNKNOWN';
}

function normalizeProofInputs(inputSignals = {}) {
  const proofInputs = inputSignals.proofs || inputSignals.proofInputs || inputSignals.testProofs || {};
  const normalized = new Map();

  const add = (key, value) => {
    if (!key) return;
    const entry = value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : { status: value };
    normalized.set(String(key), {
      key: String(key),
      status: normalizeStatus(entry.status || entry.result || entry.outcome),
      source_ref: entry.source_ref || entry.sourceRef || entry.command || entry.path || String(key),
      reason: entry.reason || entry.summary || entry.result || null,
      generated_at: entry.generated_at || entry.generatedAt || null,
    });
  };

  if (Array.isArray(proofInputs)) {
    for (const entry of proofInputs) {
      if (!entry || typeof entry !== 'object') continue;
      add(entry.proof_key || entry.proofKey || entry.key || entry.id || entry.command, entry);
    }
  } else if (proofInputs && typeof proofInputs === 'object') {
    for (const [key, value] of Object.entries(proofInputs)) add(key, value);
  }

  const verification = inputSignals.verification && typeof inputSignals.verification === 'object'
    ? inputSignals.verification
    : null;
  if (verification && Array.isArray(verification.commands)) {
    for (const command of verification.commands) {
      if (!command || typeof command !== 'object') continue;
      const text = String(command.command || command.source_ref || '');
      for (const candidate of text.match(/[A-Za-z0-9_.-]+\.test\.js/g) || []) {
        add(candidate, {
          status: command.result || command.status || 'UNKNOWN',
          source_ref: text || candidate,
          reason: command.result || null,
        });
      }
    }
  }

  return normalized;
}

function readHeadMetadata(projectRoot, options = {}) {
  if (options.head && typeof options.head === 'object') {
    const committedAtMs = Date.parse(String(options.head.committed_at || options.head.committedAt || ''));
    return {
      present: true,
      source_kind: 'provided_head_metadata',
      short_sha: options.head.short_sha || options.head.shortSha || options.head.sha || null,
      committed_at: Number.isFinite(committedAtMs) ? new Date(committedAtMs).toISOString() : null,
      committed_at_ms: Number.isFinite(committedAtMs) ? committedAtMs : null,
      subject: options.head.subject || null,
    };
  }
  try {
    const stdout = execFileSync(
      'git',
      ['show', '-s', '--format=%h%n%cI%n%s', 'HEAD'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    const [shortSha, committedAt, ...subjectParts] = String(stdout || '').trim().split(/\r?\n/);
    const committedAtMs = Date.parse(String(committedAt || ''));
    return {
      present: Boolean(shortSha),
      source_kind: 'git_head',
      short_sha: shortSha || null,
      committed_at: Number.isFinite(committedAtMs) ? new Date(committedAtMs).toISOString() : null,
      committed_at_ms: Number.isFinite(committedAtMs) ? committedAtMs : null,
      subject: subjectParts.join('\n').trim() || null,
    };
  } catch (err) {
    return {
      present: false,
      source_kind: 'git_head',
      decision: 'head_metadata_unavailable',
      error: err && err.message ? err.message : String(err),
      short_sha: null,
      committed_at: null,
      committed_at_ms: null,
      subject: null,
    };
  }
}

function loadContract(options = {}) {
  if (options.contract && typeof options.contract === 'object') {
    return {
      ok: true,
      contract: options.contract,
      path: null,
      source_ref: 'provided_contract',
      canonical_hash: stableHash(options.contract),
    };
  }
  const projectRoot = resolveProjectRoot(options);
  const contractPath = resolveContractPath(options);
  const read = safeReadJsonFile(contractPath);
  if (!read.ok) {
    return {
      ok: false,
      decision: read.decision || 'contract_missing',
      path: contractPath,
      source_ref: normalizeRelative(projectRoot, contractPath),
      canonical_hash: null,
      error: read.error || null,
    };
  }
  return {
    ok: true,
    contract: read.parsed,
    path: contractPath,
    source_ref: normalizeRelative(projectRoot, contractPath),
    canonical_hash: stableHash(read.parsed),
  };
}

function validateContract(contract = {}) {
  const errors = [];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    return { ok: false, errors: ['contract_required'] };
  }
  if (contract.schema !== PROGRESS_CONTRACT_SCHEMA) errors.push('invalid_contract_schema');
  if (!Array.isArray(contract.categories) || contract.categories.length < 1) {
    errors.push('missing_categories');
  }
  const ids = new Set();
  let totalWeight = 0;
  for (const category of Array.isArray(contract.categories) ? contract.categories : []) {
    const id = String(category.id || '').trim();
    if (!id) errors.push('category_missing_id');
    if (ids.has(id)) errors.push(`duplicate_category:${id}`);
    ids.add(id);
    const weight = Number(category.weight);
    if (!Number.isFinite(weight) || weight <= 0) errors.push(`invalid_category_weight:${id || 'unknown'}`);
    totalWeight += Number.isFinite(weight) ? weight : 0;
    if (!Array.isArray(category.signals) || category.signals.length < 1) {
      errors.push(`category_missing_signals:${id || 'unknown'}`);
    }
    let points = 0;
    for (const signal of Array.isArray(category.signals) ? category.signals : []) {
      const signalId = String(signal.id || '').trim();
      if (!signalId) errors.push(`signal_missing_id:${id || 'unknown'}`);
      if (!ALLOWED_SIGNAL_KINDS.has(String(signal.kind || ''))) {
        errors.push(`unsupported_signal_kind:${id || 'unknown'}:${signalId || 'unknown'}`);
      }
      const signalPoints = Number(signal.points);
      if (!Number.isFinite(signalPoints) || signalPoints <= 0) {
        errors.push(`invalid_signal_points:${id || 'unknown'}:${signalId || 'unknown'}`);
      }
      points += Number.isFinite(signalPoints) ? signalPoints : 0;
    }
    if (Math.round(points) !== 100) errors.push(`category_signal_points_must_sum_100:${id || 'unknown'}`);
  }
  const expectedTotal = Number(contract.formula?.weight_total || 100);
  if (Math.round(totalWeight) !== Math.round(expectedTotal)) errors.push('category_weights_must_sum_formula_total');
  if (contract.formula?.manual_bumps_allowed !== false) errors.push('manual_bumps_must_be_disabled');
  if (contract.anti_drift?.no_durable_global_percent_field !== true) {
    errors.push('anti_drift_global_percent_guard_missing');
  }
  return { ok: errors.length === 0, errors };
}

function presenceStateHasFields(state, requiredFields = []) {
  if (!state || typeof state !== 'object') return false;
  for (const field of requiredFields) {
    const value = state[field];
    if (field === 'stale_markers') {
      if (!Array.isArray(value) || value.length < 1) return false;
    } else if (typeof value !== 'string' || value.trim().length < 1) {
      return false;
    }
  }
  return true;
}

function evaluateSignal(signal, context) {
  const projectRoot = context.projectRoot;
  const state = context.presenceRead.present ? context.presenceRead.state : null;
  const sourceRefs = [];
  const staleMarkers = [];
  const blockerMarkers = [];
  let ok = false;
  let status = 'UNKNOWN';
  let why = '';
  let points_awarded = 0;

  if (signal.kind === 'presence_state_fields') {
    ok = context.presenceRead.present === true && presenceStateHasFields(state, signal.required_fields);
    status = ok ? 'PASS' : 'UNKNOWN';
    why = ok ? 'Presence runtime state includes required durable fields.' : 'Presence runtime state missing required durable fields.';
    if (context.presenceStateSourceRef) sourceRefs.push(context.presenceStateSourceRef);
  } else if (signal.kind === 'presence_state_fresh_for_head') {
    const generatedAtMs = Date.parse(String(state?.generated_at || state?.generatedAt || ''));
    const headMs = context.head.committed_at_ms;
    const hasBoth = Number.isFinite(generatedAtMs) && Number.isFinite(headMs);
    ok = hasBoth && generatedAtMs >= headMs;
    status = ok ? 'PASS' : (hasBoth ? 'STALE' : 'UNKNOWN');
    why = ok
      ? 'Presence runtime state is newer than or equal to HEAD metadata.'
      : (hasBoth
        ? 'Presence runtime state predates HEAD metadata.'
        : 'Presence runtime state freshness cannot be compared to HEAD metadata.');
    if (context.presenceStateSourceRef) sourceRefs.push(context.presenceStateSourceRef);
    if (context.head.short_sha) sourceRefs.push(`HEAD:${context.head.short_sha}`);
    if (status === 'STALE') staleMarkers.push('presence_state_predates_head');
  } else if (signal.kind === 'json_contract_schema') {
    const filePath = getPathFromProject(projectRoot, signal.path);
    const read = safeReadJsonFile(filePath);
    ok = read.ok === true && read.parsed?.schema === signal.schema;
    status = ok ? 'PASS' : 'UNKNOWN';
    why = ok ? 'Machine-readable acceptance contract loaded.' : 'Machine-readable acceptance contract missing or schema mismatched.';
    sourceRefs.push(normalizeRelative(projectRoot, filePath));
  } else if (signal.kind === 'file_present') {
    const filePath = getPathFromProject(projectRoot, signal.path);
    ok = fs.existsSync(filePath);
    status = ok ? 'PASS' : 'UNKNOWN';
    why = ok ? 'Expected local evidence file is present.' : 'Expected local evidence file is missing.';
    sourceRefs.push(normalizeRelative(projectRoot, filePath));
  } else if (signal.kind === 'proof_input') {
    const proof = context.proofs.get(String(signal.proof_key || ''));
    status = proof ? proof.status : 'UNKNOWN';
    ok = status === 'PASS';
    why = ok
      ? 'Reported proof input passed.'
      : (proof ? `Reported proof input status is ${status}.` : 'No reported proof input supplied.');
    if (proof?.source_ref) sourceRefs.push(proof.source_ref);
  } else {
    status = 'UNKNOWN';
    why = `Unsupported signal kind: ${signal.kind || 'missing'}.`;
  }

  if (ok) points_awarded = Number(signal.points) || 0;

  return {
    id: signal.id || null,
    kind: signal.kind || null,
    points_possible: Number(signal.points) || 0,
    points_awarded,
    status,
    why,
    source_refs: sourceRefs.filter(Boolean),
    stale_markers: staleMarkers,
    blocker_markers: blockerMarkers,
  };
}

function applyBlockedCaps(category, computedPercent, blockedStatus = {}) {
  const markers = [];
  let cappedPercent = computedPercent;
  for (const cap of Array.isArray(category.blocked_status_caps) ? category.blocked_status_caps : []) {
    const flag = String(cap.flag || '');
    if (!flag || blockedStatus[flag] !== true) continue;
    const capPercent = Number(cap.cap_percent);
    if (Number.isFinite(capPercent)) {
      cappedPercent = Math.min(cappedPercent, Math.max(0, Math.min(100, capPercent)));
    }
    markers.push(`${flag}: ${cap.reason || 'category capped by blocked_status'}`);
  }
  return { cappedPercent, markers };
}

function evaluateCategory(category, context) {
  const hardZeroFlag = category.hard_zero_when_blocked_status_true;
  const blockedStatus = context.presenceRead.blocked_status || {};
  const evidence = (Array.isArray(category.signals) ? category.signals : [])
    .map((signal) => evaluateSignal(signal, context));
  const possible = evidence.reduce((sum, signal) => sum + signal.points_possible, 0);
  const awarded = evidence.reduce((sum, signal) => sum + signal.points_awarded, 0);
  let computedPercent = possible > 0 ? Math.round((awarded / possible) * 100) : 0;
  const blockerMarkers = [];
  if (hardZeroFlag && blockedStatus[hardZeroFlag] === true) {
    computedPercent = 0;
    blockerMarkers.push(`${hardZeroFlag}: category forced to 0 by contract`);
  }
  const cap = applyBlockedCaps(category, computedPercent, blockedStatus);
  computedPercent = cap.cappedPercent;
  blockerMarkers.push(...cap.markers);

  const staleMarkers = evidence.flatMap((signal) => signal.stale_markers || []);
  const unknownCount = evidence.filter((signal) => signal.status === 'UNKNOWN').length;
  const failCount = evidence.filter((signal) => signal.status === 'FAIL').length;
  const staleCount = evidence.filter((signal) => signal.status === 'STALE').length;
  let status = 'PASS';
  if (blockerMarkers.length > 0) status = 'BLOCKED';
  else if (failCount > 0) status = 'FAIL';
  else if (staleCount > 0) status = 'STALE';
  else if (unknownCount > 0) status = 'UNKNOWN';

  return {
    id: category.id,
    label: category.label || category.id,
    weight: Number(category.weight) || 0,
    computed_percent: computedPercent,
    weighted_points: Number((((Number(category.weight) || 0) * computedPercent) / 100).toFixed(2)),
    status,
    acceptance_100: category.acceptance_100 || null,
    why: summarizeCategoryWhy(status, evidence, blockerMarkers, staleMarkers),
    evidence,
    last_proof_source_refs: Array.from(new Set(evidence.flatMap((signal) => signal.source_refs || []))).slice(0, 8),
    stale_markers: Array.from(new Set(staleMarkers)),
    blocker_markers: Array.from(new Set(blockerMarkers)),
  };
}

function summarizeCategoryWhy(status, evidence, blockerMarkers, staleMarkers) {
  if (blockerMarkers.length > 0) return blockerMarkers[0];
  if (status === 'STALE') return staleMarkers[0] || 'At least one required source is stale.';
  const unknown = evidence.find((signal) => signal.status === 'UNKNOWN');
  if (unknown) return unknown.why;
  const failed = evidence.find((signal) => signal.status === 'FAIL');
  if (failed) return failed.why;
  return 'All supplied contract signals passed.';
}

function buildErrorReport(decision, options = {}, extra = {}) {
  const generatedAt = options.generatedAt || new Date(Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()).toISOString();
  const report = {
    schema: PROGRESS_REPORT_SCHEMA,
    version: 1,
    generated_at: generatedAt,
    status: 'UNKNOWN',
    decision,
    computed_total_percent: 0,
    historical_baseline: null,
    categories: [],
    warnings: extra.warnings || [],
    errors: extra.errors || [],
    anti_drift: {
      manual_bumps_allowed: false,
      hardcoded_global_percent_present: false,
    },
    source_refs: extra.source_refs || {},
  };
  report.canonical_hash = stableHash({ ...report, generated_at: undefined, canonical_hash: undefined });
  return report;
}

function buildMiraProgressReport(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const generatedAt = options.generatedAt || new Date(Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()).toISOString();
  const contractRead = loadContract({ ...options, projectRoot });
  if (!contractRead.ok) {
    return buildErrorReport('progress_contract_unavailable', { ...options, generatedAt }, {
      errors: [contractRead.decision || 'contract_unavailable'],
      source_refs: {
        contract: {
          source_ref: contractRead.source_ref,
          canonical_hash: null,
        },
      },
    });
  }
  const contractValidation = validateContract(contractRead.contract);
  if (!contractValidation.ok) {
    return buildErrorReport('progress_contract_invalid', { ...options, generatedAt }, {
      errors: contractValidation.errors,
      source_refs: {
        contract: {
          source_ref: contractRead.source_ref,
          canonical_hash: contractRead.canonical_hash,
        },
      },
    });
  }

  const presenceStatePath = options.presenceStatePath
    ? path.resolve(String(options.presenceStatePath))
    : resolveMiraPresenceRuntimeStatePath(projectRoot);
  const presenceRead = options.presenceRead && typeof options.presenceRead === 'object'
    ? options.presenceRead
    : readMiraPresenceRuntimeState({ projectRoot, statePath: presenceStatePath });
  const head = readHeadMetadata(projectRoot, options);
  const defaultProofRead = options.disableDefaultProofFile === true
    ? {
      present: false,
      status: 'disabled',
      source_ref: null,
      inputSignals: {},
      warnings: [],
    }
    : readDefaultProgressProofInputs({
      projectRoot,
      progressProofPath: options.progressProofPath || options.defaultProofPath,
      head,
      worktreeState: options.worktreeState || options.currentWorktreeState,
    });
  const proofs = normalizeProofInputs(defaultProofRead.inputSignals || {});
  const explicitProofs = normalizeProofInputs(options.inputSignals || options);
  for (const [key, proof] of explicitProofs.entries()) {
    proofs.set(key, proof);
  }
  const presenceStateSourceRef = normalizeRelative(projectRoot, presenceStatePath);
  const context = {
    projectRoot,
    contract: contractRead.contract,
    presenceRead,
    presenceStatePath,
    presenceStateSourceRef,
    head,
    proofs,
  };
  const categories = contractRead.contract.categories.map((category) => evaluateCategory(category, context));
  const computedTotal = Number(categories.reduce((sum, category) => sum + category.weighted_points, 0).toFixed(2));
  const staleWarnings = [];
  const presenceGeneratedAtMs = Date.parse(String(presenceRead.state?.generated_at || presenceRead.state?.generatedAt || ''));
  if (Number.isFinite(presenceGeneratedAtMs) && Number.isFinite(head.committed_at_ms) && presenceGeneratedAtMs < head.committed_at_ms) {
    staleWarnings.push('presence_state_predates_head');
  } else if (!presenceRead.present) {
    staleWarnings.push('presence_state_unavailable');
  } else if (!Number.isFinite(head.committed_at_ms)) {
    staleWarnings.push('head_metadata_unavailable');
  }
  for (const warning of defaultProofRead.warnings || []) {
    if (warning) staleWarnings.push(warning);
  }
  const unknownCategories = categories.filter((category) => category.status === 'UNKNOWN');
  const blockedCategories = categories.filter((category) => category.status === 'BLOCKED');
  const staleCategories = categories.filter((category) => category.status === 'STALE');
  const failedCategories = categories.filter((category) => category.status === 'FAIL');
  const status = failedCategories.length > 0
    ? 'FAIL'
    : (blockedCategories.length > 0
      ? 'BLOCKED'
      : (staleWarnings.length > 0 || staleCategories.length > 0
        ? 'STALE'
        : (unknownCategories.length > 0 ? 'UNKNOWN' : 'PASS')));

  const report = {
    schema: PROGRESS_REPORT_SCHEMA,
    version: 1,
    generated_at: generatedAt,
    status,
    decision: 'computed_from_contract_state_proofs_blockers_head',
    computed_total_percent: computedTotal,
    formula: {
      aggregate: contractRead.contract.formula.aggregate,
      weight_total: contractRead.contract.formula.weight_total,
      manual_bumps_allowed: false,
      missing_proof_policy: contractRead.contract.formula.missing_proof_policy,
      stale_source_policy: contractRead.contract.formula.stale_source_policy,
    },
    definition_100: contractRead.contract.definition_100,
    historical_baseline: {
      ...contractRead.contract.historical_baseline,
      excluded_from_computation: true,
    },
    source_refs: {
      contract: {
        source_ref: contractRead.source_ref,
        canonical_hash: contractRead.canonical_hash,
      },
      presence_runtime_state: {
        source_ref: presenceStateSourceRef,
        present: presenceRead.present === true,
        generated_at: presenceRead.state?.generated_at || presenceRead.state?.generatedAt || null,
        canonical_hash: presenceRead.state?.canonical_hash || null,
        blocked_status: presenceRead.blocked_status || null,
      },
      head: {
        source_kind: head.source_kind,
        present: head.present === true,
        short_sha: head.short_sha,
        committed_at: head.committed_at,
        subject: head.subject,
      },
      progress_proof_inputs: {
        source_ref: defaultProofRead.source_ref || null,
        present: defaultProofRead.present === true,
        status: defaultProofRead.status || null,
      },
    },
    categories,
    warnings: staleWarnings,
    anti_drift: {
      manual_bumps_allowed: false,
      hardcoded_global_percent_present: false,
      category_ids_from_contract_only: categories.map((category) => category.id),
      computed_value_wins_over_historical_estimate: true,
      allowed_input_kinds: contractRead.contract.anti_drift.allowed_input_kinds,
    },
  };
  report.canonical_hash = stableHash({ ...report, generated_at: undefined, canonical_hash: undefined });
  return report;
}

function formatMiraProgressPlain(report = {}) {
  if (!report || typeof report !== 'object') return 'Mira computed progress: unavailable';
  const baseline = report.historical_baseline?.label
    ? `; historical baseline ${report.historical_baseline.label} excluded from computation`
    : '';
  const lines = [
    `Mira computed progress: ${Number(report.computed_total_percent || 0)}% (${report.status || 'UNKNOWN'})${baseline}`,
  ];
  if (Array.isArray(report.warnings) && report.warnings.length > 0) {
    lines.push(`Warnings: ${report.warnings.join(', ')}`);
  }
  if (Array.isArray(report.categories)) {
    for (const category of report.categories) {
      lines.push(`- ${category.label}: ${category.computed_percent}% (${category.status})`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_CONTRACT_RELATIVE_PATH,
  PROGRESS_CONTRACT_SCHEMA,
  PROGRESS_REPORT_SCHEMA,
  buildMiraProgressReport,
  formatMiraProgressPlain,
  normalizeProofInputs,
  stableHash,
  validateContract,
  _internals: {
    evaluateSignal,
    evaluateCategory,
    readHeadMetadata,
  },
};
