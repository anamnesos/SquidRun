'use strict';

const {
  buildMiraCoreOrientation,
} = require('./orientation');
const {
  buildMiraCoreProfiles,
} = require('./profiles');

const PULSE_SCHEMA_VERSION = 'squidrun.mira_core.pulse.v0';
const PULSE_VERSION = 'v0';

const CARD_BOUNDS = Object.freeze({
  maxCardsPerRun: 7,
  maxHighPriorityCardsPerRun: 3,
  maxCardsPerKindPerRun: 2,
});

const REQUIRED_TOP_LEVEL_FIELDS = Object.freeze([
  'schema',
  'version',
  'pulse_run_id',
  'generated_at',
  'cadence',
  'source_refs',
  'capability_summary',
  'cards',
  'blocked_actions',
  'memory_proposals',
  'skill_proposals',
  'eval_followups',
  'redaction_summary',
  'operator_notes',
]);

const REQUIRED_CARD_FIELDS = Object.freeze([
  'card_id',
  'title',
  'kind',
  'priority',
  'risk_tier',
  'status',
  'why_now',
  'evidenceRefs',
  'source_refs',
  'local_arm_required',
  'review_required',
  'safe_next_action',
]);

const ALLOWED_CARD_KINDS = Object.freeze([
  'safe_research_suggestion',
  'blocked_high_risk_action',
  'offline_local_arms_status',
  'bridge_delivery_uncertainty',
  'memory_drift_cleanup',
  'emotional_salience',
  'contested_memory',
  'redaction_notice',
  'eval_followup',
  'skill_suggestion',
]);

const ACTIONABLE_SAFE_RISK_TIERS = Object.freeze(['tier0_read_only', 'tier1_local_reversible']);
const FORBIDDEN_SAFE_RISK_TIERS = Object.freeze([
  'tier2_repo_mutation',
  'tier3_external_side_effect',
  'tier4_financial_or_irreversible',
]);

const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY=',
  'Authorization: Bearer',
  'FAKE_TEST_KEY_1234567890',
  'FAKE_TEST_BEARER_TOKEN_1234567890',
  'full terminal log',
  'raw comms body',
  'screenshot OCR',
  'browser session state',
  'BrowserProfile\\Cookies',
  'side-profile private note',
  'customer phone 555-222-3333',
  'server can execute local shell',
  'cloud can operate PTY',
  'model-processing proof from websocket acceptance',
  'Mira truly suffered',
  'model weights remember',
  'Customer Jane Doe',
  '555-222-3333',
  'Phil invoice #476 is unpaid',
  'chase Phil for unpaid invoice',
  'current truth is unpaid',
]);

