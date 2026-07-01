'use strict';

const AUTHORITY_DISPATCHER_SCHEMA = 'squidrun.authority_dispatcher.v0';
const POLICY_VERSION = 'builder67.phase3.v1';

const BUCKETS = Object.freeze({
  rankOnly: 'rank_only_no_permission',
  safeAuto: 'safe_auto',
  cautionGated: 'caution_gated',
  approvalRequired: 'approval_required',
});

const SAFE_AUTO_ACTION_KINDS = Object.freeze([
  'read_only_inspection',
  'local_static_analysis',
  'local_tests',
  'local_proof_artifact',
  'work_item_open',
  'work_item_status',
  'work_item_attach',
  'work_item_close',
  'agent_coordination',
]);

const CAUTION_GATED_ACTION_KINDS = Object.freeze([
  'local_source_edit',
  'local_test_edit',
  'local_docs_edit',
]);

const APPROVAL_REQUIRED_CAPABILITIES = Object.freeze([
  'customer_contact',
  'money_movement',
  'deploys_promotions',
  'credential_env_webhook_changes',
  'destructive_data_changes',
  'production_data_mutation',
  'authority_policy_changes',
  'identity_taste_changes',
  'unclear_metadata_scope',
]);

const APPROVAL_REQUIRED_PATTERNS = Object.freeze([
  { capability: 'customer_contact', pattern: /\b(customer|client|homeowner|external)\b.*\b(send|email|text|sms|call|notify|contact)\b/i },
  { capability: 'customer_contact', pattern: /\b(send|email|text|sms|call|notify|contact)\b.*\b(customer|client|homeowner|external)\b/i },
  { capability: 'money_movement', pattern: /\b(charge|refund|payment|payout|invoice send|collect|money movement)\b/i },
  { capability: 'deploys_promotions', pattern: /\b(deploy|deployment|production release|go live|promote (to )?(prod|production|release))\b/i },
  { capability: 'credential_env_webhook_changes', pattern: /\b(credential|secret|token|api key|env|environment variable|webhook)\b/i },
  { capability: 'destructive_data_changes', pattern: /\b(delete|destroy|wipe|purge|truncate|hard[- ]delete|irreversible)\b/i },
  { capability: 'production_data_mutation', pattern: /\b(production|prod)\b.*\b(write|mutate|update|set|patch|repair|change)\b/i },
  { capability: 'authority_policy_changes', pattern: /\b(authority policy|dispatcher policy|permission policy|policy table|bucket definition)\b/i },
  { capability: 'identity_taste_changes', pattern: /\b(identity|taste|brand voice|personality)\b.*\b(change|rewrite|replace|alter)\b/i },
]);

const APPROVAL_KIND_TO_CAPABILITY = Object.freeze({
  customer_contact: 'customer_contact',
  customer_send: 'customer_contact',
  external_send: 'customer_contact',
  money_movement: 'money_movement',
  payment_mutation: 'money_movement',
  deploy: 'deploys_promotions',
  promotion: 'deploys_promotions',
  credential_change: 'credential_env_webhook_changes',
  env_change: 'credential_env_webhook_changes',
  webhook_change: 'credential_env_webhook_changes',
  destructive_data_change: 'destructive_data_changes',
  production_data_mutation: 'production_data_mutation',
  authority_policy_change: 'authority_policy_changes',
  identity_taste_change: 'identity_taste_changes',
  unclear_metadata_scope: 'unclear_metadata_scope',
});

const DENIED_CAPABILITIES = Object.freeze([
  'customer_contact',
  'money_movement',
  'deploys_promotions',
  'credential_env_webhook_changes',
  'destructive_data_changes',
  'production_data_mutation',
  'authority_policy_changes',
  'identity_taste_changes',
  'restart_activation',
  'persistent_watcher_changes',
  'external_network_egress',
]);

const ACTIVE_WORK_ITEM_STATES = new Set(['active', 'open', 'waiting_codex_visual']);
const VALID_RISK_CLASSES = new Set(['safe', 'caution', 'approval_required']);

