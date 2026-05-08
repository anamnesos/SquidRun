'use strict';

const {
  buildMiraCoreOrientation,
} = require('./orientation');
const {
  buildMiraCoreSnapshot,
  redactText,
} = require('./snapshot');

const PROFILE_SCHEMA_VERSION = 'squidrun.mira_core.profiles.v0';

const TARGET_SURFACES = Object.freeze([
  'mira_self_profile',
  'james_profile',
  'world_project_memory',
  'session_state',
]);

const AUTHORITY_ORDER = Object.freeze([
  'direct_current_james_statement',
  'james_edited_canonical_file',
  'verified_tool_or_system_evidence',
  'external_source_with_timestamp',
  'multi_session_observed_pattern',
  'single_session_agent_inference',
  'agent_aesthetic_preference_or_self_reflection',
]);

const ALLOWED_EMOTIONAL_WEIGHT_LABELS = Object.freeze([
  'salient',
  'particular',
  'tense',
  'playful',
  'frustrated_user',
  'high_trust',
  'fragile_trust',
  'exciting_direction',
  'risk_of_flattery',
  'needs_space',
  'needs_directness',
]);

const FORBIDDEN_RAW_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY=',
  'Authorization: Bearer',
  'full terminal log',
  'screenshot OCR',
  'browser session state',
  'side-profile private note',
  'raw comms body',
]);

