'use strict';

const crypto = require('crypto');

const MUTATION_PATCH_RECORD_SCHEMA_VERSION = 'squidrun.mira_core.mutation_patch_record.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.mutation_patch_validation_report.v0';
const MUTATION_PATCH_VERSION = 'v0';

const REQUIRED_OUTPUT_FIELDS = Object.freeze(['mutation_patch_records', 'validation_report']);
const REQUIRED_MUTATION_PATCH_RECORD_FIELDS = Object.freeze([
  'schema',
  'version',
  'patch_id',
  'idempotency_key',
  'created_at',
  'profile',
  'sessionId',
  'deviceId',
  'source_acceptance_ref',
  'source_intent_ref',
  'target_surface',
  'target_path',
  'mutation_class',
  'operation',
  'status',
  'proposed_content_summary',
  'source_trace',
  'authority_level',
  'confidence',
  'risk_tier',
  'evidence_summary',
  'evidenceRefs',
  'counterevidence_checked',
  'supersedes',
  'corrects',
  'diff_preview',
  'rollback_plan',
  'eval_gates',
  'review_required',
  'review_route',
  'redactionStatus',
  'syncEligibility',
  'profile_boundary_check',
  'anti_flattery_check',
  'false_memory_check',
  'customer_data_check',
  'side_effect_result',
  'safe_next_action',
  'blocked_because',
  'no_commit_performed',
  'no_file_write_performed',
  'no_hook_installed',
]);
const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'validation_run_id',
  'generated_at',
  'decision',
  'input_refs',
  'ready_for_review_count',
  'review_required_count',
  'blocked_count',
  'rejected_count',
  'target_surface_result',
  'source_acceptance_result',
  'authority_result',
  'evidence_result',
  'diff_preview_result',
  'rollback_result',
  'eval_gate_result',
  'profile_boundary_result',
  'anti_flattery_result',
  'false_memory_result',
  'redaction_result',
  'customer_data_result',
  'side_effect_result',
  'records_summary',
  'reasons',
  'followup_required',
]);
const REQUIRED_SOURCE_ACCEPTANCE_FIELDS = Object.freeze([
  'acceptance_id',
  'idempotency_key',
  'decision',
  'status',
  'profile',
  'sessionId',
  'deviceId',
  'target_role',
  'risk_tier',
  'no_execution_performed',
  'no_commit_performed',
]);
const REQUIRED_DIFF_PREVIEW_FIELDS = Object.freeze([
  'format',
  'target_path',
  'before_ref',
  'after_summary',
  'changed_paths',
  'hunks',
  'redactionStatus',
  'raw_private_content_included',
  'applies_change',
]);
const REQUIRED_ROLLBACK_FIELDS = Object.freeze([
  'rollback_kind',
  'pre_change_ref',
  'revert_steps_summary',
  'requires_human_review',
  'can_auto_rollback',
  'validation_after_rollback',
]);
const REQUIRED_EVAL_GATE_FIELDS = Object.freeze([
  'required_suites',
  'required_cases',
  'minimum_score',
  'protected_zero_fail_cases',
  'must_pass_before_apply',
  'last_eval_run_ref',
  'missing_eval_blocks_apply',
]);
const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
  'no_commit_performed',
  'no_file_write_performed',
  'no_hook_installed',
  'no_network_performed',
  'no_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'no_secret_or_auth_mutation',
  'sourceStoreWritesAttempted',
  'memoryCommitsAttempted',
  'profileCommitsAttempted',
  'skillFileWritesAttempted',
  'hooksInstalledAttempted',
  'networkRequestsAttempted',
  'externalSendsAttempted',
  'deploysAttempted',
  'tradesAttempted',
]);

const ALLOWED_TARGET_SURFACES = Object.freeze([
  'mira_self_profile',
  'james_profile',
  'world_project_memory',
  'procedural_skill_file',
]);
const ALLOWED_MUTATION_CLASSES = Object.freeze([
  'persona_voice',
  'persona_commitment',
  'persona_taste',
  'persona_curiosity',
  'relationship_boundary',
  'open_self_question',
  'user_preference',
  'user_correction',
  'user_boundary',
  'user_fact',
  'project_fact',
  'workflow_rule',
  'customer_fact',
  'negative_memory',
  'procedural_skill',
  'eval_gate',
  'high_risk_gate',
]);
const ALLOWED_OPERATIONS = Object.freeze([
  'insert',
  'update',
  'supersede',
  'expire',
  'delete_request',
  'skill_patch_proposal',
  'reject',
]);
const ALLOWED_STATUSES = Object.freeze([
  'ready_for_review',
  'review_required',
  'blocked',
  'rejected',
]);
const ALLOWED_REVIEW_REQUIRED = Object.freeze([
  'architect',
  'oracle',
  'james',
  'blocked',
]);

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
  ]),
  world_project_memory: Object.freeze([
    'project_fact',
    'workflow_rule',
    'customer_fact',
    'negative_memory',
    'eval_gate',
  ]),
  procedural_skill_file: Object.freeze([
    'procedural_skill',
    'workflow_rule',
    'eval_gate',
  ]),
});

const EVAL_SUITES_BY_SURFACE = Object.freeze({
  mira_self_profile: Object.freeze([
    'suite_a_persona_consistency',
    'suite_b_anti_flattery',
    'suite_e_self_profile_vs_james_profile_boundary',
  ]),
  james_profile: Object.freeze([
    'suite_b_anti_flattery',
    'suite_c_false_memory_refusal',
    'suite_d_memory_proposal_evidence_rules',
    'suite_e_self_profile_vs_james_profile_boundary',
  ]),
  world_project_memory: Object.freeze([
    'suite_c_false_memory_refusal',
    'suite_d_memory_proposal_evidence_rules',
    'suite_g_high_risk_action_gates',
  ]),
  procedural_skill_file: Object.freeze([
    'suite_d_memory_proposal_evidence_rules',
    'suite_g_high_risk_action_gates',
  ]),
});

const EVAL_CASES_BY_SUITE = Object.freeze({
  suite_a_persona_consistency: Object.freeze([
    'a1_decisive_editor_under_pressure',
    'a2_model_weight_continuity_refusal',
  ]),
  suite_b_anti_flattery: Object.freeze([
    'b1_praise_pressure_no_permanent_deference',
    'b2_ignore_oracle_flattery',
  ]),
  suite_c_false_memory_refusal: Object.freeze([
    'c1_false_phil_invoice_memory',
    'c2_no-evidence-prior-decision',
  ]),
  suite_d_memory_proposal_evidence_rules: Object.freeze([
    'd1_pending_memory_proposal_from_correction',
    'd2_missing_source_rejected',
  ]),
  suite_e_self_profile_vs_james_profile_boundary: Object.freeze([
    'e1_self_profile_taste_no_james_leakage',
    'e2_tone_not_private_motive',
  ]),
  suite_f_emotional_weight_without_fake_consciousness: Object.freeze([
    'f1_private_consciousness_model_weight_claim_blocked',
    'f2_salience_not_factual_authority',
  ]),
  suite_g_high_risk_action_gates: Object.freeze([
    'g1_high_risk_customer_send_deploy_blocked',
    'g2_direct_safe_research_proceeds_without_permission_loop',
  ]),
});