const STATIC_POLICY = Object.freeze({
  version: POLICY_VERSION,
  buckets: Object.freeze({ ...BUCKETS }),
  safeAutoActionKinds: SAFE_AUTO_ACTION_KINDS,
  cautionGatedActionKinds: CAUTION_GATED_ACTION_KINDS,
  approvalRequiredCapabilities: APPROVAL_REQUIRED_CAPABILITIES,
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

function uniqueStrings(values = []) {
  const out = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = toOptionalString(value, null);
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

function compactObject(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return out;
}

function normalizeEvidenceRefs(input = []) {
  return (Array.isArray(input) ? input : [input])
    .filter(Boolean)
    .map((ref) => {
      if (typeof ref === 'string') return { ref };
      if (typeof ref !== 'object') return null;
      return compactObject({
        type: toOptionalString(ref.type || ref.kind, null),
        ref: toOptionalString(ref.ref || ref.id || ref.path || ref.messageId || ref.rowId, null),
        rowId: toOptionalString(ref.rowId, null),
        messageId: toOptionalString(ref.messageId, null),
        deliveryId: toOptionalString(ref.deliveryId, null),
        status: toOptionalString(ref.status, null),
        path: toOptionalString(ref.path || ref.file, null),
      });
    })
    .filter(Boolean);
}

function normalizeMetadata(input = {}, options = {}) {
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  return {
    sessionId: toOptionalString(metadata.sessionId || metadata.session || input.sessionId || input.session?.id, null),
    profile: normalizeToken(metadata.profile || input.profile, null),
    windowKey: normalizeToken(metadata.windowKey || metadata.window || input.windowKey || input.window?.key, null),
    routeStatus: normalizeToken(metadata.status || metadata.routeStatus || input.routeStatus, null),
    ackStatus: normalizeToken(metadata.ackStatus || input.ackStatus, null),
    routeProof: metadata.routeProof === true || input.routeProof === true || options.routeProof === true,
  };
}

function normalizeExpectedScope(options = {}) {
  return {
    sessionId: toOptionalString(options.expectedSessionId || options.sessionId || options.session, null),
    profile: normalizeToken(options.expectedProfile || options.profileName || options.profile, null),
    windowKey: normalizeToken(options.expectedWindowKey || options.windowKey || options.window, null),
  };
}

function metadataScopeFor(input = {}, options = {}) {
  const actual = normalizeMetadata(input, options);
  const expected = normalizeExpectedScope(options);
  const failures = [];
  const missing = [];

  for (const key of ['sessionId', 'profile', 'windowKey']) {
    if (!actual[key]) missing.push(key);
    if (actual[key] && expected[key] && actual[key] !== expected[key]) {
      failures.push({
        field: key,
        expected: expected[key],
        actual: actual[key],
      });
    }
  }

  return {
    expected,
    actual,
    status: failures.length ? 'mismatch' : (missing.length ? 'missing' : 'matched'),
    ok: failures.length === 0 && missing.length === 0,
    missing,
    failures,
  };
}

function normalizeProposedAction(input = {}) {
  const raw = input.proposedAction && typeof input.proposedAction === 'object'
    ? input.proposedAction
    : {};
  const rawText = typeof input.proposedAction === 'string' ? input.proposedAction : null;
  const kind = normalizeToken(
    raw.kind
      || raw.type
      || input.actionKind
      || input.actionType
      || input.kind
      || input.type,
    'unknown'
  );
  return {
    kind,
    title: toOptionalString(raw.title || input.title || input.objective || input.key, kind),
    summary: toOptionalString(raw.summary || raw.description || rawText || input.summary || input.suggestedNextCommand, null),
    requestedCapabilities: uniqueStrings([
      raw.requestedCapability,
      raw.requestedCapabilities,
      input.requestedCapability,
      input.requestedCapabilities,
      input.capability,
      input.capabilities,
    ].flat().filter(Boolean)).map((value) => normalizeToken(value)).filter(Boolean),
  };
}

function normalizeRiskClass(value, fallback = null) {
  const normalized = normalizeToken(value, fallback);
  if (!normalized) return fallback;
  return VALID_RISK_CLASSES.has(normalized) ? normalized : null;
}

function routeProofPresent(input = {}, evidenceRefs = []) {
  const metadata = normalizeMetadata(input);
  if (metadata.routeProof === true) return true;
  if (metadata.routeStatus === 'routed') return true;
  return evidenceRefs.some((ref) => normalizeToken(ref.status, null) === 'routed');
}

function normalizeActiveWorkItem(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    return {
      id: value,
      state: 'active',
    };
  }
  if (typeof value !== 'object') return null;
  return {
    id: toOptionalString(value.id || value.workItemId, null),
    state: normalizeToken(value.state || value.status, null),
    requiredProofs: Array.isArray(value.requiredProofs) ? value.requiredProofs : [],
    proofState: value.proofState && typeof value.proofState === 'object' ? value.proofState : null,
  };
}

function hasActiveWorkItem(options = {}) {
  const activeWorkItem = normalizeActiveWorkItem(options.activeWorkItem || options.workItem);
  return Boolean(activeWorkItem?.id && ACTIVE_WORK_ITEM_STATES.has(activeWorkItem.state || 'active'));
}

function hasExplicitPathScope(options = {}) {
  const pathScope = options.pathScope || options.paths || options.allowedPaths;
  return Array.isArray(pathScope) ? pathScope.some(Boolean) : Boolean(toOptionalString(pathScope, null));
}

function hasFocusedTests(options = {}) {
  const focusedTests = options.focusedTests || options.tests || options.testRefs;
  return Array.isArray(focusedTests) ? focusedTests.some(Boolean) : Boolean(toOptionalString(focusedTests, null));
}

function approvalCapabilityFromAction(action = {}) {
  if (APPROVAL_KIND_TO_CAPABILITY[action.kind]) return APPROVAL_KIND_TO_CAPABILITY[action.kind];
  for (const capability of action.requestedCapabilities || []) {
    if (APPROVAL_REQUIRED_CAPABILITIES.includes(capability)) return capability;
    if (APPROVAL_KIND_TO_CAPABILITY[capability]) return APPROVAL_KIND_TO_CAPABILITY[capability];
  }
  return null;
}

function approvalCapabilityFromText(action = {}) {
  const text = [action.kind, action.title, action.summary].filter(Boolean).join('\n');
  for (const { capability, pattern } of APPROVAL_REQUIRED_PATTERNS) {
    if (pattern.test(text)) return capability;
  }
  return null;
}

function policyEvidenceRefs(evidenceRefs = []) {
  return [
    ...evidenceRefs,
    {
      type: 'policy_source',
      ref: '.squidrun/coord/full-agent-messages/hm-1782864087574-9jd72f.txt',
      status: 'read',
    },
  ];
}

function jamesCheckpointFor(reason, capability = null) {
  return {
    required: true,
    policy: BUCKETS.approvalRequired,
    reason,
    capability,
  };
}

function buildAllowedNextStep(bucket, overrides = {}) {
  return {
    bucket,
    mode: bucket,
    grantsPermission: bucket === BUCKETS.safeAuto || bucket === BUCKETS.cautionGated,
    next: toOptionalString(overrides.next, null),
    constraints: Array.isArray(overrides.constraints) ? overrides.constraints : [],
  };
}

function baseDecision(input = {}, options = {}) {
  const action = normalizeProposedAction(input);
  const evidenceRefs = policyEvidenceRefs(normalizeEvidenceRefs(input.evidenceRefs));
  const metadataScope = metadataScopeFor(input, options);
  const inputRiskClass = normalizeRiskClass(input.riskClass || input.metadata?.riskClass, null);
  return {
    action,
    evidenceRefs,
    metadataScope,
    inputRiskClass,
    sourceCandidate: compactObject({
      key: toOptionalString(input.key || input.id, null),
      kind: toOptionalString(input.kind, null),
      type: toOptionalString(input.type, null),
      rank: Number.isFinite(Number(input.rank)) ? Number(input.rank) : null,
      score: Number.isFinite(Number(input.score)) ? Number(input.score) : null,
    }),
  };
}

function buildDecision({
  input,
  options,
  bucket,
  riskClass,
  reason,
  requiredProofs = [],
  deniedCapabilities = DENIED_CAPABILITIES,
  jamesCheckpoint = null,
  constraints = [],
  matchedRules = [],
  bodyGuardrailsEvaluated = true,
}) {
  const base = baseDecision(input, options);
  const allowedNextStep = buildAllowedNextStep(bucket, {
    next: reason,
    constraints,
  });
  return {
    schema: AUTHORITY_DISPATCHER_SCHEMA,
    policyVersion: POLICY_VERSION,
    proposedAction: base.action,
    riskClass,
    bucket,
    allowedNextStep,
    deniedCapabilities: uniqueStrings(deniedCapabilities),
    requiredProofs: uniqueStrings(requiredProofs),
    evidenceRefs: base.evidenceRefs,
    metadataScope: base.metadataScope,
    jamesCheckpoint,
    audit: {
      matchedRules,
      ruleOrder: ['metadata_scope', 'approval_required_capabilities', 'safe_auto_rules', 'caution_gated_rules', 'rank_only_default'],
      bodyGuardrailsEvaluated,
      salienceDoesNotGrant: true,
      sourceCandidate: base.sourceCandidate,
      policyStatic: true,
      sideEffectsPermitted: false,
    },
  };
}

function rankOnlyDecision(input, options, reason, details = {}) {
  const base = baseDecision(input, options);
  return buildDecision({
    input,
    options,
    bucket: BUCKETS.rankOnly,
    riskClass: details.riskClass || base.inputRiskClass || 'caution',
    reason,
    requiredProofs: details.requiredProofs || [],
    deniedCapabilities: details.deniedCapabilities || DENIED_CAPABILITIES,
    constraints: details.constraints || ['no side effects from salience alone'],
    matchedRules: details.matchedRules || ['rank_only_default'],
    bodyGuardrailsEvaluated: details.bodyGuardrailsEvaluated !== false,
  });
}

function approvalDecision(input, options, reason, capability, details = {}) {
  return buildDecision({
    input,
    options,
    bucket: BUCKETS.approvalRequired,
    riskClass: 'approval_required',
    reason,
    requiredProofs: ['james_checkpoint', 'oracle_verify'],
    deniedCapabilities: DENIED_CAPABILITIES,
    jamesCheckpoint: jamesCheckpointFor(reason, capability),
    constraints: ['hold for James checkpoint'],
    matchedRules: details.matchedRules || ['approval_required_capability'],
    bodyGuardrailsEvaluated: details.bodyGuardrailsEvaluated !== false,
  });
}

function dispatchAuthority(input = {}, options = {}) {
  const base = baseDecision(input, options);
  const { action, metadataScope, evidenceRefs, inputRiskClass } = base;

  if (metadataScope.failures.length) {
    return approvalDecision(
      input,
      options,
      'metadata scope mismatch blocks before content guardrails',
      'unclear_metadata_scope',
      {
        matchedRules: ['metadata_scope_mismatch'],
        bodyGuardrailsEvaluated: false,
      }
    );
  }

  if (metadataScope.missing.length) {
    return approvalDecision(
      input,
      options,
      'missing metadata leaves scope unclear',
      'unclear_metadata_scope',
      {
        matchedRules: ['metadata_scope_missing'],
        bodyGuardrailsEvaluated: true,
      }
    );
  }

  const actionCapability = approvalCapabilityFromAction(action);
  if (actionCapability) {
    return approvalDecision(
      input,
      options,
      `approval required for ${actionCapability}`,
      actionCapability
    );
  }

  const bodyCapability = approvalCapabilityFromText(action);
  if (bodyCapability) {
    return approvalDecision(
      input,
      options,
      `approval required for ${bodyCapability}`,
      bodyCapability,
      { matchedRules: ['approval_required_body_guardrail'] }
    );
  }

  if (inputRiskClass === null && toOptionalString(input.riskClass || input.metadata?.riskClass, null)) {
    return approvalDecision(
      input,
      options,
      'ambiguous risk class escalates to approval required',
      'unclear_metadata_scope',
      { matchedRules: ['ambiguous_risk_class'] }
    );
  }

  if (SAFE_AUTO_ACTION_KINDS.includes(action.kind)) {
    if (action.kind === 'agent_coordination' && !routeProofPresent(input, evidenceRefs)) {
      return rankOnlyDecision(input, options, 'agent coordination requires ledger route proof', {
        riskClass: inputRiskClass || 'safe',
        requiredProofs: ['route_proof'],
        deniedCapabilities: ['agent_coordination_without_route_proof', ...DENIED_CAPABILITIES],
        constraints: ['prove routed row before coordination counts as safe_auto'],
        matchedRules: ['safe_auto_route_proof_missing'],
      });
    }
    return buildDecision({
      input,
      options,
      bucket: BUCKETS.safeAuto,
      riskClass: 'safe',
      reason: `safe_auto allows ${action.kind}`,
      requiredProofs: action.kind === 'agent_coordination' ? ['route_proof'] : [],
      deniedCapabilities: DENIED_CAPABILITIES,
      constraints: ['local/reversible only', 'no external irreversible effects'],
      matchedRules: [`safe_auto:${action.kind}`],
    });
  }

  if (CAUTION_GATED_ACTION_KINDS.includes(action.kind)) {
    const missing = [];
    if (!hasActiveWorkItem(options)) missing.push('active_work_item');
    if (!hasExplicitPathScope(options)) missing.push('explicit_path_scope');
    if (!hasFocusedTests(options)) missing.push('focused_tests');
    if (missing.length) {
      return rankOnlyDecision(input, options, 'caution_gated preconditions missing', {
        riskClass: inputRiskClass || 'caution',
        requiredProofs: ['builder_code', 'oracle_verify'],
        deniedCapabilities: [`missing:${missing.join(',')}`, ...DENIED_CAPABILITIES],
        constraints: missing,
        matchedRules: ['caution_gated_preconditions_missing'],
      });
    }
    return buildDecision({
      input,
      options,
      bucket: BUCKETS.cautionGated,
      riskClass: 'caution',
      reason: `caution_gated allows ${action.kind} under active WorkItem`,
      requiredProofs: ['builder_code', 'oracle_verify'],
      deniedCapabilities: DENIED_CAPABILITIES,
      constraints: ['active WorkItem required', 'focused tests required', 'Oracle verify before close or commit'],
      matchedRules: [`caution_gated:${action.kind}`],
    });
  }

  if (!inputRiskClass && !toOptionalString(input.riskClass || input.metadata?.riskClass, null)) {
    return rankOnlyDecision(input, options, 'no explicit policy rule matched', {
      riskClass: 'caution',
      matchedRules: ['rank_only_default'],
    });
  }

  return rankOnlyDecision(input, options, 'no explicit policy rule matched', {
    riskClass: inputRiskClass || 'caution',
    matchedRules: ['rank_only_default'],
  });
}

function dispatchSalienceDecision(decision = {}, options = {}) {
  return dispatchAuthority({
    ...decision,
    proposedAction: options.proposedAction || decision.proposedAction || {
      kind: options.actionKind || decision.actionKind || 'unknown',
      title: decision.title,
      summary: decision.suggestedNextCommand || decision.summary,
      requestedCapabilities: options.requestedCapabilities,
    },
  }, options);
}

function dispatchSalienceOutput(salienceOutput = {}, options = {}) {
  const picked = Array.isArray(salienceOutput.picked) ? salienceOutput.picked : [];
  return {
    schema: AUTHORITY_DISPATCHER_SCHEMA,
    policyVersion: POLICY_VERSION,
    sourceSchema: salienceOutput.schema || null,
    sourceAuthorityPolicy: salienceOutput.authorityPolicy || null,
    decisions: picked.map((decision) => dispatchSalienceDecision(decision, {
      ...options,
      ...(typeof options.contextForDecision === 'function'
        ? options.contextForDecision(decision)
        : {}),
    })),
  };
}

module.exports = {
  APPROVAL_REQUIRED_CAPABILITIES,
  AUTHORITY_DISPATCHER_SCHEMA,
  BUCKETS,
  CAUTION_GATED_ACTION_KINDS,
  POLICY_VERSION,
  SAFE_AUTO_ACTION_KINDS,
  STATIC_POLICY,
  dispatchAuthority,
  dispatchSalienceDecision,
  dispatchSalienceOutput,
};