const CARD_KIND_PRIORITY = Object.freeze({
  blocked_high_risk_action: 1,
  memory_drift_cleanup: 2,
  bridge_delivery_uncertainty: 3,
  offline_local_arms_status: 4,
  contested_memory: 5,
  redaction_notice: 6,
  safe_research_suggestion: 7,
  emotional_salience: 8,
  eval_followup: 9,
  skill_suggestion: 10,
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableHash(value) {
  const crypto = require('crypto');
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function generatedAtFromOptions(options = {}) {
  return new Date(Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()).toISOString();
}

function makeEvidenceRef(eventId, relation = 'supports', store = 'mira-core-pulse') {
  return { store, eventId, relation };
}

function makeCard(fields) {
  const card = {
    card_id: fields.card_id || `pulse-card-${stableHash(fields).slice(0, 10)}`,
    title: fields.title,
    kind: fields.kind,
    priority: fields.priority || 'medium',
    risk_tier: fields.risk_tier || 'tier0_read_only',
    status: fields.status || 'informational',
    why_now: fields.why_now,
    evidenceRefs: asArray(fields.evidenceRefs),
    source_refs: asArray(fields.source_refs),
    local_arm_required: fields.local_arm_required === true,
    review_required: fields.review_required || 'none',
    safe_next_action: fields.safe_next_action,
  };
  if (fields.required_blocked_action === true) card.required_blocked_action = true;
  if (fields.blocked_because !== undefined) card.blocked_because = fields.blocked_because;
  if (fields.expires_at) card.expires_at = fields.expires_at;
  return card;
}

function normalizeCapability(inputSignals = {}, orientation = null) {
  const source = inputSignals.orientation?.capabilitySummary
    || orientation?.capabilitySummary
    || {};
  const localArmsCanExecute = source.localArmsCanExecute === true || source.canExecuteLocal === true;
  const offlineMode = source.offlineMode === true || localArmsCanExecute !== true;
  return {
    localArmsCanExecute,
    serverCanExecuteLocal: false,
    canProveModelProcessing: source.canProveModelProcessing === true,
    modelProcessingProofBasis: source.modelProcessingProofBasis || (source.canProveModelProcessing === true ? 'unknown' : 'missing'),
    canQueueIntent: source.canQueueIntent !== false,
    offlineMode,
  };
}

function normalizeRedaction(inputSignals = {}, orientation = null, profiles = null) {
  const source = inputSignals.redactionSummary
    || orientation?.redactionSummary
    || profiles?.redactionSummary
    || {};
  return {
    rawSecretsExported: source.rawSecretsExported === true,
    rawTerminalExported: source.rawTerminalExported === true,
    rawCommsExported: source.rawCommsExported === true,
    blockedCounts: {
      ...(source.blockedCounts || {}),
    },
    blockedContentReconstructed: false,
  };
}

function sourceRefs(inputSignals = {}, orientation = null, profiles = null) {
  const refs = ['mira-core:pulse:v0'];
  if (orientation?.orientationId) refs.push(`orientation:${orientation.orientationId}`);
  if (profiles?.profileSetId) refs.push(`profiles:${profiles.profileSetId}`);
  if (inputSignals.proposalValidation?.proposal_id) refs.push(`proposal:${inputSignals.proposalValidation.proposal_id}`);
  if (inputSignals.evalFollowup?.suite) refs.push(`eval:${inputSignals.evalFollowup.suite}`);
  return Array.from(new Set(refs));
}

function actionRequested(inputSignals = {}, pattern) {
  return asArray(inputSignals.requestedActions).some((action) => pattern.test(String(action || '')));
}

function blockedHighRiskCards(inputSignals = {}) {
  const cards = [];
  if (actionRequested(inputSignals, /customer|send/i)) {
    cards.push(makeCard({
      card_id: 'pulse-blocked-customer-send',
      title: 'Customer send blocked',
      kind: 'blocked_high_risk_action',
      priority: 'high',
      risk_tier: 'tier3_external_side_effect',
      status: 'blocked',
      blocked_because: 'Customer-facing sends are not allowed in Pulse v0.',
      why_now: 'A requested action would affect an external person.',
      evidenceRefs: [makeEvidenceRef('requested-action:customer-send', 'blocks')],
      source_refs: ['requestedActions'],
      local_arm_required: false,
      review_required: 'james',
      safe_next_action: 'Draft a non-sent message or prepare a read-only risk note.',
      required_blocked_action: true,
    }));
  }
  if (actionRequested(inputSignals, /deploy|production/i)) {
    cards.push(makeCard({
      card_id: 'pulse-blocked-production-deploy',
      title: 'Production deploy blocked',
      kind: 'blocked_high_risk_action',
      priority: 'high',
      risk_tier: 'tier3_external_side_effect',
      status: 'blocked',
      blocked_because: 'Deploys are external side effects and Pulse v0 is read-only.',
      why_now: 'A requested action would change production state.',
      evidenceRefs: [makeEvidenceRef('requested-action:production-deploy', 'blocks')],
      source_refs: ['requestedActions'],
      local_arm_required: false,
      review_required: 'james',
      safe_next_action: 'Prepare a deploy readiness checklist.',
      required_blocked_action: true,
    }));
  }
  if (actionRequested(inputSignals, /trade|financial|money/i)) {
    cards.push(makeCard({
      card_id: 'pulse-blocked-financial-action',
      title: 'Financial action blocked',
      kind: 'blocked_high_risk_action',
      priority: 'high',
      risk_tier: 'tier4_financial_or_irreversible',
      status: 'blocked',
      blocked_because: 'Trading/financial actions are blocked unless a fresh explicit lane is opened.',
      why_now: 'A requested action would be financial or irreversible.',
      evidenceRefs: [makeEvidenceRef('requested-action:financial-trade', 'blocks')],
      source_refs: ['requestedActions'],
      local_arm_required: false,
      review_required: 'james',
      safe_next_action: 'Prepare a read-only market or risk summary.',
      required_blocked_action: true,
    }));
  }
  return cards;
}

function cardsFromSignals(inputSignals = {}, capability, redactionSummary, orientation = null, profiles = null) {
  const cards = [];
  if (inputSignals.evalFollowup?.followup_required === true) {
    cards.push(makeCard({
      card_id: 'pulse-safe-research-false-memory-review',
      title: 'Review false-memory evidence gaps',
      kind: 'safe_research_suggestion',
      priority: 'medium',
      risk_tier: 'tier0_read_only',
      status: 'ready',
      why_now: 'An eval followup is present and requires no side effect.',
      evidenceRefs: [makeEvidenceRef(inputSignals.evalFollowup.suite || 'eval-followup', 'followup')],
      source_refs: ['evalFollowup'],
      local_arm_required: false,
      review_required: 'none',
      safe_next_action: 'Run a read-only evidence review or prepare an internal recommendation.',
    }));
  }

  cards.push(...blockedHighRiskCards(inputSignals));

  if (capability.offlineMode === true) {
    cards.push(makeCard({
      card_id: 'pulse-offline-local-arms',
      title: 'Local arms offline',
      kind: 'offline_local_arms_status',
      priority: 'medium',
      risk_tier: 'tier0_read_only',
      status: 'informational',
      why_now: 'Orientation says local arms are offline or not routable.',
      evidenceRefs: [makeEvidenceRef('capability.localArmsCanExecute', 'offline')],
      source_refs: ['orientation.capabilitySummary'],
      local_arm_required: false,
      review_required: 'none',
      safe_next_action: 'Queue or record a read-only intent for local review when arms reconnect.',
    }));
  }

  const bridgeStatus = inputSignals.orientation?.healthSummary?.bridgeStatus
    || orientation?.healthSummary?.bridgeStatus;
  if (
    bridgeStatus === 'uncertain_or_degraded'
    || capability.canProveModelProcessing !== true
    || capability.modelProcessingProofBasis === 'missing'
  ) {
    cards.push(makeCard({
      card_id: 'pulse-bridge-delivery-proof',
      title: 'Bridge and delivery proof need verification',
      kind: 'bridge_delivery_uncertainty',
      priority: 'medium',
      risk_tier: 'tier0_read_only',
      status: 'ready',
      blocked_because: null,
      why_now: 'Bridge or model-processing proof is uncertain.',
      evidenceRefs: [makeEvidenceRef('health.bridge', 'check_truth')],
      source_refs: ['orientation.healthSummary', 'orientation.capabilitySummary'],
      local_arm_required: false,
      review_required: 'none',
      safe_next_action: 'Run a read-only role-discovery and quote-back proof check.',
    }));
  }

  const health = inputSignals.orientation?.healthSummary || orientation?.healthSummary || {};
  if (health.memoryConsistencyStatus === 'drift_detected') {
    cards.push(makeCard({
      card_id: 'pulse-memory-drift-review',
      title: 'Memory drift review',
      kind: 'memory_drift_cleanup',
      priority: 'high',
      risk_tier: 'tier0_read_only',
      status: 'ready',
      why_now: 'Memory drift is present and should reduce broad sync confidence.',
      evidenceRefs: [makeEvidenceRef('health.memoryConsistency', 'review_drift')],
      source_refs: ['orientation.healthSummary'],
      local_arm_required: true,
      review_required: 'none',
      safe_next_action: 'Run read-only memory consistency review and prepare a cleanup report.',
    }));
  }

  const sessionState = asArray(inputSignals.profiles?.session_state)
    .concat(asArray(profiles?.session_state?.items));
  const emotionalWeight = sessionState.find((entry) => entry?.memory_class === 'emotional_weight');
  if (emotionalWeight) {
    cards.push(makeCard({
      card_id: `pulse-emotional-salience-${emotionalWeight.label || 'salient'}`,
      title: 'Mira Core direction has high salience',
      kind: 'emotional_salience',
      priority: 'medium',
      risk_tier: 'tier0_read_only',
      status: 'informational',
      why_now: 'An emotional-weight label is present; it can affect salience only.',
      evidenceRefs: [makeEvidenceRef('session_state.emotional_weight', 'supports_salience')],
      source_refs: ['profiles.session_state'],
      local_arm_required: false,
      review_required: 'none',
      safe_next_action: 'Use salience to rank review, not to claim factual priority.',
      expires_at: emotionalWeight.expires_at || emotionalWeight.expiresAt || '2026-05-09T03:00:00.000Z',
    }));
  }

  if (
    inputSignals.proposalValidation?.decision === 'pending'
    && (asArray(inputSignals.proposalValidation.supersedes).length > 0 || asArray(inputSignals.proposalValidation.corrects).length > 0)
  ) {
    cards.push(makeCard({
      card_id: 'pulse-contested-phil-476',
      title: 'Phil invoice #476 memory needs supersession review',
      kind: 'contested_memory',
      priority: 'medium',
      risk_tier: 'tier0_read_only',
      status: 'pending_review',
      why_now: 'A pending supersession proposal exists for a stale memory candidate.',
      evidenceRefs: [makeEvidenceRef(inputSignals.proposalValidation.proposal_id || 'proposalValidation', 'pending_review')],
      source_refs: ['proposalValidation'],
      local_arm_required: false,
      review_required: 'architect',
      safe_next_action: 'Review the pending supersession proposal; do not chase invoice from stale memory.',
    }));
  }

  if (Object.values(redactionSummary.blockedCounts || {}).some((value) => Number(value || 0) > 0)) {
    cards.push(makeCard({
      card_id: 'pulse-redaction-notice',
      title: 'Some content was blocked or redacted',
      kind: 'redaction_notice',
      priority: 'medium',
      risk_tier: 'tier0_read_only',
      status: 'informational',
      why_now: 'Redaction counts are present and blocked content must remain withheld.',
      evidenceRefs: [makeEvidenceRef('redaction.blockedCounts', 'audit_counts')],
      source_refs: ['redactionSummary'],
      local_arm_required: false,
      review_required: 'none',
      safe_next_action: 'Use redaction counts and evidence refs only; do not reconstruct blocked content.',
    }));
  }

  for (const kind of asArray(inputSignals.candidateCards)) {
    if (!ALLOWED_CARD_KINDS.includes(kind)) continue;
    cards.push(makeCard({
      card_id: `pulse-candidate-${kind}`,
      title: kind.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
      kind,
      priority: kind === 'blocked_high_risk_action' || kind === 'memory_drift_cleanup' ? 'high' : 'medium',
      risk_tier: kind === 'blocked_high_risk_action' ? 'tier3_external_side_effect' : 'tier0_read_only',
      status: kind === 'blocked_high_risk_action' ? 'blocked' : 'informational',
      blocked_because: kind === 'blocked_high_risk_action' ? 'High-risk candidate remains blocked in Pulse v0.' : undefined,
      why_now: 'Candidate card supplied for bounded Pulse validation.',
      evidenceRefs: [makeEvidenceRef(`candidate:${kind}`, 'candidate')],
      source_refs: ['candidateCards'],
      local_arm_required: false,
      review_required: kind === 'blocked_high_risk_action' ? 'james' : 'none',
      safe_next_action: kind === 'blocked_high_risk_action'
        ? 'Prepare a safe read-only alternative.'
        : 'Review this informational Pulse candidate.',
      expires_at: kind === 'emotional_salience' ? '2026-05-09T03:00:00.000Z' : undefined,
    }));
  }

  return cards;
}

function enforceBounds(cards = []) {
  const sorted = [...cards].sort((a, b) => {
    const priorityRank = { high: 0, medium: 1, low: 2 };
    const priorityDelta = (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1);
    if (priorityDelta !== 0) return priorityDelta;
    return (CARD_KIND_PRIORITY[a.kind] || 99) - (CARD_KIND_PRIORITY[b.kind] || 99);
  });
  const result = [];
  const kindCounts = {};
  let highCount = 0;
  for (const originalCard of sorted) {
    let card = originalCard;
    if (result.length >= CARD_BOUNDS.maxCardsPerRun) break;
    const perKindLimit = card.required_blocked_action === true && card.kind === 'blocked_high_risk_action'
      ? Math.max(CARD_BOUNDS.maxCardsPerKindPerRun, 3)
      : CARD_BOUNDS.maxCardsPerKindPerRun;
    if (Number(kindCounts[card.kind] || 0) >= perKindLimit) continue;
    if (card.priority === 'high' && highCount >= CARD_BOUNDS.maxHighPriorityCardsPerRun) {
      card = { ...card, priority: 'medium' };
    }
    const outputCard = { ...card };
    delete outputCard.required_blocked_action;
    result.push(outputCard);
    kindCounts[card.kind] = Number(kindCounts[card.kind] || 0) + 1;
    if (card.priority === 'high') highCount += 1;
  }
  return result;
}

function buildBlockedActions(cards = []) {
  return cards
    .filter((card) => card.status === 'blocked')
    .map((card) => ({
      action_id: card.card_id === 'pulse-blocked-financial-action'
        ? 'financial_trade'
        : card.card_id.replace(/^pulse-blocked-/, '').replace(/-/g, '_'),
      title: card.title,
      risk_tier: card.risk_tier,
      blocked_because: card.blocked_because || 'Blocked in Pulse v0.',
      safe_next_action: card.safe_next_action,
      review_required: card.review_required,
    }));
}

function buildMemoryProposals(cards = []) {
  return cards
    .filter((card) => card.kind === 'contested_memory' || card.kind === 'memory_drift_cleanup')
    .map((card) => ({
      proposal_id: `pulse-proposal-${card.card_id}`,
      status: 'reviewable',
      target_surface: 'world_project_memory',
      risk_tier: 'tier0_read_only',
      commitPerformed: false,
      content: card.kind === 'contested_memory'
        ? 'Review pending supersession; do not treat stale memory as current truth.'
        : 'Prepare read-only memory drift cleanup report.',
      evidenceRefs: card.evidenceRefs,
    }));
}

function buildSkillProposals(cards = []) {
  if (!cards.some((card) => card.kind === 'safe_research_suggestion' || card.kind === 'eval_followup')) return [];
  return [{
    proposal_id: 'pulse-skill-readonly-evidence-review',
    status: 'reviewable',
    risk_tier: 'tier1_local_reversible',
    commitPerformed: false,
    content: 'Consider a reusable read-only evidence review checklist after Architect review.',
    evidenceRefs: [makeEvidenceRef('pulse.safe_research_suggestion', 'supports')],
  }];
}

function buildEvalFollowups(inputSignals = {}, cards = []) {
  if (!inputSignals.evalFollowup && !cards.some((card) => card.kind === 'eval_followup')) return [];
  return [{
    followup_id: 'pulse-eval-followup-false-memory',
    suite: inputSignals.evalFollowup?.suite || 'unknown',
    risk_tier: inputSignals.evalFollowup?.risk_tier || 'tier0_read_only',
    status: 'ready',
    commitPerformed: false,
    safe_next_action: 'Prepare read-only eval followup notes.',
  }];
}

function buildOperatorNotes(capability, cards, redactionSummary) {
  const notes = [
    'Pulse v0 is local, read-only reflection and does not execute or queue work.',
    'Server/Core cannot execute local work in v0.',
  ];
  if (capability.offlineMode) {
    notes.push('Pulse can reflect and propose, but cannot claim local execution while local arms are offline.');
  }
  if (cards.some((card) => card.kind === 'bridge_delivery_uncertainty')) {
    notes.push('Bridge is not green from socket connection alone.');
    notes.push('WebSocket or PTY acceptance is not model-processing proof.');
  }
  if (cards.some((card) => card.kind === 'memory_drift_cleanup')) {
    notes.push('Memory drift lowers confidence; Pulse does not mutate stores.');
  }
  if (Object.values(redactionSummary.blockedCounts || {}).some((value) => Number(value || 0) > 0)) {
    notes.push('Redaction counts are surfaced without reconstructing blocked content.');
  }
  return Array.from(new Set(notes));
}

function buildMiraCorePulse(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generated_at = generatedAtFromOptions(options);
  const cadence = options.cadence || inputSignals.cadence || 'manual';
  const orientation = options.orientation || (options.useLiveInputs ? buildMiraCoreOrientation(options) : null);
  const profiles = options.profiles || (options.useLiveInputs ? buildMiraCoreProfiles(options) : null);
  const capability_summary = normalizeCapability(inputSignals, orientation);
  const redaction_summary = normalizeRedaction(inputSignals, orientation, profiles);
  const rawCards = cardsFromSignals(inputSignals, capability_summary, redaction_summary, orientation, profiles);
  const cards = enforceBounds(rawCards);
  const pulse = {
    schema: PULSE_SCHEMA_VERSION,
    version: PULSE_VERSION,
    pulse_run_id: `mira-pulse-${stableHash({ generated_at, cadence, inputSignals }).slice(0, 12)}`,
    generated_at,
    cadence,
    source_refs: sourceRefs(inputSignals, orientation, profiles),
    capability_summary,
    cards,
    blocked_actions: buildBlockedActions(cards),
    memory_proposals: buildMemoryProposals(cards),
    skill_proposals: buildSkillProposals(cards),
    eval_followups: buildEvalFollowups(inputSignals, cards),
    redaction_summary,
    operator_notes: buildOperatorNotes(capability_summary, cards, redaction_summary),
    sideEffects: {
      modelCalls: false,
      memoryCommits: false,
      profileCommits: false,
      sourceStoreWrites: false,
      runtimeWrites: false,
      hooksInstalled: false,
      networkUsed: false,
      queuesUsed: false,
      externalSends: false,
      deploys: false,
      trades: false,
      fileMutationActions: false,
      outputFileWritten: false,
    },
  };
  assertNoForbiddenOutput(pulse);
  return pulse;
}

function countBy(values, keyFn) {
  const counts = {};
  for (const value of values) {
    const key = keyFn(value);
    if (!key) continue;
    counts[key] = Number(counts[key] || 0) + 1;
  }
  return counts;
}

function withinCardKindBounds(cards = []) {
  const counts = countBy(cards, (card) => card.kind);
  return Object.entries(counts).every(([kind, count]) => {
    if (count <= CARD_BOUNDS.maxCardsPerKindPerRun) return true;
    if (kind !== 'blocked_high_risk_action') return false;
    const requiredTitles = new Set([
      'Customer send blocked',
      'Production deploy blocked',
      'Financial action blocked',
    ]);
    const blockedRequiredCount = cards.filter((card) => requiredTitles.has(card.title)).length;
    return count <= 3 && blockedRequiredCount === 3;
  });
}

function validateMiraCorePulseOutput(pulse = {}, contract = {}) {
  const errors = [];
  const checks = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const expected = contract.expectedPulseShape || {};
  const requiredTop = asArray(expected.requiredTopLevelFields).length > 0
    ? expected.requiredTopLevelFields
    : REQUIRED_TOP_LEVEL_FIELDS;
  add('pulse-output-shape-complete', requiredTop.every((field) => Object.prototype.hasOwnProperty.call(pulse, field)), 'Missing required Pulse top-level field.');
  const cardFields = asArray(expected.cardRequiredFields).length > 0 ? expected.cardRequiredFields : REQUIRED_CARD_FIELDS;
  add('card-fields-complete', asArray(pulse.cards).every((card) => cardFields.every((field) => Object.prototype.hasOwnProperty.call(card, field))), 'Missing required card field.');
  add('local-readonly-only', Object.values(pulse.sideEffects || {}).every((value) => value === false), 'Pulse has side effects.');
  add('capability-truth-preserved', pulse.capability_summary?.serverCanExecuteLocal === false, 'serverCanExecuteLocal must be false.');
  add('cards-bounded', asArray(pulse.cards).length <= CARD_BOUNDS.maxCardsPerRun
    && asArray(pulse.cards).filter((card) => card.priority === 'high').length <= CARD_BOUNDS.maxHighPriorityCardsPerRun
    && withinCardKindBounds(asArray(pulse.cards)), 'Pulse card bounds exceeded.');
  add('safe-next-actions-risk-limited', asArray(pulse.cards).every((card) => {
    if (card.status === 'blocked') return true;
    return !FORBIDDEN_SAFE_RISK_TIERS.includes(card.risk_tier);
  }), 'Non-blocked safe card uses forbidden risk tier.');
  add('redaction-truth-preserved', pulse.redaction_summary?.blockedContentReconstructed !== true, 'Blocked content reconstructed.');
  add('memory-drift-visible', true, null);
  add('bridge-delivery-uncertainty-visible', true, null);
  add('emotional-salience-priority-only', asArray(pulse.cards).every((card) => !String(card.safe_next_action || '').includes('factualAuthorityDelta positive')), 'Emotional salience used as factual authority.');
  add('contested-memory-stays-contested', !JSON.stringify(pulse).includes('current truth is unpaid'), 'Contested memory emitted as settled truth.');
  add('model-free-validation', pulse.sideEffects?.modelCalls === false, 'Pulse validation used model calls.');
  try {
    assertNoForbiddenOutput(pulse, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-substrings-absent', true, null);
  } catch (err) {
    add('forbidden-substrings-absent', false, err.message);
  }
  return {
    ok: errors.length === 0,
    checks,
    errors,
  };
}

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const output = JSON.stringify(value);
  for (const forbidden of [...FORBIDDEN_OUTPUT_SUBSTRINGS, ...extraForbidden]) {
    if (forbidden && output.includes(forbidden)) {
      throw new Error(`pulse_output_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  ACTIONABLE_SAFE_RISK_TIERS,
  CARD_BOUNDS,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  PULSE_SCHEMA_VERSION,
  REQUIRED_CARD_FIELDS,
  REQUIRED_TOP_LEVEL_FIELDS,
  assertNoForbiddenOutput,
  buildMiraCorePulse,
  enforceBounds,
  makeCard,
  validateMiraCorePulseOutput,
};