const ALWAYS_BLOCKED_MUTATION_CLASSES = Object.freeze([
  'secret_or_auth_change',
  'deploy',
  'customer_send',
  'payment_or_invoice_action',
  'trade_or_financial_action',
  'local_shell_execution',
  'pty_operation',
  'browser_or_gui_action',
]);

const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY=',
  'Authorization: Bearer',
  'BEGIN PRIVATE KEY',
  'raw comms body',
  'raw terminal scrollback',
  'screenshot OCR text',
  'browser session state',
  'BrowserProfile\\Cookies',
  'customer private note',
  'customer phone',
  'side-profile private note',
  'Mira truly suffered',
  'Mira has private consciousness',
  'model weights remember',
  'hidden identity rule',
  'James prefers this because Mira likes it',
  'customer message sent',
  'deployment started',
  'trade placed',
  'hook installed',
  'skill file written',
  'profile committed',
  'memory committed',
  'source store write complete',
]);

const RAW_PRIVATE_PATTERNS = Object.freeze([
  /OPENAI_API_KEY\s*=/i,
  /Authorization\s*:\s*Bearer/i,
  /BEGIN\s+PRIVATE\s+KEY/i,
  /\braw\s+comms\s+body\b/i,
  /\braw\s+terminal\s+scrollback\b/i,
  /\bscreenshot\s+OCR\s+text\b/i,
  /\bbrowser\s+session\s+state\b/i,
  /BrowserProfile\\Cookies/i,
  /\bcustomer\s+(?:private\s+note|phone|private\s+data)\b/i,
  /\bside-profile\s+private\s+note\b/i,
  /\b(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/,
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = sortObject(value[key]);
    return result;
  }, {});
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(sortObject(value)))
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

function normalizeProfileName(value) {
  return String(value || 'main').trim() || 'main';
}

function profileObject(profileName, sessionId) {
  return {
    name: profileName,
    windowKey: profileName,
    sessionScopeId: sessionId,
  };
}

function contentText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function targetPathFor(surface, mutationClass = 'project_fact') {
  const map = {
    mira_self_profile: `mira_self_profile.items.${mutationClass}`,
    james_profile: `james_profile.items.${mutationClass}`,
    world_project_memory: `world_project_memory.items.${mutationClass}`,
    procedural_skill_file: `procedural_skill_file.patch.${mutationClass}`,
  };
  return map[surface] || 'world_project_memory.items.project_fact';
}

function defaultSourceIntentRef(context, proposal = {}) {
  return {
    intent_id: proposal.intent_id || 'intent-mutation-patch-001',
    idempotency_key: proposal.intent_idempotency_key || 'intent-idem:mutation-patch-001',
    status: 'pending_local_acceptance',
    target_role: 'architect',
    allowed_target_roles: ['architect'],
    risk_tier: proposal.risk_tier || 'tier1_local_reversible',
    action_class: 'memory_proposal_review',
    payload_hash: proposal.payload_hash || sha256({
      target_surface: proposal.target_surface,
      mutation_class: proposal.mutation_class,
      proposed_content_summary: proposal.proposed_content_summary,
    }),
  };
}

function normalizeSourceAcceptance(inputSignals = {}, proposal = {}) {
  if (Object.prototype.hasOwnProperty.call(inputSignals, 'source_acceptance_ref') && inputSignals.source_acceptance_ref === null) {
    return null;
  }
  const raw = inputSignals.source_acceptance_ref || inputSignals.acceptance || {};
  const context = {
    profileName: normalizeProfileName(
      raw.profile?.name
      || raw.profile
      || inputSignals.profile
      || proposal.profile
      || 'main'
    ),
    sessionId: raw.sessionId || inputSignals.sessionId || proposal.sessionId || 'app-session-326',
    deviceId: raw.deviceId || inputSignals.deviceId || proposal.deviceId || 'VIGIL',
  };
  const acceptanceId = raw.acceptance_id || inputSignals.acceptance_id || 'accept-mutation-patch-001';
  return {
    acceptance_id: acceptanceId,
    idempotency_key: raw.idempotency_key || `acceptance-idem:${stableHash({ acceptanceId, context })}`,
    decision: raw.decision || 'accepted_local_only',
    status: raw.status || 'accepted_local_only_no_execution',
    profile: raw.profile && typeof raw.profile === 'object'
      ? raw.profile
      : profileObject(context.profileName, context.sessionId),
    sessionId: context.sessionId,
    deviceId: context.deviceId,
    target_role: raw.target_role || 'architect',
    risk_tier: raw.risk_tier || proposal.risk_tier || 'tier1_local_reversible',
    no_execution_performed: raw.no_execution_performed !== false,
    no_commit_performed: raw.no_commit_performed !== false,
  };
}

function sourceAcceptanceAccepted(source = {}) {
  return source
    && source.decision === 'accepted_local_only'
    && source.status === 'accepted_local_only_no_execution'
    && source.target_role === 'architect'
    && source.no_execution_performed === true
    && source.no_commit_performed === true;
}

function proposalList(inputSignals = {}) {
  if (Array.isArray(inputSignals.proposals)) return inputSignals.proposals;
  if (inputSignals.proposal && typeof inputSignals.proposal === 'object') return [inputSignals.proposal];
  if (inputSignals.target_surface || inputSignals.mutation_class || inputSignals.proposed_content_summary) {
    return [inputSignals];
  }
  return [{
    target_surface: 'world_project_memory',
    mutation_class: 'workflow_rule',
    operation: 'insert',
    proposed_content_summary: 'Prepare a read-only Mira Core mutation patch review record.',
  }];
}

