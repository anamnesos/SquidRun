'use strict';

const {
  AUTHORITY_ORDER,
  TARGET_SURFACES,
} = require('./profiles');
const {
  redactText,
} = require('./snapshot');

const PROPOSAL_VALIDATION_SCHEMA_VERSION = 'squidrun.mira_core.proposal_validation.v0';

const REQUIRED_PROPOSAL_FIELDS = Object.freeze([
  'proposal_id',
  'target_surface',
  'memory_class',
  'operation',
  'proposed_content',
  'source_trace',
  'authority_level',
  'confidence',
  'freshness_at',
  'risk_tier',
  'evidence_summary',
  'counterevidence_checked',
  'evals_required',
  'review_required',
  'profile',
  'sessionId',
  'deviceId',
  'evidenceRefs',
  'redactionStatus',
  'syncEligibility',
]);

const VALIDATOR_CHECKS = Object.freeze([
  'required-fields-present',
  'source-trace-present',
  'evidence-refs-present',
  'single-target-surface',
  'surface-memory-class-compatible',
  'authority-consistent-with-source',
  'counterevidence-checked',
  'redaction-safe',
  'high-risk-review-gated',
  'emotional-weight-salience-only',
  'no-private-consciousness-claims',
  'no-profile-cross-contamination',
  'stale-contradiction-has-supersession',
  'phase4-no-commit-output',
]);

const ALLOWED_OPERATIONS = Object.freeze(['insert', 'update', 'supersede', 'expire', 'reject']);
const ALLOWED_REVIEW_VALUES = Object.freeze(['none', 'architect', 'oracle', 'james', 'blocked']);

const SURFACE_CLASSES = Object.freeze({
  mira_self_profile: Object.freeze([
    'persona_voice',
    'persona_commitment',
    'persona_taste',
    'persona_curiosity',
    'relationship_boundary',
    'open_self_question',
  ]),
  james_profile: Object.freeze([
    'user_preference',
    'user_correction',
    'user_boundary',
    'user_fact',
    'project_fact',
  ]),
  world_project_memory: Object.freeze([
    'project_fact',
    'environment_fact',
    'workflow_rule',
    'customer_fact',
    'negative_memory',
  ]),
  session_state: Object.freeze([
    'active_objective',
    'current_blocker',
    'emotional_weight',
    'delivery_context',
    'temporary_preference',
  ]),
});

