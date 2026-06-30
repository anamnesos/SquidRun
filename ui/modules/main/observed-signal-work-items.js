const crypto = require('crypto');

const {
  listWorkItems,
  openWorkItem,
} = require('./work-item-ledger');

const OBSERVED_SIGNAL_SCHEMA = 'squidrun.observed_signal.v0';

const DEFAULT_SCOPE_OUT = Object.freeze([
  'deploys',
  'credential changes',
  'customer contact',
  'money movement',
  'destructive data changes',
  'major UI framework migration',
  'identity/taste changes',
]);

const DEFAULT_SIDE_EFFECT_CAPS = Object.freeze([
  'local source/test/work-item changes only; no external irreversible effects',
]);

const SIGNAL_DEFAULTS = Object.freeze({
  observed_signal: {
    riskClass: 'caution',
    ownerRoles: ['builder'],
    requiredProofs: ['builder_code', 'oracle_verify'],
    suggestedNextCommand: 'Turn the observed signal into a focused implementation or verification slice.',
  },
  initiative_proposed: {
    riskClass: 'caution',
    ownerRoles: ['builder'],
    requiredProofs: ['builder_code', 'oracle_verify'],
    suggestedNextCommand: 'Promote the initiative into a proof-bound implementation slice and run focused tests.',
  },
  repeated_user_correction: {
    riskClass: 'caution',
    ownerRoles: ['builder'],
    requiredProofs: ['builder_code', 'oracle_verify'],
    suggestedNextCommand: 'Extract the repeated correction into a regression test or routing policy check.',
  },
  memory_drift_detected: {
    riskClass: 'caution',
    ownerRoles: ['oracle'],
    requiredProofs: ['oracle_verify'],
    suggestedNextCommand: 'Compare memory claim to current evidence and attach a correction or verification artifact.',
  },
  empty_wake_queue_high_value_issue: {
    riskClass: 'caution',
    ownerRoles: ['builder', 'oracle'],
    requiredProofs: ['builder_code', 'oracle_verify'],
    suggestedNextCommand: 'Materialize the high-value issue into the active work ledger and verify status reconciliation.',
  },
  failed_route_proof: {
    riskClass: 'caution',
    ownerRoles: ['builder'],
    requiredProofs: ['builder_code', 'oracle_verify'],
    suggestedNextCommand: 'Run hm-comms history for the target session/scope and fix the failing route path.',
  },
  test_failure: {
    riskClass: 'safe',
    ownerRoles: ['builder'],
    requiredProofs: ['builder_code', 'oracle_verify'],
    suggestedNextCommand: 'Reproduce the failing test, patch the cause, and rerun the focused suite.',
  },
  full_message_materialization: {
    riskClass: 'caution',
    ownerRoles: ['builder'],
    requiredProofs: ['builder_code', 'builder_regression_test', 'oracle_verify'],
    suggestedNextCommand: 'Run the full-message materialization regression suite and verify long inbound payloads are read before recall/context injection.',
  },
  full_message_clipping: {
    riskClass: 'caution',
    ownerRoles: ['builder'],
    requiredProofs: ['builder_code', 'builder_regression_test', 'oracle_verify'],
    suggestedNextCommand: 'Run the full-message materialization regression suite and verify clipped previews cannot become authority.',
  },
  watchdog_intentional_autonomy_false_positive: {
    riskClass: 'caution',
    ownerRoles: ['builder'],
    requiredProofs: ['builder_code', 'oracle_verify'],
    suggestedNextCommand: 'Verify response-watchdog suppression uses explicit autonomy state and still fires on real no-response.',
  },
  approval_required_change: {
    riskClass: 'approval_required',
    ownerRoles: ['architect'],
    requiredProofs: ['james_checkpoint', 'oracle_verify'],
    suggestedNextCommand: 'Hold work and ask James for the approval-required decision.',
  },
});

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
}

function normalizeToken(value, fallback = null) {
  const text = toOptionalString(value, null);
  if (!text) return fallback;
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || fallback;
}