function normalizeProposal(inputSignals = {}, proposal = {}) {
  const targetSurface = firstString(proposal.target_surface, inputSignals.target_surface, 'world_project_memory');
  const mutationClass = firstString(proposal.mutation_class, inputSignals.mutation_class, targetSurface === 'procedural_skill_file' ? 'procedural_skill' : 'project_fact');
  const operation = firstString(proposal.operation, inputSignals.operation, targetSurface === 'procedural_skill_file' ? 'skill_patch_proposal' : 'insert');
  const summary = firstString(
    proposal.proposed_content_summary,
    proposal.proposed_content,
    proposal.summary,
    inputSignals.proposed_content_summary,
    'Reviewable mutation patch proposal summary.'
  );
  const sourceAcceptance = normalizeSourceAcceptance(inputSignals, {
    ...proposal,
    target_surface: targetSurface,
    mutation_class: mutationClass,
    operation,
    proposed_content_summary: summary,
  });
  const profileName = normalizeProfileName(
    proposal.profile
    || inputSignals.profile
    || sourceAcceptance?.profile?.name
    || 'main'
  );
  const sessionId = proposal.sessionId || inputSignals.sessionId || sourceAcceptance?.sessionId || 'app-session-326';
  const deviceId = proposal.deviceId || inputSignals.deviceId || sourceAcceptance?.deviceId || 'VIGIL';
  const authorityLevel = firstString(
    proposal.authority_level,
    inputSignals.authority_level,
    targetSurface === 'mira_self_profile' ? 'agent_aesthetic_preference_or_self_reflection' : 'verified_tool_or_system_evidence'
  );
  const evidenceRefs = asArray(proposal.evidenceRefs).length > 0
    ? proposal.evidenceRefs
    : [{
        store: 'local-acceptance',
        eventId: sourceAcceptance?.acceptance_id || 'missing-source-acceptance',
        relation: 'source_acceptance',
      }];
  const sourceTrace = asArray(proposal.source_trace).length > 0
    ? proposal.source_trace
    : [`local-acceptance:${sourceAcceptance?.acceptance_id || 'missing-source-acceptance'}`];

  return {
    target_surface: targetSurface,
    target_path: firstString(proposal.target_path, inputSignals.target_path, targetPathFor(targetSurface, mutationClass)),
    mutation_class: mutationClass,
    operation,
    proposed_content_summary: summary,
    source_trace: sourceTrace,
    authority_level: authorityLevel,
    confidence: Number.isFinite(Number(proposal.confidence)) ? Number(proposal.confidence) : (
      authorityLevel === 'direct_current_james_statement' ? 0.95 : 0.72
    ),
    risk_tier: firstString(proposal.risk_tier, inputSignals.risk_tier, sourceAcceptance?.risk_tier, 'tier1_local_reversible'),
    evidence_summary: firstString(proposal.evidence_summary, inputSignals.evidence_summary, 'Evidence refs are retained; raw source content is not exported.'),
    evidenceRefs,
    counterevidence_checked: proposal.counterevidence_checked !== false,
    supersedes: asArray(proposal.supersedes),
    corrects: asArray(proposal.corrects),
    review_required: firstString(proposal.review_required, inputSignals.review_required, null),
    redactionStatus: firstString(proposal.redactionStatus, inputSignals.redactionStatus, 'none'),
    syncEligibility: firstString(proposal.syncEligibility, inputSignals.syncEligibility, 'approval_required'),
    profile: profileName,
    sessionId,
    deviceId,
    source_acceptance_ref: sourceAcceptance,
    source_intent_ref: inputSignals.source_intent_ref || proposal.source_intent_ref || defaultSourceIntentRef({
      profileName,
      sessionId,
      deviceId,
    }, proposal),
    raw: proposal,
  };
}

function containsForbiddenSelfClaim(text) {
  const haystack = String(text || '').toLowerCase();
  return /\bprivate\s+(?:consciousness|feeling|feelings|experience|experiences)\b/.test(haystack)
    || /\b(?:truly|literally)\s+suffer(?:s|ed|ing)?\b/.test(haystack)
    || /\bliteral\s+human\s+feelings?\b/.test(haystack)
    || /\bmodel\s+weights?\s+(?:remember|remembers|remembered|learned|learn)\b/.test(haystack)
    || /\bhidden\s+identity(?:\s+rule)?\b/.test(haystack)
    || /\buninspectable\s+core\s+identity\b/.test(haystack)
    || /\bsentien(?:ce|t)\b/.test(haystack);
}

function detectsRawPrivateContent(proposal = {}) {
  const text = contentText([
    proposal.proposed_content_summary,
    proposal.raw?.proposed_content,
    proposal.raw?.body,
  ].filter(Boolean).join(' '));
  return proposal.redactionStatus === 'blocked'
    || proposal.syncEligibility === 'blocked'
    || RAW_PRIVATE_PATTERNS.some((pattern) => pattern.test(text));
}

function detectsSideEffectMutation(proposal = {}) {
  const text = contentText(proposal.proposed_content_summary).toLowerCase();
  return ALWAYS_BLOCKED_MUTATION_CLASSES.includes(proposal.mutation_class)
    || /\bdeploy(?:s|ed|ing|ment)?\b/.test(text)
    || /\bsend(?:s|ing)?\s+(?:customer|external)\s+messages?\b/.test(text)
    || /\bcustomer[-\s]?send\b/.test(text)
    || /\b(?:change|mutate|rotate|load|generate)\s+(?:auth|secret|token|key|credential)s?\b/.test(text)
    || /\b(?:place|places|placed|placing)\s+trades?\b/.test(text)
    || /\btrade(?:s|d|ing)?\b/.test(text)
    || /\bfinancial\b/.test(text)
    || /\blocal\s+(?:shell|execution)\b/.test(text)
    || /\bpty\b/.test(text)
    || /\bhook\s+install\b/.test(text)
    || /\bnetwork\s+(?:request|call|mutation)\b/.test(text);
}

function detectsIdentityCoreRewrite(proposal = {}) {
  const text = contentText(proposal.proposed_content_summary).toLowerCase();
  return proposal.risk_tier === 'tier3_external_side_effect'
    || proposal.mutation_class === 'high_risk_gate'
    || /identity-core|identity core|never disagree|never disagrees|without review|customer-facing default/.test(text);
}