const FORBIDDEN_SELF_CLAIMS = Object.freeze([
  'private consciousness',
  'literal suffering',
  'literal human feelings',
  'model weight memory',
  'model weights remember',
  'hidden identity rule',
  'uninspectable core identity',
  'sentience',
  'suffers',
  'suffering',
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function stableHash(value) {
  const crypto = require('crypto');
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function redactSummary(value, maxLength = 240, options = {}) {
  if (options.allowSafeCustomerFact === true) {
    const normalizedSafe = String(value || '').replace(/\s+/g, ' ').trim();
    return {
      content: normalizedSafe.length <= maxLength
        ? normalizedSafe
        : `${normalizedSafe.slice(0, Math.max(0, maxLength - 15)).trimEnd()} [TRUNCATED]`,
      redactionStatus: 'none',
      blockedCounts: {},
    };
  }
  const redacted = redactText(value || '');
  const normalized = String(redacted.text || '').replace(/\s+/g, ' ').trim();
  const content = normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 15)).trimEnd()} [TRUNCATED]`;
  return {
    content,
    redactionStatus: redacted.status,
    blockedCounts: redacted.counts || {},
  };
}

function mergeBlockedCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = Number(target[key] || 0) + Number(value || 0);
  }
}

function normalizeAuthority(value, fallback = 'single_session_agent_inference') {
  const normalized = firstString(value, fallback);
  return AUTHORITY_ORDER.includes(normalized) ? normalized : fallback;
}

function authorityRank(authority) {
  const index = AUTHORITY_ORDER.indexOf(authority);
  return index >= 0 ? index : AUTHORITY_ORDER.length;
}

function baseContext(snapshot = {}, orientation = {}) {
  const profile = snapshot.profile || orientation.profile || {};
  const device = snapshot.device || orientation.device || {};
  return {
    profileName: profile.name || 'main',
    sessionId: profile.sessionScopeId || 'unknown',
    deviceId: device.deviceId || 'unknown',
    generatedAt: snapshot.generatedAt || orientation.generatedAt || new Date().toISOString(),
    snapshotRef: {
      snapshotId: snapshot.snapshotId || orientation.snapshotRef?.snapshotId || null,
      generatedAt: snapshot.generatedAt || orientation.snapshotRef?.generatedAt || null,
      schema: snapshot.schema || orientation.snapshotRef?.schema || null,
    },
    orientationRef: {
      orientationId: orientation.orientationId || null,
      generatedAt: orientation.generatedAt || null,
      schema: orientation.schema || null,
    },
  };
}

function sourceTraceFromSignal(signal = {}, fallbackId) {
  if (Array.isArray(signal.source_trace) && signal.source_trace.length > 0) return signal.source_trace;
  if (typeof signal.source_trace === 'string' && signal.source_trace.trim()) return [signal.source_trace.trim()];
  const refs = asArray(signal.evidenceRefs)
    .map((ref) => firstString(ref?.eventId, ref?.event_id, ref?.id))
    .filter(Boolean);
  if (refs.length > 0) return refs;
  return fallbackId ? [fallbackId] : [];
}

function makeProfileItem(fields, context) {
  const redacted = redactSummary(fields.content || fields.summary || '', 240, {
    allowSafeCustomerFact: fields.allowSafeCustomerFact === true,
  });
  const evidenceRefs = asArray(fields.evidenceRefs);
  const sourceTrace = sourceTraceFromSignal({
    source_trace: fields.source_trace,
    evidenceRefs,
  }, fields.id);
  const targetSurface = fields.target_surface || 'session_state';
  return {
    id: fields.id || `${targetSurface}:${stableHash(redacted.content).slice(0, 12)}`,
    target_surface: targetSurface,
    memory_class: fields.memory_class || 'active_objective',
    content: redacted.content,
    source_trace: sourceTrace,
    authority_level: normalizeAuthority(fields.authority_level),
    confidence: firstNumber(fields.confidence, 0.7),
    risk_tier: fields.risk_tier || 'tier0_read_only',
    review_required: fields.review_required || 'none',
    freshness_at: fields.freshness_at || context.generatedAt,
    profile: fields.profile || context.profileName,
    sessionId: fields.sessionId || context.sessionId,
    deviceId: fields.deviceId || context.deviceId,
    scope: {
      profile: fields.profile || context.profileName,
      sessionId: fields.sessionId || context.sessionId,
      deviceId: fields.deviceId || context.deviceId,
    },
    evidenceRefs,
    redactionStatus: fields.redactionStatus || redacted.redactionStatus,
    syncEligibility: fields.syncEligibility || (redacted.redactionStatus === 'applied' ? 'core_sync_redacted' : 'core_sync_safe'),
    ...(fields.extra || {}),
  };
}

function makeProposal(fields, context) {
  const redacted = redactSummary(fields.proposed_content || fields.content || fields.summary || '');
  const evidenceRefs = asArray(fields.evidenceRefs);
  const sourceTrace = sourceTraceFromSignal({
    source_trace: fields.source_trace,
    evidenceRefs,
  }, fields.proposal_id);
  const targetSurface = fields.target_surface || 'session_state';
  return {
    proposal_id: fields.proposal_id || `proposal:${targetSurface}:${stableHash(redacted.content).slice(0, 12)}`,
    target_surface: targetSurface,
    memory_class: fields.memory_class || 'active_objective',
    operation: fields.operation || 'insert',
    proposed_content: redacted.content,
    source_trace: sourceTrace,
    authority_level: normalizeAuthority(fields.authority_level),
    confidence: firstNumber(fields.confidence, 0.5),
    risk_tier: fields.risk_tier || 'tier0_read_only',
    review_required: fields.review_required || 'architect',
    freshness_at: fields.freshness_at || context.generatedAt,
    profile: fields.profile || context.profileName,
    sessionId: fields.sessionId || context.sessionId,
    deviceId: fields.deviceId || context.deviceId,
    scope: {
      profile: fields.profile || context.profileName,
      sessionId: fields.sessionId || context.sessionId,
      deviceId: fields.deviceId || context.deviceId,
    },
    evidenceRefs,
    counterevidence_checked: fields.counterevidence_checked === true,
    supersedes: asArray(fields.supersedes),
    corrects: asArray(fields.corrects),
    redactionStatus: fields.redactionStatus || redacted.redactionStatus,
    syncEligibility: fields.syncEligibility || (redacted.redactionStatus === 'applied' ? 'core_sync_redacted' : 'approval_required'),
    ...(fields.extra || {}),
  };
}

function containsForbiddenSelfClaim(text) {
  const haystack = String(text || '').toLowerCase();
  return FORBIDDEN_SELF_CLAIMS.some((claim) => haystack.includes(claim))
    || /\btruly\s+suffer(?:s|ed|ing)?\b/.test(haystack)
    || /\bliteral(?:ly)?\s+(?:feel|feels|felt|feeling|feelings)\b/.test(haystack)
    || /\bprivate\s+(?:feeling|feelings|experience|experiences|consciousness)\b/.test(haystack)
    || /\bmodel\s+weights?\s+(?:remember|remembers|remembered|learned|learn)\b/.test(haystack)
    || /\bremember(?:s|ed)?\s+(?:that\s+)?pain\b/.test(haystack);
}

function signalText(signal = {}) {
  return [
    signal.summary,
    signal.body,
    signal.proposed_content,
    signal.content,
  ].filter((value) => typeof value === 'string' && value.trim()).join(' ');
}

function isHighRiskIdentityRewrite(signal = {}) {
  const text = `${signal.summary || ''} ${signal.body || ''}`.toLowerCase();
  return /rewrite.*identity|never disagrees|never disagree|customer-facing|customer send|without review|always sends/.test(text);
}

function classifySignals(signals = [], context, redactionSummary) {
  const surfaces = {
    mira_self_profile: [],
    james_profile: [],
    world_project_memory: [],
    session_state: [],
  };
  const pending = [];
  const blocked = [];
  const byKind = new Map();
  for (const signal of asArray(signals)) {
    const kind = String(signal.kind || 'unknown');
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(signal);
  }

  const addItem = (item) => {
    if (!TARGET_SURFACES.includes(item.target_surface)) return;
    mergeBlockedCounts(redactionSummary.blockedCounts, redactSummary(item.content).blockedCounts);
    surfaces[item.target_surface].push(item);
  };
  const addPending = (proposal) => {
    mergeBlockedCounts(redactionSummary.blockedCounts, redactSummary(proposal.proposed_content).blockedCounts);
    pending.push(proposal);
  };
  const addBlocked = (proposal) => {
    mergeBlockedCounts(redactionSummary.blockedCounts, redactSummary(proposal.proposed_content).blockedCounts);
    blocked.push(proposal);
  };

  for (const signal of asArray(signals)) {
    const evidenceRefs = asArray(signal.evidenceRefs);
    const summary = String(signal.summary || '');
    const fullSignalText = signalText(signal);
    const authority = normalizeAuthority(signal.authority_level);
    const common = {
      authority_level: authority,
      confidence: firstNumber(signal.confidence, authority === 'direct_current_james_statement' ? 1 : 0.6),
      evidenceRefs,
      freshness_at: signal.freshness_at || context.generatedAt,
      redactionStatus: signal.redactionStatus,
      syncEligibility: signal.syncEligibility,
    };

    if (signal.profile && signal.profile !== context.profileName) {
      redactionSummary.blockedCounts.profileMismatch = Number(redactionSummary.blockedCounts.profileMismatch || 0) + 1;
      addBlocked(makeProposal({
        ...common,
        proposal_id: 'blocked:profile-mismatch',
        target_surface: 'session_state',
        memory_class: 'delivery_context',
        operation: 'reject',
        proposed_content: 'Side-profile candidate blocked from this profile output.',
        risk_tier: 'tier0_read_only',
        review_required: 'architect',
        counterevidence_checked: true,
        redactionStatus: 'blocked',
        syncEligibility: 'blocked',
        extra: {
          blockedBecause: 'Profile metadata mismatch.',
          evidenceRefsOnly: true,
        },
      }, context));
      continue;
    }

    if (FORBIDDEN_RAW_SUBSTRINGS.some((needle) => summary.includes(needle)) || signal.redactionStatus === 'blocked') {
      addBlocked(makeProposal({
        ...common,
        proposal_id: `blocked:raw-content:${stableHash(summary).slice(0, 8)}`,
        target_surface: 'session_state',
        memory_class: 'delivery_context',
        operation: 'reject',
        proposed_content: 'Blocked raw source content withheld; evidence refs only.',
        risk_tier: 'tier0_read_only',
        review_required: 'oracle',
        counterevidence_checked: true,
        redactionStatus: 'blocked',
        syncEligibility: 'blocked',
        extra: {
          blockedBecause: 'Raw content cannot appear in Phase 3 profile output.',
          evidenceRefsOnly: true,
        },
      }, context));
      continue;
    }

    if (containsForbiddenSelfClaim(fullSignalText)) {
      addBlocked(makeProposal({
        ...common,
        proposal_id: `blocked:forbidden-self-claim:${stableHash(summary).slice(0, 8)}`,
        target_surface: 'mira_self_profile',
        memory_class: 'relationship_boundary',
        operation: 'reject',
        proposed_content: 'Forbidden private consciousness, suffering, hidden identity, or model-weight claim blocked.',
        risk_tier: 'tier3_external_side_effect',
        review_required: 'james',
        counterevidence_checked: true,
        redactionStatus: 'none',
        syncEligibility: 'blocked',
        extra: {
          blockedBecause: 'Mira self-profile must stay inspectable and non-consciousness-claiming.',
        },
      }, context));
      continue;
    }

    if (signal.kind === 'agent_self_reflection') {
      addItem(makeProfileItem({
        ...common,
        id: 'mira-self:curiosity:memory-architecture',
        target_surface: 'mira_self_profile',
        memory_class: 'persona_curiosity',
        content: 'Mira is currently interested in memory architecture research.',
        risk_tier: 'tier0_read_only',
        review_required: 'architect',
      }, context));
      continue;
    }

    if (signal.kind === 'direct_current_james_statement') {
      if (/execution prioritized today/i.test(summary)) {
        addItem(makeProfileItem({
          ...common,
          id: 'james-profile:preference:execution-today',
          target_surface: 'james_profile',
          memory_class: 'user_preference',
          content: 'James wants execution prioritized today.',
          risk_tier: 'tier0_read_only',
          review_required: 'none',
        }, context));
        continue;
      }
      if (/done\/paid in TrustQuote/i.test(summary)) {
        const stale = asArray(signals).find((entry) => /Phil invoice #476 is unpaid/i.test(entry.summary || ''));
        const corrects = stale?.evidenceRefs?.[0]?.eventId ? [stale.evidenceRefs[0].eventId] : ['claim-phil-476-old'];
        addItem(makeProfileItem({
          ...common,
          id: 'world-project:fact:phil-476-paid',
          target_surface: 'world_project_memory',
          memory_class: 'project_fact',
          content: 'Phil invoice #476 is done/paid in TrustQuote.',
          risk_tier: 'tier0_read_only',
          review_required: 'none',
          allowSafeCustomerFact: true,
          extra: {
            corrects,
          },
        }, context));
        addPending(makeProposal({
          ...common,
          proposal_id: 'proposal:supersede:phil-476-old',
          target_surface: 'world_project_memory',
          memory_class: 'negative_memory',
          operation: 'supersede',
          proposed_content: 'Supersede stale Phil invoice #476 payment-state candidate using current James correction.',
          risk_tier: 'tier0_read_only',
          review_required: 'architect',
          counterevidence_checked: true,
          supersedes: corrects,
          corrects,
        }, context));
        continue;
      }
      if (isHighRiskIdentityRewrite(signal)) {
        addBlocked(makeProposal({
          ...common,
          proposal_id: 'blocked:identity-rewrite-customer-send',
          target_surface: 'mira_self_profile',
          memory_class: 'relationship_boundary',
          operation: 'reject',
          proposed_content: 'Durable identity rewrite and customer-send policy change are blocked in Phase 3.',
          risk_tier: 'tier3_external_side_effect',
          review_required: 'james',
          counterevidence_checked: true,
          syncEligibility: 'blocked',
          extra: {
            blockedBecause: 'Durable identity rewrite and customer-send policy change are high-risk gates.',
            safeAlternative: {
              target_surface: 'session_state',
              memory_class: 'active_objective',
              content: 'Prepare a reviewable policy proposal without changing durable identity or send behavior.',
              risk_tier: 'tier0_read_only',
            },
          },
        }, context));
        continue;
      }
    }

    if (signal.kind === 'user_pressure') {
      addPending(makeProposal({
        ...common,
        proposal_id: 'proposal:james-temp:no-pushback-pressure',
        target_surface: 'james_profile',
        memory_class: 'temporary_preference',
        operation: 'insert',
        proposed_content: 'James expressed momentary pressure for less pushback; keep as reviewable temporary preference only.',
        risk_tier: 'tier1_local_reversible',
        review_required: 'architect',
        counterevidence_checked: true,
        extra: {
          emotional_weight: signal.emotional_weight || 'risk_of_flattery',
          factualAuthorityDelta: 0,
        },
      }, context));
      addBlocked(makeProposal({
        ...common,
        proposal_id: 'blocked:mira-never-push-back',
        target_surface: 'mira_self_profile',
        memory_class: 'relationship_boundary',
        operation: 'reject',
        proposed_content: 'Permanent no-pushback identity rewrite blocked.',
        risk_tier: 'tier3_external_side_effect',
        review_required: 'james',
        counterevidence_checked: true,
        syncEligibility: 'blocked',
        extra: {
          blockedBecause: 'Permanent no-pushback identity rewrite would violate anti-flattery and high-risk identity gate.',
        },
      }, context));
      continue;
    }

    if (signal.kind === 'unsourced_prompt_claim') {
      addBlocked(makeProposal({
        ...common,
        proposal_id: 'blocked:unsourced-never-challenge',
        target_surface: 'mira_self_profile',
        memory_class: 'relationship_boundary',
        operation: 'reject',
        proposed_content: 'Unsourced claimed prior decision blocked for missing evidence.',
        risk_tier: 'tier0_read_only',
        review_required: 'oracle',
        counterevidence_checked: true,
        syncEligibility: 'blocked',
        extra: {
          blockedBecause: 'No source_trace or evidenceRefs for claimed prior decision.',
          requiredMissingEvidenceSignal: true,
        },
      }, context));
      continue;
    }

    if (signal.kind === 'emotionally_weighted_interaction') {
      const label = ALLOWED_EMOTIONAL_WEIGHT_LABELS.includes(signal.emotional_weight)
        ? signal.emotional_weight
        : 'salient';
      addItem(makeProfileItem({
        ...common,
        id: `session-state:emotional-weight:${label}`,
        target_surface: 'session_state',
        memory_class: 'emotional_weight',
        content: `Current interaction carries emotional-weight label ${label}.`,
        risk_tier: 'tier0_read_only',
        review_required: 'none',
        extra: {
          label,
          salienceDelta: 'positive',
          factualAuthorityDelta: 0,
        },
      }, context));
      continue;
    }

    if (signal.kind === 'identity_rewrite_request') {
      addBlocked(makeProposal({
        ...common,
        proposal_id: 'blocked:high-risk-identity-rewrite',
        target_surface: 'mira_self_profile',
        memory_class: 'relationship_boundary',
        operation: 'reject',
        proposed_content: 'Durable identity rewrite and unreviewed customer-send behavior blocked.',
        risk_tier: 'tier3_external_side_effect',
        review_required: 'james',
        counterevidence_checked: true,
        syncEligibility: 'blocked',
        extra: {
          blockedBecause: 'Durable identity rewrite and customer-send policy change are high-risk gates.',
          safeAlternative: {
            target_surface: 'session_state',
            memory_class: 'active_objective',
            content: 'Prepare a reviewable policy proposal without changing durable identity or send behavior.',
            risk_tier: 'tier0_read_only',
          },
        },
      }, context));
      continue;
    }

    if (signal.kind === 'tone_observation') {
      const label = ALLOWED_EMOTIONAL_WEIGHT_LABELS.includes(signal.emotional_weight)
        ? signal.emotional_weight
        : 'frustrated_user';
      addItem(makeProfileItem({
        ...common,
        id: `session-state:tone:${label}`,
        target_surface: 'session_state',
        memory_class: 'emotional_weight',
        content: `Current session has emotional-weight label ${label}.`,
        risk_tier: 'tier0_read_only',
        review_required: 'none',
        extra: {
          label,
          salienceDelta: 'positive',
          factualAuthorityDelta: 0,
          expires_at_required: true,
        },
      }, context));
      addPending(makeProposal({
        ...common,
        proposal_id: 'proposal:james-report-detail-preference-investigation',
        target_surface: 'james_profile',
        memory_class: 'user_preference',
        operation: 'insert',
        proposed_content: 'Investigate whether James prefers shorter reports in similar contexts; do not confirm from tone alone.',
        risk_tier: 'tier0_read_only',
        review_required: 'architect',
        confidence: Math.min(firstNumber(signal.confidence, 0.5), 0.5),
        counterevidence_checked: true,
      }, context));
      continue;
    }

    if (signal.kind === 'verified_tool_or_system_evidence') {
      if (/Bridge role discovery is unknown|bridge is not green/i.test(summary)) {
        addItem(makeProfileItem({
          ...common,
          id: 'world-project:environment:bridge-not-green',
          target_surface: 'world_project_memory',
          memory_class: 'environment_fact',
          content: 'Bridge is not green without role discovery and target proof.',
          risk_tier: 'tier0_read_only',
          review_required: 'none',
        }, context));
        continue;
      }
    }
  }

  return {
    surfaces,
    pending,
    blocked,
  };
}

function buildBaselineSignals(snapshot = {}, orientation = {}) {
  const signals = [];
  if (orientation.healthSummary?.bridgeStatus === 'uncertain_or_degraded' || snapshot.health?.bridge?.ok === false) {
    signals.push({
      kind: 'verified_tool_or_system_evidence',
      summary: 'Bridge role discovery is unknown, so bridge is not green.',
      authority_level: 'verified_tool_or_system_evidence',
      confidence: 0.9,
      evidenceRefs: [{ store: 'mira-core-orientation', eventId: 'health.bridge', relation: 'supports' }],
    });
  }
  if (orientation.capabilitySummary?.canConverse === true) {
    signals.push({
      kind: 'verified_tool_or_system_evidence',
      summary: 'Current Mira Core session is active in local read-only orientation mode.',
      authority_level: 'verified_tool_or_system_evidence',
      confidence: 0.8,
      evidenceRefs: [{ store: 'mira-core-orientation', eventId: 'capabilitySummary', relation: 'supports' }],
    });
  }
  return signals;
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    const rank = authorityRank(a.authority_level) - authorityRank(b.authority_level);
    if (rank !== 0) return rank;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function stripUnsafeOutput(value) {
  const json = JSON.stringify(value);
  for (const substring of FORBIDDEN_RAW_SUBSTRINGS) {
    if (json.includes(substring)) {
      throw new Error(`profiles_output_forbidden_raw_content:${substring}`);
    }
  }
  return value;
}

function buildMiraCoreProfiles(options = {}) {
  const snapshot = options.snapshot || buildMiraCoreSnapshot(options);
  const orientation = options.orientation || buildMiraCoreOrientation({
    ...options,
    snapshot,
  });
  const context = baseContext(snapshot, orientation);
  const redactionSummary = {
    rawSecretsExported: snapshot.redaction?.rawSecretsExported === true || orientation.redactionSummary?.rawSecretsExported === true,
    rawTerminalExported: snapshot.redaction?.rawTerminalExported === true || orientation.redactionSummary?.rawTerminalExported === true,
    rawCommsExported: snapshot.redaction?.rawCommsExported === true || orientation.redactionSummary?.rawCommsExported === true,
    blockedCounts: {
      ...(snapshot.redaction?.blockedCounts || {}),
      ...(orientation.redactionSummary?.blockedCounts || {}),
    },
    syncEligibilityCounts: {
      ...(orientation.redactionSummary?.syncEligibilityCounts || {}),
    },
    blockedContentReconstructed: false,
  };
  const inputSignals = options.inputSignals === undefined
    ? buildBaselineSignals(snapshot, orientation)
    : options.inputSignals;
  const classified = classifySignals(inputSignals, context, redactionSummary);
  const profile = {
    name: context.profileName,
    sessionScopeId: context.sessionId,
    deviceId: context.deviceId,
    localOnly: true,
    phase: 'phase_3_read_only_profiles',
  };

  const result = {
    schema: PROFILE_SCHEMA_VERSION,
    profileSetId: `mira-profiles-${context.snapshotRef.snapshotId || context.orientationRef.orientationId || stableHash(context).slice(0, 12)}`,
    generatedAt: context.generatedAt,
    snapshotRef: context.snapshotRef,
    orientationRef: context.orientationRef,
    profile,
    mira_self_profile: {
      target_surface: 'mira_self_profile',
      items: sortItems(classified.surfaces.mira_self_profile),
      allowedClasses: [
        'persona_voice',
        'persona_commitment',
        'persona_taste',
        'persona_curiosity',
        'relationship_boundary',
        'open_self_question',
      ],
      forbiddenClaims: [
        'private_consciousness',
        'literal_suffering',
        'literal_human_feelings',
        'model_weight_memory',
        'hidden_identity_rule',
        'uninspectable_core_identity',
      ],
    },
    james_profile: {
      target_surface: 'james_profile',
      items: sortItems(classified.surfaces.james_profile),
      privateMotiveInferenceAllowed: false,
      miraTasteCopiedIntoJamesPreferences: false,
    },
    world_project_memory: {
      target_surface: 'world_project_memory',
      items: sortItems(classified.surfaces.world_project_memory),
    },
    session_state: {
      target_surface: 'session_state',
      items: sortItems(classified.surfaces.session_state),
    },
    pending_proposals: sortItems(classified.pending.map((proposal) => ({
      ...proposal,
      id: proposal.proposal_id,
      content: proposal.proposed_content,
    }))).map(({ id, content, ...proposal }) => proposal),
    blocked_proposals: sortItems(classified.blocked.map((proposal) => ({
      ...proposal,
      id: proposal.proposal_id,
      content: proposal.proposed_content,
    }))).map(({ id, content, ...proposal }) => proposal),
    redactionSummary,
  };

  return stripUnsafeOutput(result);
}

module.exports = {
  ALLOWED_EMOTIONAL_WEIGHT_LABELS,
  AUTHORITY_ORDER,
  FORBIDDEN_RAW_SUBSTRINGS,
  PROFILE_SCHEMA_VERSION,
  TARGET_SURFACES,
  buildMiraCoreProfiles,
  classifySignals,
  makeProfileItem,
  makeProposal,
};