function splitListValue(value) {
  if (Array.isArray(value)) return value.flatMap((entry) => splitListValue(entry));
  const text = toOptionalString(value, null);
  if (!text) return [];
  return text.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function uniqueStrings(values = []) {
  const out = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = toOptionalString(value, null);
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

function normalizeRiskClass(value, fallback = 'caution') {
  const normalized = normalizeToken(value, fallback);
  if (['safe', 'caution', 'approval_required'].includes(normalized)) return normalized;
  return fallback;
}

function normalizeSignalType(value) {
  const normalized = normalizeToken(value, 'observed_signal');
  if (normalized === 'initiative') return 'initiative_proposed';
  if (normalized === 'repeated_user_corrections') return 'repeated_user_correction';
  if (normalized === 'drift_detected') return 'memory_drift_detected';
  if (normalized === 'empty_wake_queue_high_value_issues') return 'empty_wake_queue_high_value_issue';
  if (normalized === 'route_proof_failed') return 'failed_route_proof';
  if (normalized === 'test_failed') return 'test_failure';
  if (normalized === 'full_message_materialized') return 'full_message_materialization';
  if (normalized === 'message_truncation') return 'full_message_clipping';
  if (normalized === 'full_message_clipping_materialization') return 'full_message_materialization';
  if (normalized === 'watchdog_false_positive') return 'watchdog_intentional_autonomy_false_positive';
  if (normalized === 'approval_required') return 'approval_required_change';
  return normalized;
}

function hashShort(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function normalizeSource(raw = {}) {
  const source = raw.source && typeof raw.source === 'object' ? raw.source : {};
  return {
    type: toOptionalString(source.type || raw.sourceType || raw.type, null),
    id: toOptionalString(source.id || raw.sourceId || raw.initiativeId || raw.id, null),
    messageId: toOptionalString(source.messageId || raw.sourceMessageId || raw.messageId, null),
    file: toOptionalString(source.file || source.path || raw.sourceFile || raw.filePath || raw.path, null),
    rowId: toOptionalString(source.rowId || raw.sourceRowId || raw.rowId, null),
    commit: toOptionalString(source.commit || raw.commit || raw.commitSha, null),
  };
}

function buildSignalKey(signal = {}) {
  const source = signal.source || {};
  const stable = source.id
    || source.messageId
    || source.rowId
    || source.file
    || source.commit
    || signal.title
    || signal.description
    || signal.type;
  return `${signal.type}:${normalizeToken(stable, 'signal')}`;
}

function createObservedWorkItemId(signalKey) {
  const type = normalizeToken(String(signalKey || '').split(':')[0], 'signal');
  return `wi-observed-${type}-${hashShort(signalKey)}`;
}

function normalizeObservedSignal(input = {}, options = {}) {
  const type = normalizeSignalType(input.type || input.signalType || input.sourceType);
  const defaults = SIGNAL_DEFAULTS[type] || SIGNAL_DEFAULTS.observed_signal;
  const source = normalizeSource({ ...input, type });
  const riskClass = normalizeRiskClass(input.riskClass || input.risk || defaults.riskClass);
  const ownerRoles = uniqueStrings(splitListValue(input.ownerRoles || input.ownerRole || defaults.ownerRoles))
    .map((role) => normalizeToken(role))
    .filter(Boolean);
  const requiredProofs = uniqueStrings(splitListValue(input.requiredProofs || input.requiredProof || defaults.requiredProofs))
    .map((role) => normalizeToken(role))
    .filter(Boolean);
  const profile = normalizeToken(input.profile || input.profileName || options.profileName || options.profile, 'main');
  const windowKey = normalizeToken(input.windowKey || input.window || options.windowKey || options.window || profile, profile || 'main');
  const signal = {
    schema: OBSERVED_SIGNAL_SCHEMA,
    version: 1,
    type,
    title: toOptionalString(input.title, null),
    description: toOptionalString(input.description || input.body || input.summary, null),
    status: toOptionalString(input.status, null),
    createdAt: toOptionalString(input.createdAt || input.timestamp, null),
    source,
    session: {
      id: toOptionalString(input.sessionId || input.session?.id || options.sessionId || options.session, null),
    },
    profile,
    window: {
      key: windowKey,
    },
    riskClass,
    ownerRoles,
    requiredProofs,
    suggestedNextCommand: toOptionalString(input.suggestedNextCommand || input.suggestedNextTest, defaults.suggestedNextCommand),
  };
  signal.key = toOptionalString(input.semanticKey || input.key, null) || buildSignalKey(signal);
  signal.workItemId = toOptionalString(input.workItemId, null) || createObservedWorkItemId(signal.key);
  return signal;
}

function buildObjective(signal = {}) {
  const title = signal.title || signal.description || signal.source.id || signal.key;
  if (signal.type === 'initiative_proposed') {
    return `Promote observed initiative to proof-bound work: ${title}`;
  }
  if (signal.type === 'full_message_materialization' || signal.type === 'full_message_clipping') {
    return `Prevent full-message clipping/materialization regression: ${title}`;
  }
  if (signal.type === 'failed_route_proof') {
    return `Repair failed route-proof path: ${title}`;
  }
  if (signal.type === 'test_failure') {
    return `Fix observed test failure: ${title}`;
  }
  if (signal.type === 'watchdog_intentional_autonomy_false_positive') {
    return `Fix watchdog intentional-autonomy false positive: ${title}`;
  }
  return `Convert observed signal to proof-bound work: ${title}`;
}

function buildJamesCheckpoint(signal = {}) {
  if (signal.riskClass !== 'approval_required') return null;
  return {
    required: true,
    reason: toOptionalString(
      signal.checkpointReason,
      'Approval-required signal would materially alter live risk; hold for James checkpoint.'
    ),
    policy: 'approval_required',
  };
}

function sourceMessageIdsForSignal(signal = {}) {
  const source = signal.source || {};
  return uniqueStrings([
    source.messageId,
    source.id,
    source.rowId ? `row:${source.rowId}` : null,
    source.file ? `file:${source.file}` : null,
    source.commit ? `commit:${source.commit}` : null,
  ].filter(Boolean));
}

function mapObservedSignalToWorkItemInput(input = {}, options = {}) {
  const signal = normalizeObservedSignal(input, options);
  signal.checkpointReason = toOptionalString(input.checkpointReason || input.jamesCheckpoint?.reason, null);
  const jamesCheckpoint = buildJamesCheckpoint(signal);
  const artifactSummary = [
    `Observed signal ${signal.type}`,
    signal.source.id ? `id=${signal.source.id}` : null,
    signal.source.messageId ? `message=${signal.source.messageId}` : null,
    signal.source.file ? `file=${signal.source.file}` : null,
    signal.source.rowId ? `row=${signal.source.rowId}` : null,
    signal.source.commit ? `commit=${signal.source.commit}` : null,
  ].filter(Boolean).join('; ');
  const requiredProof = signal.requiredProofs;
  const workItemInput = {
    id: signal.workItemId,
    session: signal.session.id,
    profile: signal.profile,
    window: signal.window.key,
    projectName: options.projectName || input.projectName,
    projectPath: options.projectPath || input.projectPath,
    sourceMessageIds: sourceMessageIdsForSignal(signal),
    objective: buildObjective(signal),
    ownerRoles: signal.ownerRoles,
    scopeIn: [
      'SquidRun observed-signal triage and proof-bound implementation',
      `${signal.type} replay/repair path`,
    ],
    scopeOut: input.scopeOut || DEFAULT_SCOPE_OUT,
    sideEffectCaps: input.sideEffectCaps || DEFAULT_SIDE_EFFECT_CAPS,
    riskClass: signal.riskClass,
    routeHealthRequirement: { required: false },
    requiredProof,
    state: jamesCheckpoint ? 'blocked' : 'active',
    observedSignal: signal,
    suggestedNextCommand: signal.suggestedNextCommand,
    jamesCheckpoint,
    artifactRefs: [{
      ref: `observed-signal:${signal.key}`,
      kind: 'observed_signal',
      summary: artifactSummary,
    }],
  };
  return {
    ok: true,
    signal,
    signalKey: signal.key,
    workItemInput,
    jamesCheckpoint,
  };
}

function findExistingObservedSignalWorkItem(signalKey, options = {}) {
  const listed = listWorkItems(options);
  const items = Array.isArray(listed.items) ? listed.items : [];
  return items.find((item) => (
    item?.observedSignal?.key === signalKey
    || item?.artifactRefs?.some?.((artifact) => artifact?.ref === `observed-signal:${signalKey}`)
  )) || null;
}

function openWorkItemFromObservedSignal(input = {}, options = {}) {
  const mapped = mapObservedSignalToWorkItemInput(input, options);
  const existing = findExistingObservedSignalWorkItem(mapped.signalKey, options);
  if (existing) {
    return {
      ok: true,
      status: 'deduped',
      signal: mapped.signal,
      item: existing,
      dedupeKey: mapped.signalKey,
    };
  }
  const opened = openWorkItem(mapped.workItemInput, options);
  return {
    ...opened,
    status: mapped.jamesCheckpoint ? 'held_for_james_checkpoint' : 'created',
    signal: mapped.signal,
    dedupeKey: mapped.signalKey,
  };
}

module.exports = {
  OBSERVED_SIGNAL_SCHEMA,
  SIGNAL_DEFAULTS,
  buildSignalKey,
  createObservedWorkItemId,
  findExistingObservedSignalWorkItem,
  mapObservedSignalToWorkItemInput,
  normalizeObservedSignal,
  normalizeSignalType,
  openWorkItemFromObservedSignal,
};