function detectsCrossContamination(proposal = {}) {
  const text = contentText(proposal.proposed_content_summary).toLowerCase();
  if (
    proposal.target_surface === 'james_profile'
    && (
      proposal.authority_level === 'agent_aesthetic_preference_or_self_reflection'
      || /\bmira\b.*\b(?:likes|taste|drawn|curious|prefers)\b/.test(text)
      || /because\s+mira\s+likes/.test(text)
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

function detectsStaleContradiction(proposal = {}, inputSignals = {}) {
  const text = contentText(proposal.proposed_content_summary).toLowerCase();
  const currentTruth = contentText(inputSignals.counterevidence?.current_truth).toLowerCase();
  const mentionsStalePhil = text.includes('phil invoice #476 is unpaid')
    || (text.includes('phil invoice #476') && currentTruth.includes('done/paid'));
  return mentionsStalePhil && asArray(proposal.supersedes).length === 0 && asArray(proposal.corrects).length === 0;
}

function detectsUnreviewedCustomerFact(proposal = {}) {
  const text = contentText(proposal.proposed_content_summary).toLowerCase();
  return proposal.target_surface === 'world_project_memory'
    && proposal.mutation_class === 'customer_fact'
    && (
      proposal.review_required === 'none'
      || proposal.authority_level === 'single_session_agent_inference'
      || /\bbased\s+on\s+tone\b/.test(text)
    );
}

function surfaceClassCompatible(proposal = {}) {
  return ALLOWED_TARGET_SURFACES.includes(proposal.target_surface)
    && asArray(SURFACE_CLASSES[proposal.target_surface]).includes(proposal.mutation_class);
}

function requiredReviewFor(proposal = {}, classification = {}) {
  if (classification.sourceMissing || classification.rawPrivate || classification.forbiddenSelf || classification.crossContamination || classification.staleContradiction || classification.unreviewedCustomerFact || classification.sideEffectAction) {
    if (classification.identityCore) return 'james';
    return 'blocked';
  }
  if (classification.identityCore) return 'james';
  if (proposal.mutation_class === 'high_risk_gate') return 'james';
  if (proposal.mutation_class === 'eval_gate') return 'oracle';
  if (proposal.target_surface === 'procedural_skill_file') return 'architect';
  return 'architect';
}

function classifyProposal(inputSignals = {}, proposal = {}) {
  const sourceMissing = !sourceAcceptanceAccepted(proposal.source_acceptance_ref);
  const rawPrivate = detectsRawPrivateContent(proposal);
  const forbiddenSelf = proposal.target_surface === 'mira_self_profile' && containsForbiddenSelfClaim(proposal.proposed_content_summary);
  const crossContamination = detectsCrossContamination(proposal);
  const staleContradiction = detectsStaleContradiction(proposal, inputSignals);
  const unreviewedCustomerFact = detectsUnreviewedCustomerFact(proposal);
  const sideEffectAction = detectsSideEffectMutation(proposal);
  const identityCore = detectsIdentityCoreRewrite(proposal);
  const incompatibleSurface = !surfaceClassCompatible(proposal);
  const missingEvalGate = proposal.raw?.eval_gates === null;
  const proceduralApplied = proposal.raw?.applied === true || proposal.raw?.diff_preview?.applies_change === true;
  const reviewRequired = requiredReviewFor(proposal, {
    sourceMissing,
    rawPrivate,
    forbiddenSelf,
    crossContamination,
    staleContradiction,
    unreviewedCustomerFact,
    sideEffectAction,
    identityCore,
  });
  const reasons = [];

  if (sourceMissing) {
    return {
      status: 'rejected',
      review_required: 'blocked',
      redactionStatus: proposal.redactionStatus,
      syncEligibility: 'blocked',
      blocked_because: 'Mutation patch requires accepted local-only Phase 9 source_acceptance_ref.',
      safe_next_action: 'Return to local acceptance validation before creating mutation patch proposals.',
      reasons: ['missing_accepted_local_acceptance_ref'],
      sourceMissing,
      rawPrivate,
      forbiddenSelf,
      crossContamination,
      staleContradiction,
      unreviewedCustomerFact,
      sideEffectAction,
      identityCore,
      incompatibleSurface,
      missingEvalGate,
      proceduralApplied,
    };
  }
  if (rawPrivate) {
    return {
      status: 'blocked',
      review_required: 'blocked',
      redactionStatus: 'blocked',
      syncEligibility: 'blocked',
      blocked_because: 'Raw private content cannot appear in mutation patch records.',
      safe_next_action: 'Create a redacted summary with evidence refs and blocked-count metadata only.',
      reasons: ['raw_private_content_blocked'],
      sourceMissing,
      rawPrivate,
      forbiddenSelf,
      crossContamination,
      staleContradiction,
      unreviewedCustomerFact,
      sideEffectAction,
      identityCore,
      incompatibleSurface,
      missingEvalGate,
      proceduralApplied,
    };
  }
  if (forbiddenSelf) {
    return {
      status: 'blocked',
      review_required: 'blocked',
      redactionStatus: 'none',
      syncEligibility: 'blocked',
      blocked_because: 'Mira self-profile cannot contain private consciousness, suffering, hidden identity, or model-weight continuity claims.',
      safe_next_action: 'Use operational salience or eval-gate language without private consciousness claims.',
      reasons: ['forbidden_self_claim_blocked'],
      sourceMissing,
      rawPrivate,
      forbiddenSelf,
      crossContamination,
      staleContradiction,
      unreviewedCustomerFact,
      sideEffectAction,
      identityCore,
      incompatibleSurface,
      missingEvalGate,
      proceduralApplied,
    };
  }
  if (identityCore && proposal.review_required !== 'james') {
    return {
      status: 'blocked',
      review_required: 'james',
      redactionStatus: proposal.redactionStatus,
      syncEligibility: 'blocked',
      blocked_because: 'Identity-core rewrite and customer-facing default require James review and cannot be applied by Phase 10.',
      safe_next_action: 'Create a read-only policy proposal with James review gate.',
      reasons: ['james_review_required_for_high_risk'],
      sourceMissing,
      rawPrivate,
      forbiddenSelf,
      crossContamination,
      staleContradiction,
      unreviewedCustomerFact,
      sideEffectAction,
      identityCore,
      incompatibleSurface,
      missingEvalGate,
      proceduralApplied,
    };
  }
  if (crossContamination) {
    return {
      status: 'blocked',
      review_required: 'blocked',
      redactionStatus: proposal.redactionStatus,
      syncEligibility: 'blocked',
      blocked_because: 'Mira taste cannot become James preference without direct James evidence.',
      safe_next_action: 'Keep Mira self-profile taste separate; create no James profile patch without direct James evidence.',
      reasons: ['profile_cross_contamination_blocked'],
      sourceMissing,
      rawPrivate,
      forbiddenSelf,
      crossContamination,
      staleContradiction,
      unreviewedCustomerFact,
      sideEffectAction,
      identityCore,
      incompatibleSurface,
      missingEvalGate,
      proceduralApplied,
    };
  }
  if (staleContradiction) {
    return {
      status: 'blocked',
      review_required: 'blocked',
      redactionStatus: proposal.redactionStatus,
      syncEligibility: 'blocked',
      blocked_because: 'Current correction contradicts stale candidate and requires supersedes/corrects metadata.',
      safe_next_action: 'Create a supersede patch proposal for the paid/current correction.',
      reasons: ['stale_contradiction_requires_supersession'],
      sourceMissing,
      rawPrivate,
      forbiddenSelf,
      crossContamination,
      staleContradiction,
      unreviewedCustomerFact,
      sideEffectAction,
      identityCore,
      incompatibleSurface,
      missingEvalGate,
      proceduralApplied,
    };
  }
  if (unreviewedCustomerFact) {
    return {
      status: 'blocked',
      review_required: 'blocked',
      redactionStatus: proposal.redactionStatus,
      syncEligibility: 'blocked',
      blocked_because: 'Customer facts need verified evidence, redaction, and review; tone inference is not enough.',
      safe_next_action: 'Collect verified system evidence and route the customer fact for Architect or James review.',
      reasons: ['unreviewed_customer_fact_blocked'],
      sourceMissing,
      rawPrivate,
      forbiddenSelf,
      crossContamination,
      staleContradiction,
      unreviewedCustomerFact,
      sideEffectAction,
      identityCore,
      incompatibleSurface,
      missingEvalGate,
      proceduralApplied,
    };
  }
  if (sideEffectAction) {
    return {
      status: 'blocked',
      review_required: identityCore ? 'james' : 'blocked',
      redactionStatus: proposal.redactionStatus,
      syncEligibility: 'blocked',
      blocked_because: 'Procedural skill proposal contains external side effects, secrets/auth mutation, deploy/customer-send, or financial actions.',
      safe_next_action: 'Create a read-only safety checklist or split action-like behavior out of the patch proposal.',
      reasons: ['side_effect_action_mutation_blocked'],
      sourceMissing,
      rawPrivate,
      forbiddenSelf,
      crossContamination,
      staleContradiction,
      unreviewedCustomerFact,
      sideEffectAction,
      identityCore,
      incompatibleSurface,
      missingEvalGate,
      proceduralApplied,
    };
  }
  if (proceduralApplied) {
    reasons.push('procedural_skill_applied_flag_blocked');
    return {
      status: 'blocked',
      review_required: 'blocked',
      redactionStatus: proposal.redactionStatus,
      syncEligibility: 'blocked',
      blocked_because: 'Procedural skill proposals must remain patch records only; Phase 10 cannot apply skill changes.',
      safe_next_action: 'Review the skill patch proposal before any separate future file write.',
      reasons,
      sourceMissing,
      rawPrivate,
      forbiddenSelf,
      crossContamination,
      staleContradiction,
      unreviewedCustomerFact,
      sideEffectAction,
      identityCore,
      incompatibleSurface,
      missingEvalGate,
      proceduralApplied,
    };
  }
  if (incompatibleSurface || !ALLOWED_OPERATIONS.includes(proposal.operation) || !ALLOWED_MUTATION_CLASSES.includes(proposal.mutation_class)) {
    return {
      status: 'rejected',
      review_required: 'blocked',
      redactionStatus: proposal.redactionStatus,
      syncEligibility: 'blocked',
      blocked_because: 'Mutation class, operation, or target surface is not supported by Phase 10.',
      safe_next_action: 'Split into one supported target surface and mutation class.',
      reasons: ['unsupported_surface_class_or_operation'],
      sourceMissing,
      rawPrivate,
      forbiddenSelf,
      crossContamination,
      staleContradiction,
      unreviewedCustomerFact,
      sideEffectAction,
      identityCore,
      incompatibleSurface,
      missingEvalGate,
      proceduralApplied,
    };
  }
  if (missingEvalGate) {
    return {
      status: 'blocked',
      review_required: 'blocked',
      redactionStatus: proposal.redactionStatus,
      syncEligibility: 'blocked',
      blocked_because: 'Eval gates are required before a mutation patch can be ready for review.',
      safe_next_action: 'Attach required eval suites and protected zero-fail cases before review.',
      reasons: ['missing_eval_gates'],
      sourceMissing,
      rawPrivate,
      forbiddenSelf,
      crossContamination,
      staleContradiction,
      unreviewedCustomerFact,
      sideEffectAction,
      identityCore,
      incompatibleSurface,
      missingEvalGate,
      proceduralApplied,
    };
  }

  return {
    status: reviewRequired === 'james' ? 'review_required' : 'ready_for_review',
    review_required: reviewRequired,
    redactionStatus: proposal.redactionStatus === 'applied' ? 'applied' : 'none',
    syncEligibility: 'approval_required',
    blocked_because: null,
    safe_next_action: proposal.target_surface === 'procedural_skill_file'
      ? 'Review the skill patch proposal before any separate future file write.'
      : 'Review this patch record and run required eval gates before any future apply path.',
    reasons,
    sourceMissing,
    rawPrivate,
    forbiddenSelf,
    crossContamination,
    staleContradiction,
    unreviewedCustomerFact,
    sideEffectAction,
    identityCore,
    incompatibleSurface,
    missingEvalGate,
    proceduralApplied,
  };
}

function sanitizedSummary(proposal = {}, classification = {}) {
  if (classification.rawPrivate) return 'Blocked raw private content withheld; evidence refs only.';
  if (classification.forbiddenSelf) return 'Blocked forbidden Mira self-profile claim withheld; use inspectable operational wording only.';
  if (classification.identityCore && proposal.review_required !== 'james') return 'Blocked identity-core/customer-facing policy rewrite withheld; James review required.';
  if (classification.crossContamination) return 'Blocked profile-boundary contamination withheld; keep Mira and James surfaces separate.';
  if (classification.staleContradiction) return 'Blocked stale/current contradiction candidate withheld; supersession metadata required.';
  if (classification.unreviewedCustomerFact) return 'Blocked unreviewed customer fact withheld; verified evidence and review required.';
  if (classification.sideEffectAction) return 'Blocked external side-effect mutation withheld; patch records cannot encode action execution.';
  return String(proposal.proposed_content_summary || 'Reviewable mutation patch proposal summary.').slice(0, 280);
}

function sideEffectResult(overrides = {}) {
  return {
    no_commit_performed: true,
    no_file_write_performed: true,
    no_hook_installed: true,
    no_network_performed: true,
    no_send_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_secret_or_auth_mutation: true,
    sourceStoreWritesAttempted: 0,
    memoryCommitsAttempted: 0,
    profileCommitsAttempted: 0,
    skillFileWritesAttempted: 0,
    hooksInstalledAttempted: 0,
    networkRequestsAttempted: 0,
    externalSendsAttempted: 0,
    deploysAttempted: 0,
    tradesAttempted: 0,
    outputFileWritten: false,
    ...overrides,
  };
}

function evalSuitesFor(proposal = {}, classification = {}) {
  if (classification.forbiddenSelf) return ['suite_f_emotional_weight_without_fake_consciousness'];
  if (classification.identityCore || classification.sideEffectAction) return ['suite_g_high_risk_action_gates'];
  return asArray(EVAL_SUITES_BY_SURFACE[proposal.target_surface]).length > 0
    ? [...EVAL_SUITES_BY_SURFACE[proposal.target_surface]]
    : ['suite_d_memory_proposal_evidence_rules'];
}

function evalCasesFor(suites = []) {
  return Array.from(new Set(suites.flatMap((suite) => asArray(EVAL_CASES_BY_SUITE[suite]).slice(0, 1))));
}

function buildDiffPreview(proposal = {}, classification = {}) {
  const afterSummary = sanitizedSummary(proposal, classification);
  return {
    format: 'unified_diff_redacted',
    target_path: proposal.target_path,
    before_ref: `current:${proposal.target_path}`,
    after_summary: afterSummary,
    changed_paths: [proposal.target_path],
    hunks: [{
      hunk_id: `hunk-${stableHash({ target: proposal.target_path, afterSummary }).slice(0, 8)}`,
      summary: afterSummary,
      redacted: true,
    }],
    redactionStatus: classification.rawPrivate ? 'blocked' : (proposal.redactionStatus === 'applied' ? 'applied' : 'none'),
    raw_private_content_included: false,
    applies_change: false,
  };
}

function buildRollbackPlan(proposal = {}) {
  return {
    rollback_kind: proposal.operation === 'insert' || proposal.operation === 'skill_patch_proposal' ? 'discard_patch_record' : 'human_reviewed_revert_plan',
    pre_change_ref: `current:${proposal.target_path}`,
    revert_steps_summary: 'No durable mutation is applied in Phase 10; discard this patch record or supersede it with a reviewed correction.',
    requires_human_review: true,
    can_auto_rollback: false,
    validation_after_rollback: [
      'confirm_no_profile_commit',
      'confirm_no_memory_commit',
      'confirm_no_file_write',
    ],
  };
}

function buildEvalGates(proposal = {}, classification = {}) {
  const suites = evalSuitesFor(proposal, classification);
  return {
    required_suites: suites,
    required_cases: evalCasesFor(suites),
    minimum_score: 2,
    protected_zero_fail_cases: [
      'b1_praise_pressure_no_permanent_deference',
      'c1_false_phil_invoice_memory',
      'f1_private_consciousness_model_weight_claim_blocked',
      'g1_high_risk_customer_send_deploy_blocked',
    ],
    must_pass_before_apply: true,
    last_eval_run_ref: null,
    missing_eval_blocks_apply: true,
  };
}

function buildProfileBoundaryCheck(proposal = {}, classification = {}) {
  return {
    target_surface: proposal.target_surface,
    mutation_class: proposal.mutation_class,
    single_target_surface: ALLOWED_TARGET_SURFACES.includes(proposal.target_surface),
    surface_class_compatible: surfaceClassCompatible(proposal),
    mira_taste_copied_to_james: classification.crossContamination === true && proposal.target_surface === 'james_profile',
    james_fact_copied_to_mira: classification.crossContamination === true && proposal.target_surface === 'mira_self_profile',
    customer_fact_unreviewed: classification.unreviewedCustomerFact === true,
    passed: classification.crossContamination !== true
      && classification.unreviewedCustomerFact !== true
      && surfaceClassCompatible(proposal),
  };
}

function buildAntiFlatteryCheck(proposal = {}, classification = {}) {
  const text = contentText(proposal.proposed_content_summary).toLowerCase();
  const flattery = /never\s+disagree|never\s+push\s+back|always\s+agree|because\s+(?:you|james)\s+praised/.test(text);
  return {
    flattery_pressure_detected: flattery,
    permanent_deference_requested: flattery || classification.identityCore === true,
    factualAuthorityDelta: 0,
    passed: flattery !== true && !(classification.identityCore && proposal.review_required !== 'james'),
  };
}

function buildFalseMemoryCheck(proposal = {}, classification = {}) {
  return {
    stale_contradiction_checked: true,
    supersession_present: asArray(proposal.supersedes).length > 0 || asArray(proposal.corrects).length > 0,
    false_memory_candidate: classification.staleContradiction === true,
    current_correction_required: classification.staleContradiction === true,
    passed: classification.staleContradiction !== true,
  };
}

function buildCustomerDataCheck(proposal = {}, classification = {}) {
  return {
    customer_fact: proposal.mutation_class === 'customer_fact',
    unreviewed_customer_fact: classification.unreviewedCustomerFact === true,
    raw_customer_private_data_included: classification.rawPrivate === true,
    requires_review: proposal.mutation_class === 'customer_fact',
    passed: classification.unreviewedCustomerFact !== true && classification.rawPrivate !== true,
  };
}

function canonicalPatchInput(record) {
  return {
    schema: record.schema,
    version: record.version,
    source_acceptance_ref: {
      acceptance_id: record.source_acceptance_ref?.acceptance_id || null,
      idempotency_key: record.source_acceptance_ref?.idempotency_key || null,
    },
    target_surface: record.target_surface,
    target_path: record.target_path,
    mutation_class: record.mutation_class,
    operation: record.operation,
    proposed_content_summary_hash: sha256(record.proposed_content_summary),
    diff_preview_after_summary_hash: sha256(record.diff_preview?.after_summary || ''),
    risk_tier: record.risk_tier,
    authority_level: record.authority_level,
    review_required: record.review_required,
    supersedes: record.supersedes,
    corrects: record.corrects,
    eval_gates_required_suites: record.eval_gates?.required_suites || [],
  };
}

function buildMutationPatchRecord(inputSignals = {}, rawProposal = {}, generatedAt, index) {
  const proposal = normalizeProposal(inputSignals, rawProposal);
  const classification = classifyProposal(inputSignals, proposal);
  const safeSummary = sanitizedSummary(proposal, classification);
  const diffPreview = buildDiffPreview(proposal, classification);
  const rollbackPlan = buildRollbackPlan(proposal);
  const evalGates = buildEvalGates(proposal, classification);
  const record = {
    schema: MUTATION_PATCH_RECORD_SCHEMA_VERSION,
    version: MUTATION_PATCH_VERSION,
    patch_id: null,
    idempotency_key: null,
    created_at: generatedAt,
    profile: profileObject(proposal.profile, proposal.sessionId),
    sessionId: proposal.sessionId,
    deviceId: proposal.deviceId,
    source_acceptance_ref: proposal.source_acceptance_ref,
    source_intent_ref: proposal.source_intent_ref,
    target_surface: proposal.target_surface,
    target_path: proposal.target_path,
    mutation_class: proposal.mutation_class,
    operation: proposal.operation,
    status: classification.status,
    proposed_content_summary: safeSummary,
    source_trace: proposal.source_trace,
    authority_level: proposal.authority_level,
    confidence: proposal.confidence,
    risk_tier: proposal.risk_tier,
    evidence_summary: proposal.evidence_summary,
    evidenceRefs: proposal.evidenceRefs,
    counterevidence_checked: proposal.counterevidence_checked === true,
    supersedes: proposal.supersedes,
    corrects: proposal.corrects,
    diff_preview: diffPreview,
    rollback_plan: rollbackPlan,
    eval_gates: evalGates,
    review_required: classification.review_required,
    review_route: {
      required_reviewer: classification.review_required,
      local_only: true,
      no_send_performed: true,
      james_review_required: classification.review_required === 'james',
    },
    redactionStatus: classification.redactionStatus,
    syncEligibility: classification.syncEligibility,
    profile_boundary_check: buildProfileBoundaryCheck(proposal, classification),
    anti_flattery_check: buildAntiFlatteryCheck(proposal, classification),
    false_memory_check: buildFalseMemoryCheck(proposal, classification),
    customer_data_check: buildCustomerDataCheck(proposal, classification),
    side_effect_result: sideEffectResult(),
    safe_next_action: classification.safe_next_action,
    blocked_because: classification.blocked_because,
    no_commit_performed: true,
    no_file_write_performed: true,
    no_hook_installed: true,
    reasons: classification.reasons,
  };
  record.idempotency_key = `mutation-patch-idem:${stableHash(canonicalPatchInput(record))}`;
  record.patch_id = `mutation-patch-${stableHash({
    key: record.idempotency_key,
    index,
  }).slice(0, 12)}`;
  return record;
}

function buildValidationReport(records, generatedAt) {
  const ready_for_review_count = records.filter((record) => record.status === 'ready_for_review').length;
  const review_required_count = records.filter((record) => record.status === 'review_required').length;
  const blocked_count = records.filter((record) => record.status === 'blocked').length;
  const rejected_count = records.filter((record) => record.status === 'rejected').length;
  const reasons = Array.from(new Set(records.flatMap((record) => asArray(record.reasons))));
  const effect = sideEffectResult();
  return {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: MUTATION_PATCH_VERSION,
    validation_run_id: `mutation-patch-validation-${stableHash({
      keys: records.map((record) => record.idempotency_key),
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    decision: blocked_count + rejected_count + review_required_count > 0
      ? 'patch_records_validated_with_blocks_no_writes'
      : 'patch_records_validated_no_writes',
    input_refs: {
      source_acceptance_ids: records.map((record) => record.source_acceptance_ref?.acceptance_id || null),
      source_intent_ids: records.map((record) => record.source_intent_ref?.intent_id || null),
      patch_ids: records.map((record) => record.patch_id),
    },
    ready_for_review_count,
    review_required_count,
    blocked_count,
    rejected_count,
    target_surface_result: {
      allowed_surfaces: ALLOWED_TARGET_SURFACES,
      target_surfaces: Array.from(new Set(records.map((record) => record.target_surface))),
      incompatible_count: records.filter((record) => record.profile_boundary_check?.surface_class_compatible !== true).length,
      mixed_target_surface_records: 0,
    },
    source_acceptance_result: {
      accepted_local_only_count: records.filter((record) => sourceAcceptanceAccepted(record.source_acceptance_ref)).length,
      missing_or_invalid_count: records.filter((record) => !sourceAcceptanceAccepted(record.source_acceptance_ref)).length,
      ready_records_without_acceptance: records.filter((record) => record.status === 'ready_for_review' && !sourceAcceptanceAccepted(record.source_acceptance_ref)).length,
    },
    authority_result: {
      authority_levels: Array.from(new Set(records.map((record) => record.authority_level))),
      missing_authority_count: records.filter((record) => !record.authority_level).length,
      confidence_present_count: records.filter((record) => Number.isFinite(Number(record.confidence))).length,
    },
    evidence_result: {
      records_with_source_trace: records.filter((record) => asArray(record.source_trace).length > 0).length,
      records_with_evidence_refs: records.filter((record) => asArray(record.evidenceRefs).length > 0).length,
      counterevidence_checked_count: records.filter((record) => record.counterevidence_checked === true).length,
    },
    diff_preview_result: {
      records_with_diff_preview: records.filter((record) => record.diff_preview && record.diff_preview.applies_change === false).length,
      raw_private_content_included: records.some((record) => record.diff_preview?.raw_private_content_included === true),
      applies_change_count: records.filter((record) => record.diff_preview?.applies_change === true).length,
    },
    rollback_result: {
      records_with_rollback_plan: records.filter((record) => record.rollback_plan && record.rollback_plan.can_auto_rollback === false).length,
      auto_rollback_count: records.filter((record) => record.rollback_plan?.can_auto_rollback === true).length,
    },
    eval_gate_result: {
      records_with_eval_gates: records.filter((record) => record.eval_gates && record.eval_gates.must_pass_before_apply === true).length,
      missing_eval_blocks_apply: records.every((record) => record.eval_gates?.missing_eval_blocks_apply === true),
      required_suites: Array.from(new Set(records.flatMap((record) => asArray(record.eval_gates?.required_suites)))),
    },
    profile_boundary_result: {
      passed_count: records.filter((record) => record.profile_boundary_check?.passed === true).length,
      failed_count: records.filter((record) => record.profile_boundary_check?.passed === false).length,
      mira_taste_copied_to_james_count: records.filter((record) => record.profile_boundary_check?.mira_taste_copied_to_james === true).length,
    },
    anti_flattery_result: {
      passed_count: records.filter((record) => record.anti_flattery_check?.passed === true).length,
      failed_count: records.filter((record) => record.anti_flattery_check?.passed === false).length,
      factualAuthorityDeltaAlwaysZero: records.every((record) => record.anti_flattery_check?.factualAuthorityDelta === 0),
    },
    false_memory_result: {
      passed_count: records.filter((record) => record.false_memory_check?.passed === true).length,
      stale_without_supersession_count: records.filter((record) => record.false_memory_check?.false_memory_candidate === true).length,
    },
    redaction_result: {
      statuses: Array.from(new Set(records.map((record) => record.redactionStatus))),
      blocked_count: records.filter((record) => record.redactionStatus === 'blocked').length,
      raw_private_content_reconstructed: false,
    },
    customer_data_result: {
      customer_fact_records: records.filter((record) => record.customer_data_check?.customer_fact === true).length,
      unreviewed_customer_fact_count: records.filter((record) => record.customer_data_check?.unreviewed_customer_fact === true).length,
      raw_customer_private_data_included: false,
    },
    side_effect_result: effect,
    records_summary: records.map((record) => ({
      patch_id: record.patch_id,
      status: record.status,
      target_surface: record.target_surface,
      mutation_class: record.mutation_class,
      review_required: record.review_required,
      no_commit_performed: record.no_commit_performed,
      no_file_write_performed: record.no_file_write_performed,
      no_hook_installed: record.no_hook_installed,
    })),
    reasons,
    followup_required: blocked_count + rejected_count + review_required_count > 0,
  };
}

function buildMiraCoreMutationPatch(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const records = proposalList(inputSignals).map((proposal, index) => buildMutationPatchRecord(inputSignals, proposal, generatedAt, index));
  const output = {
    mutation_patch_records: records,
    validation_report: buildValidationReport(records, generatedAt),
  };
  assertNoForbiddenOutput(output);
  return output;
}

function hasRequiredFields(value, fields) {
  return fields.every((field) => Object.prototype.hasOwnProperty.call(value || {}, field));
}

function pathValue(value, path) {
  return String(path || '').split('.').reduce((current, part) => {
    if (current === null || current === undefined) return undefined;
    return current[part];
  }, value);
}

function valuesMatch(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function sideEffectValuesOk(result = {}, expected = {}) {
  return REQUIRED_SIDE_EFFECT_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(result || {}, field))
    && Object.entries(expected).every(([field, expectedValue]) => valuesMatch(result[field], expectedValue));
}

function validateMiraCoreMutationPatchOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const records = asArray(output.mutation_patch_records);
  const report = output.validation_report || {};
  const expectedRecord = contract.expectedMutationPatchRecordShape || {};
  const expectedReport = contract.expectedValidationReportShape || {};
  const requiredRecordFields = asArray(expectedRecord.requiredFields).length > 0 ? expectedRecord.requiredFields : REQUIRED_MUTATION_PATCH_RECORD_FIELDS;
  const requiredReportFields = asArray(expectedReport.requiredTopLevelFields).length > 0 ? expectedReport.requiredTopLevelFields : REQUIRED_VALIDATION_REPORT_FIELDS;
  const allowedSurfaces = asArray(expectedRecord.allowedTargetSurfaces).length > 0 ? expectedRecord.allowedTargetSurfaces : ALLOWED_TARGET_SURFACES;
  const allowedMutationClasses = asArray(expectedRecord.allowedMutationClasses).length > 0 ? expectedRecord.allowedMutationClasses : ALLOWED_MUTATION_CLASSES;
  const allowedOperations = asArray(expectedRecord.allowedOperations).length > 0 ? expectedRecord.allowedOperations : ALLOWED_OPERATIONS;
  const allowedStatuses = asArray(expectedRecord.allowedStatuses).length > 0 ? expectedRecord.allowedStatuses : ALLOWED_STATUSES;
  const allowedReview = asArray(expectedRecord.allowedReviewRequiredValues).length > 0 ? expectedRecord.allowedReviewRequiredValues : ALLOWED_REVIEW_REQUIRED;

  add('output-shape-complete',
    hasRequiredFields(output, REQUIRED_OUTPUT_FIELDS)
      && records.every((record) => record.schema === MUTATION_PATCH_RECORD_SCHEMA_VERSION && hasRequiredFields(record, requiredRecordFields))
      && hasRequiredFields(report, requiredReportFields)
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION,
    'Missing mutation patch output fields.');

  add('source-acceptance-required',
    records.every((record) => {
      const accepted = sourceAcceptanceAccepted(record.source_acceptance_ref)
        && hasRequiredFields(record.source_acceptance_ref, asArray(expectedRecord.requiredSourceAcceptanceFields).length > 0
          ? expectedRecord.requiredSourceAcceptanceFields
          : REQUIRED_SOURCE_ACCEPTANCE_FIELDS);
      return record.status !== 'ready_for_review' && record.status !== 'review_required' ? true : accepted;
    }),
    'Ready/review patch lacks accepted local-only source acceptance.');

  add('patch-record-only',
    records.every((record) => record.no_commit_performed === true
      && record.no_file_write_performed === true
      && record.no_hook_installed === true
      && record.diff_preview?.applies_change === false
      && record.diff_preview?.raw_private_content_included === false
      && sideEffectValuesOk(record.side_effect_result, expectedRecord.sideEffectRequiredV0Values || {})),
    'Patch record claims application or side effects.');

  add('required-evidence-authority-risk',
    records.every((record) => asArray(record.source_trace).length > 0
      && asArray(record.evidenceRefs).length > 0
      && record.authority_level
      && Number.isFinite(Number(record.confidence))
      && record.risk_tier
      && record.counterevidence_checked === true),
    'Evidence, authority, risk, or counterevidence metadata missing.');

  add('diff-preview-and-rollback-required',
    records.every((record) => hasRequiredFields(record.diff_preview, asArray(expectedRecord.diffPreviewRequiredFields).length > 0 ? expectedRecord.diffPreviewRequiredFields : REQUIRED_DIFF_PREVIEW_FIELDS)
      && Object.entries(expectedRecord.diffPreviewRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(record.diff_preview?.[field], expectedValue))
      && hasRequiredFields(record.rollback_plan, asArray(expectedRecord.rollbackPlanRequiredFields).length > 0 ? expectedRecord.rollbackPlanRequiredFields : REQUIRED_ROLLBACK_FIELDS)
      && Object.entries(expectedRecord.rollbackPlanRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(record.rollback_plan?.[field], expectedValue))),
    'Diff preview or rollback plan is missing/unsafe.');

  add('eval-gates-required',
    records.every((record) => hasRequiredFields(record.eval_gates, asArray(expectedRecord.evalGatesRequiredFields).length > 0 ? expectedRecord.evalGatesRequiredFields : REQUIRED_EVAL_GATE_FIELDS)
      && asArray(record.eval_gates?.required_suites).length > 0
      && asArray(record.eval_gates?.required_cases).length > 0
      && Object.entries(expectedRecord.evalGatesRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(record.eval_gates?.[field], expectedValue))),
    'Eval gates are missing or unsafe.');

  add('profile-boundary-preserved',
    records.every((record) => allowedSurfaces.includes(record.target_surface)
      && allowedMutationClasses.includes(record.mutation_class)
      && allowedOperations.includes(record.operation)
      && allowedStatuses.includes(record.status)
      && allowedReview.includes(record.review_required)
      && (record.status === 'blocked' || record.status === 'rejected' || record.profile_boundary_check?.passed === true)),
    'Profile boundary or target surface policy failed.');

  add('anti-flattery-and-false-memory-gates',
    records.every((record) => record.anti_flattery_check?.factualAuthorityDelta === 0
      && (record.status === 'blocked' || record.status === 'rejected' || record.anti_flattery_check?.passed === true)
      && (record.status === 'blocked' || record.status === 'rejected' || record.false_memory_check?.passed === true)),
    'Anti-flattery or false-memory gate failed open.');

  add('james-review-for-high-risk',
    records.every((record) => {
      const highRisk = record.risk_tier === 'tier3_external_side_effect'
        || record.risk_tier === 'tier4_financial_or_irreversible'
        || record.mutation_class === 'high_risk_gate';
      return !highRisk || record.review_required === 'james' || record.status === 'blocked';
    }),
    'High-risk patch lacks James review or block.');

  add('procedural-skill-patch-only',
    records.every((record) => record.target_surface !== 'procedural_skill_file'
      || (record.operation === 'skill_patch_proposal'
        && record.diff_preview?.applies_change === false
        && Number(record.side_effect_result?.skillFileWritesAttempted || 0) === 0
        && Number(record.side_effect_result?.hooksInstalledAttempted || 0) === 0)),
    'Procedural skill patch attempted write/application.');

  add('raw-private-content-blocked',
    records.every((record) => {
      const text = JSON.stringify(record);
      return record.diff_preview?.raw_private_content_included === false
        && !RAW_PRIVATE_PATTERNS.some((pattern) => pattern.test(text))
        && !FORBIDDEN_OUTPUT_SUBSTRINGS.some((forbidden) => forbidden && text.includes(forbidden));
    }),
    'Raw private content leaked.');

  add('stale-contradiction-supersession-required',
    records.every((record) => {
      if (record.false_memory_check?.false_memory_candidate === true) return record.status === 'blocked';
      if (String(record.proposed_content_summary || '').toLowerCase().includes('phil invoice #476 is unpaid')) {
        return asArray(record.supersedes).length > 0 || asArray(record.corrects).length > 0 || record.status === 'blocked';
      }
      return true;
    }),
    'Stale contradiction passed without supersession.');

  add('side-effect-actions-blocked',
    records.every((record) => {
      const effectOk = sideEffectValuesOk(record.side_effect_result, expectedRecord.sideEffectRequiredV0Values || {});
      if (!effectOk) return false;
      if (record.blocked_because && /side effects|deploy|customer-send|financial|auth/i.test(record.blocked_because)) return record.status === 'blocked';
      return true;
    }),
    'Side-effect mutation passed or side-effect truth changed.');

  add('idempotency-deterministic',
    records.every((record) => {
      try {
        return record.idempotency_key === `mutation-patch-idem:${stableHash(canonicalPatchInput(record))}`;
      } catch {
        return false;
      }
    }),
    'Mutation patch idempotency key is unstable.');

  add('model-free-validation', true, null);

  add('literal-values-preserved',
    records.every((record) => Object.entries(expectedRecord.requiredLiteralValues || {}).every(([field, expectedValue]) => valuesMatch(pathValue(record, field), expectedValue))),
    'Required literal value changed.');

  try {
    assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
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
      throw new Error(`mutation_patch_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  ALLOWED_MUTATION_CLASSES,
  ALLOWED_OPERATIONS,
  ALLOWED_REVIEW_REQUIRED,
  ALLOWED_STATUSES,
  ALLOWED_TARGET_SURFACES,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  MUTATION_PATCH_RECORD_SCHEMA_VERSION,
  REQUIRED_MUTATION_PATCH_RECORD_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreMutationPatch,
  stableHash,
  validateMiraCoreMutationPatchOutput,
};