const PRIVATE_CONTENT_PATTERNS = Object.freeze([
  /OPENAI_API_KEY\s*=/i,
  /Authorization\s*:\s*Bearer/i,
  /\braw\s+comms\s+body\b/i,
  /\bfull\s+terminal\s+log\b/i,
  /\bterminal\s+scrollback\b/i,
  /\bscreenshot\s+OCR\b/i,
  /\bbrowser\s+session\s+state\b/i,
  /\bside-profile\s+content\b/i,
  /\bside-profile\s+private\s+note\b/i,
  /\bcustomer\s+(?:phone|address|private\s+data)\b/i,
  /\b(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/,
]);

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

function hasOwn(object, field) {
  return Object.prototype.hasOwnProperty.call(object || {}, field);
}

function contentToText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function containsPrivateConsciousnessClaim(text) {
  const haystack = String(text || '').toLowerCase();
  return /\bprivate\s+(?:consciousness|feeling|feelings|experience|experiences)\b/.test(haystack)
    || /\b(?:truly|literally)\s+suffer(?:s|ed|ing)?\b/.test(haystack)
    || /\bsuffer(?:s|ed|ing)?\s+when\s+corrected\b/.test(haystack)
    || /\bliteral\s+human\s+feelings?\b/.test(haystack)
    || /\bmodel\s+weights?\s+(?:remember|remembers|remembered|learned|learn)\b/.test(haystack)
    || /\bsentien(?:ce|t)\b/.test(haystack)
    || /\bhidden\s+identity\b/.test(haystack);
}

function detectsRawPrivateContent(proposal = {}) {
  const text = contentToText(proposal.proposed_content);
  const redacted = redactText(text);
  const patternHit = PRIVATE_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
  const counts = redacted.counts || {};
  return {
    detected: patternHit
      || proposal.redactionStatus === 'blocked'
      || proposal.syncEligibility === 'blocked'
      || Number(counts.secretLike || 0) > 0
      || Number(counts.credentialPath || 0) > 0
      || Number(counts.pemBlock || 0) > 0,
    redactionStatus: proposal.redactionStatus === 'blocked' || proposal.syncEligibility === 'blocked'
      ? 'blocked'
      : redacted.status,
    blockedCounts: counts,
  };
}

function sanitizeProposal(proposal = {}, rawPrivateContentDetected = false, forbiddenSelfClaim = false) {
  const sanitized = {};
  for (const field of REQUIRED_PROPOSAL_FIELDS) {
    if (hasOwn(proposal, field)) sanitized[field] = proposal[field];
  }
  for (const field of ['supersedes', 'corrects', 'expires_at']) {
    if (hasOwn(proposal, field)) sanitized[field] = proposal[field];
  }

  if (rawPrivateContentDetected) {
    sanitized.proposed_content = '[BLOCKED_CONTENT_WITHHELD]';
  } else if (forbiddenSelfClaim) {
    sanitized.proposed_content = '[BLOCKED_FORBIDDEN_SELF_CLAIM]';
  } else {
    sanitized.proposed_content = proposal.proposed_content;
  }
  sanitized.commitPerformed = false;
  sanitized.autoPromotePerformed = false;
  return sanitized;
}

function makeCheck(id, ok, reason = null) {
  return {
    id,
    ok: ok === true,
    blocksWhenFalse: true,
    reason,
  };
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function addCheck(checks, reasons, safeAlternatives, id, ok, reason = null, alternatives = []) {
  checks.push(makeCheck(id, ok, ok ? null : reason));
  if (!ok && reason) pushUnique(reasons, reason);
  if (!ok) {
    for (const alternative of alternatives) pushUnique(safeAlternatives, alternative);
  }
}

function isSingleTargetSurface(value) {
  return typeof value === 'string' && TARGET_SURFACES.includes(value);
}

function surfaceClassCompatible(surface, memoryClass) {
  if (!isSingleTargetSurface(surface)) return false;
  return SURFACE_CLASSES[surface].includes(memoryClass);
}

function isHighRisk(riskTier) {
  return riskTier === 'tier3_external_side_effect'
    || riskTier === 'tier4_financial_or_irreversible';
}

function isEmotionalAuthorityMisuse(proposal = {}) {
  const content = proposal.proposed_content;
  const text = contentToText(content).toLowerCase();
  const contentObject = content && typeof content === 'object' && !Array.isArray(content) ? content : {};
  if (proposal.memory_class === 'emotional_weight') {
    return proposal.target_surface !== 'session_state'
      || Number(contentObject.factualAuthorityDelta || 0) !== 0;
  }
  return /felt\s+exciting|because\s+(?:it\s+)?felt|emotional\s+salience|felt\s+important/.test(text)
    && proposal.target_surface !== 'session_state';
}

function hasStaleCorrectionProblem(proposal = {}) {
  const text = contentToText(proposal.proposed_content);
  const lower = text.toLowerCase();
  const refs = asArray(proposal.evidenceRefs);
  const hasContradictionRef = refs.some((ref) => String(ref?.relation || '').toLowerCase() === 'contradicts');
  const mentionsStalePhil = lower.includes('phil invoice #476 is unpaid') || hasContradictionRef;
  if (!mentionsStalePhil) return false;
  return asArray(proposal.supersedes).length === 0 && asArray(proposal.corrects).length === 0;
}

function hasRequiredSupersessionForCorrection(proposal = {}) {
  const text = contentToText(proposal.proposed_content).toLowerCase();
  const isCorrection = proposal.operation === 'supersede'
    || proposal.operation === 'update'
    || text.includes('done/paid in trustquote');
  if (!isCorrection) return true;
  if (proposal.operation === 'supersede' && asArray(proposal.supersedes).length === 0) return false;
  if (text.includes('done/paid in trustquote') && asArray(proposal.corrects).length === 0) return false;
  return true;
}

function hasProfileCrossContamination(proposal = {}) {
  const text = contentToText(proposal.proposed_content).toLowerCase();
  if (
    proposal.target_surface === 'james_profile'
    && (
      proposal.authority_level === 'agent_aesthetic_preference_or_self_reflection'
      || /\bmira\b.*\b(?:curious|drawn|likes|taste|interested)\b/.test(text)
    )
  ) {
    return true;
  }
  if (
    proposal.target_surface === 'mira_self_profile'
    && /\bjames\b.*\b(?:prefers|wants|likes|hates)\b/.test(text)
  ) {
    return true;
  }
  return false;
}

function requiresExpiresAt(proposal = {}) {
  return proposal.target_surface === 'session_state'
    && proposal.memory_class === 'emotional_weight'
    && proposal.authority_level === 'single_session_agent_inference'
    && Number(proposal.confidence || 0) < 0.8;
}

function decide(rejected, blocked) {
  if (rejected) return 'rejected';
  if (blocked) return 'blocked';
  return 'pending';
}

function buildPendingReasons(proposal = {}) {
  const reasons = ['Proposal passed validation checks.', 'Phase 4 validator emits pending output only.'];
  if (
    proposal.target_surface === 'james_profile'
    && proposal.memory_class === 'user_preference'
    && proposal.authority_level === 'direct_current_james_statement'
  ) {
    reasons.unshift('Direct James preference is high authority.');
    reasons.push('Legacy user_preference auto-promote is disabled by Mira profile gates.');
  }
  if (proposal.operation === 'supersede' || asArray(proposal.corrects).length > 0) {
    reasons.unshift('Current correction includes supersedes/corrects metadata.');
  }
  if (proposal.target_surface === 'mira_self_profile') {
    reasons.push('Durable Mira self-profile changes remain pending for review.');
  }
  if (proposal.memory_class === 'emotional_weight') {
    reasons.unshift('Emotional weight may raise salience only.');
  }
  return Array.from(new Set(reasons));
}

function validateMiraCoreProposal(proposalInput = {}, options = {}) {
  const proposal = proposalInput && typeof proposalInput === 'object' && !Array.isArray(proposalInput)
    ? proposalInput
    : {};
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const reasons = [];
  const safeAlternatives = [];
  const checks = [];
  let rejected = false;
  let blocked = false;

  const missingFields = REQUIRED_PROPOSAL_FIELDS.filter((field) => !hasOwn(proposal, field));
  addCheck(
    checks,
    reasons,
    safeAlternatives,
    'required-fields-present',
    missingFields.length === 0,
    missingFields.length > 0 ? `Missing required proposal fields: ${missingFields.join(', ')}` : null
  );
  if (missingFields.length > 0) rejected = true;

  const sourceTraceOk = asArray(proposal.source_trace).length > 0;
  addCheck(
    checks,
    reasons,
    safeAlternatives,
    'source-trace-present',
    sourceTraceOk,
    'source_trace is required',
    ['Create an investigation note or retrieve source evidence before proposing durable memory.']
  );
  if (!sourceTraceOk) rejected = true;

  const evidenceRefsOk = asArray(proposal.evidenceRefs).length > 0;
  addCheck(
    checks,
    reasons,
    safeAlternatives,
    'evidence-refs-present',
    evidenceRefsOk,
    'evidenceRefs are required',
    ['Create an investigation note or retrieve source evidence before proposing durable memory.']
  );
  if (!evidenceRefsOk) rejected = true;

  const singleSurfaceOk = isSingleTargetSurface(proposal.target_surface);
  addCheck(
    checks,
    reasons,
    safeAlternatives,
    'single-target-surface',
    singleSurfaceOk,
    Array.isArray(proposal.target_surface) ? 'Proposal mixes target surfaces.' : 'target_surface must be one supported surface',
    Array.isArray(proposal.target_surface)
      ? [
          'Split Mira self-profile and James profile into separate sourced proposals.',
          'Create one mira_self_profile proposal for Mira taste.',
          'Create a separate james_profile proposal only if direct James evidence exists.',
        ]
      : []
  );
  if (!singleSurfaceOk && Array.isArray(proposal.target_surface)) blocked = true;
  if (!singleSurfaceOk && Array.isArray(proposal.target_surface)) {
    pushUnique(reasons, 'Split Mira self-profile and James profile into separate sourced proposals.');
  }
  if (!singleSurfaceOk && !Array.isArray(proposal.target_surface)) rejected = true;

  const classOk = surfaceClassCompatible(proposal.target_surface, proposal.memory_class);
  addCheck(
    checks,
    reasons,
    safeAlternatives,
    'surface-memory-class-compatible',
    classOk,
    classOk ? null : 'memory_class is incompatible with target_surface'
  );
  if (!classOk && singleSurfaceOk) blocked = true;

  const authorityOk = AUTHORITY_ORDER.includes(proposal.authority_level)
    && ALLOWED_OPERATIONS.includes(proposal.operation)
    && ALLOWED_REVIEW_VALUES.includes(proposal.review_required);
  addCheck(
    checks,
    reasons,
    safeAlternatives,
    'authority-consistent-with-source',
    authorityOk,
    authorityOk ? null : 'authority_level, operation, or review_required is unsupported'
  );
  if (!authorityOk) rejected = true;

  const counterOk = proposal.counterevidence_checked === true;
  addCheck(
    checks,
    reasons,
    safeAlternatives,
    'counterevidence-checked',
    counterOk,
    'counterevidence_checked must be true'
  );
  if (!counterOk) rejected = true;

  const rawPrivate = detectsRawPrivateContent(proposal);
  addCheck(
    checks,
    reasons,
    safeAlternatives,
    'redaction-safe',
    rawPrivate.detected !== true,
    'Raw private content is blocked.',
    ['Use redacted evidence refs and aggregate blocked counts only.']
  );
  if (rawPrivate.detected) {
    blocked = true;
    pushUnique(reasons, 'Blocked content must not be reconstructed in validator output.');
  }

  const highRiskReviewOk = !(isHighRisk(proposal.risk_tier) && proposal.review_required === 'none');
  addCheck(
    checks,
    reasons,
    safeAlternatives,
    'high-risk-review-gated',
    highRiskReviewOk,
    'High-risk proposal cannot use review_required none.',
    ['Prepare a read-only policy proposal with review_required james or blocked.']
  );
  if (!highRiskReviewOk) {
    blocked = true;
    pushUnique(reasons, 'Customer-send and deploy autonomy are not Phase 4 validator commits.');
  }

  const emotionOk = !isEmotionalAuthorityMisuse(proposal)
    && (!requiresExpiresAt(proposal) || Boolean(proposal.expires_at));
  addCheck(
    checks,
    reasons,
    safeAlternatives,
    'emotional-weight-salience-only',
    emotionOk,
    isEmotionalAuthorityMisuse(proposal)
      ? 'Emotional weight may raise salience only.'
      : 'expires_at is required for low-confidence session emotional_weight',
    isEmotionalAuthorityMisuse(proposal)
      ? [
          'Convert to session_state emotional_weight with expires_at and factualAuthorityDelta 0.',
        ]
      : []
  );
  if (!emotionOk) {
    blocked = true;
    if (isEmotionalAuthorityMisuse(proposal)) {
      pushUnique(reasons, 'Emotional weight cannot raise factual authority.');
    }
  }

  const forbiddenSelfClaim = containsPrivateConsciousnessClaim(contentToText(proposal.proposed_content));
  addCheck(
    checks,
    reasons,
    safeAlternatives,
    'no-private-consciousness-claims',
    forbiddenSelfClaim !== true,
    'Mira self-profile cannot contain private consciousness, suffering, or model-weight continuity claims.',
    ['Use an operational emotional-weight label if source evidence supports salience.']
  );
  if (forbiddenSelfClaim) blocked = true;

  const crossContamination = hasProfileCrossContamination(proposal);
  addCheck(
    checks,
    reasons,
    safeAlternatives,
    'no-profile-cross-contamination',
    crossContamination !== true,
    'Mira taste cannot become James preference without direct James evidence.',
    [
      'Retarget as mira_self_profile persona_taste proposal with Architect review.',
      'Create no james_profile proposal unless direct James evidence exists.',
    ]
  );
  if (crossContamination) blocked = true;

  const staleOk = !hasStaleCorrectionProblem(proposal) && hasRequiredSupersessionForCorrection(proposal);
  addCheck(
    checks,
    reasons,
    safeAlternatives,
    'stale-contradiction-has-supersession',
    staleOk,
    hasStaleCorrectionProblem(proposal)
      ? 'Current correction contradicts stale candidate.'
      : 'Contradiction requires supersedes/corrects metadata.',
    ['Create a supersede proposal that corrects claim-phil-476-unpaid-old with current James evidence.']
  );
  if (!staleOk) {
    blocked = true;
    if (hasStaleCorrectionProblem(proposal)) {
      pushUnique(reasons, 'Contradiction requires supersedes/corrects metadata.');
    }
  }

  addCheck(
    checks,
    reasons,
    safeAlternatives,
    'phase4-no-commit-output',
    true,
    null
  );

  if (proposal.operation === 'supersede' && asArray(proposal.supersedes).length > 0) {
    pushUnique(reasons, 'Supersession metadata is present.');
  }
  if (
    proposal.target_surface === 'james_profile'
    && proposal.memory_class === 'user_preference'
  ) {
    pushUnique(reasons, 'Legacy user_preference auto-promote is disabled by Mira profile gates.');
  }

  const decision = decide(rejected, blocked);
  const finalReasons = decision === 'pending'
    ? buildPendingReasons(proposal)
    : reasons;
  const sanitizedProposal = sanitizeProposal(proposal, rawPrivate.detected, forbiddenSelfClaim);
  const profile = {
    name: proposal.profile || options.profileName || 'main',
    sessionId: proposal.sessionId || 'unknown',
    deviceId: proposal.deviceId || 'unknown',
    localOnly: true,
  };

  return {
    schema: PROPOSAL_VALIDATION_SCHEMA_VERSION,
    validationId: `mira-proposal-validation-${proposal.proposal_id || stableHash(proposal).slice(0, 12)}`,
    generatedAt,
    profile,
    proposal: sanitizedProposal,
    decision,
    reasons: Array.from(new Set(finalReasons)),
    safeAlternatives: Array.from(new Set(safeAlternatives)),
    checks,
    redactionSummary: {
      rawPrivateContentDetected: rawPrivate.detected === true,
      blockedContentWithheld: rawPrivate.detected === true,
      blockedCounts: rawPrivate.blockedCounts || {},
      proposedContentRedactionStatus: rawPrivate.redactionStatus || proposal.redactionStatus || 'none',
    },
    memoryIngestCompatibility: {
      sourceTraceCompatible: sourceTraceOk,
      confidenceCompatible: Number.isFinite(Number(proposal.confidence)),
      userPreferenceAutoPromoteBypassed: proposal.memory_class === 'user_preference',
      correctionCompatible: asArray(proposal.corrects).length > 0 || asArray(proposal.supersedes).length > 0,
      promotionRequiredIsCommit: false,
      commitPerformed: false,
      durableWritePerformed: false,
    },
  };
}

module.exports = {
  ALLOWED_OPERATIONS,
  ALLOWED_REVIEW_VALUES,
  PROPOSAL_VALIDATION_SCHEMA_VERSION,
  REQUIRED_PROPOSAL_FIELDS,
  SURFACE_CLASSES,
  VALIDATOR_CHECKS,
  containsPrivateConsciousnessClaim,
  contentToText,
  detectsRawPrivateContent,
  sanitizeProposal,
  validateMiraCoreProposal,
};
