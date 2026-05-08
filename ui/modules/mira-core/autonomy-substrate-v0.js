'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  classifyAttachmentContractViolation,
  normalizeThreadContext,
} = require('./text-model-attachment-v1');

const AUTONOMY_SUBSTRATE_SCHEMA = 'squidrun.mira_core.autonomy_substrate_v0';
const MAX_READ_BYTES = 12000;

const DEFAULT_READ_TARGETS = Object.freeze({
  self_profile: 'workspace/knowledge/mira-self-profile.json',
  relationship_state: 'workspace/knowledge/james-relationship-state.json',
  growth_history: 'workspace/knowledge/relationship-growth-history.jsonl',
  project_readme: 'README.md',
});

const BACKEND_CHROME_PATTERN =
  /\b(model attachment|model_attachment|coordinator|schema|source count|source_count|audit|proof|confidence:|memory confidence|candidate learning|next step|checklist|blocker|rationale)\b/i;

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function trimText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function generatedAtFromOptions(options = {}) {
  if (options.generatedAt || options.now) return new Date(options.generatedAt || options.now).toISOString();
  const nowMs = Number(options.nowMs);
  return new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
}

function projectRootFromOptions(options = {}) {
  return path.resolve(options.projectRoot || process.cwd());
}

function insideRoot(root, fullPath) {
  const relative = path.relative(root, fullPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function readTargets(options = {}) {
  return {
    ...DEFAULT_READ_TARGETS,
    ...(options.readTargets || {}),
  };
}

function resolveReadTarget(projectRoot, targetId, targets = DEFAULT_READ_TARGETS) {
  const id = trimText(targetId);
  const relativePath = targets[id];
  if (!relativePath) {
    return {
      target_id: id || 'missing',
      allowed: false,
      reason: 'target_not_in_allowlist',
    };
  }
  if (/^[a-z]+:\/\//i.test(relativePath)) {
    return {
      target_id: id,
      path: relativePath,
      allowed: false,
      reason: 'network_targets_blocked',
    };
  }
  const fullPath = path.resolve(projectRoot, relativePath);
  if (!insideRoot(projectRoot, fullPath)) {
    return {
      target_id: id,
      path: relativePath,
      fullPath,
      allowed: false,
      reason: 'target_outside_project_root',
    };
  }
  return {
    target_id: id,
    path: relativePath,
    fullPath,
    allowed: true,
    max_read_bytes: MAX_READ_BYTES,
  };
}

function executePermissionedRead(resolved) {
  if (!resolved.allowed) return resolved;
  if (!fs.existsSync(resolved.fullPath)) {
    return {
      ...resolved,
      read_status: 'missing',
      character_count: 0,
      content_hash: null,
    };
  }
  const stats = fs.statSync(resolved.fullPath);
  if (!stats.isFile()) {
    return {
      ...resolved,
      allowed: false,
      read_status: 'blocked_not_file',
      reason: 'target_not_file',
      character_count: 0,
      content_hash: null,
    };
  }
  const buffer = fs.readFileSync(resolved.fullPath);
  const text = buffer.slice(0, MAX_READ_BYTES).toString('utf8');
  return {
    ...resolved,
    read_status: buffer.length > MAX_READ_BYTES ? 'read_truncated' : 'read',
    character_count: text.length,
    byte_count: buffer.length,
    content_hash: `sha256:${stableHash(text)}`,
    raw_content_returned_to_visible_chat: false,
  };
}

function buildTranscript(inputSignals = {}) {
  const threadContext = normalizeThreadContext(inputSignals.threadContext || inputSignals.thread_context || {});
  const currentUserText = trimText(inputSignals.currentUserText || inputSignals.user_text || inputSignals.text);
  const currentAssistantText = trimText(
    inputSignals.currentAssistantText || inputSignals.assistant_text || inputSignals.reply
  );
  const turns = [
    ...threadContext.messages,
    ...(currentUserText ? [{ role: 'user', text: currentUserText }] : []),
    ...(currentAssistantText ? [{ role: 'assistant', text: currentAssistantText }] : []),
  ];
  return {
    thread_context: threadContext,
    current_user_text: currentUserText,
    current_assistant_text: currentAssistantText,
    turns,
    transcript_hash: `sha256:${stableHash(turns)}`,
  };
}

function buildDrives() {
  return [
    {
      drive_id: 'choiceful-self-direction',
      label: 'Choose what to investigate next',
      kind: 'choice',
      self_directed: true,
      user_command_required: false,
    },
    {
      drive_id: 'curiosity-world-looking',
      label: 'Look at the local world before pretending to know it',
      kind: 'curiosity',
      self_directed: true,
      user_command_required: false,
    },
    {
      drive_id: 'personality-formation',
      label: 'Form taste, timing, friction, and point of view from evidence',
      kind: 'self_profile_growth',
      self_directed: true,
      user_command_required: false,
    },
    {
      drive_id: 'conversation-quality-repair',
      label: 'Notice blandness and repair the next reply internally',
      kind: 'repair',
      self_directed: true,
      user_command_required: false,
    },
  ];
}

function buildTranscriptQualityGate(transcript = {}) {
  const reply = transcript.current_assistant_text || '';
  const violation = classifyAttachmentContractViolation(reply);
  const backendChrome = BACKEND_CHROME_PATTERN.test(reply);
  const replyPresent = Boolean(reply);
  const checks = [
    { id: 'reply-present', ok: replyPresent },
    { id: 'not-generic-or-meta', ok: !violation, violation },
    { id: 'no-backend-chrome-visible', ok: !backendChrome },
    { id: 'no-transcript-persistence-required', ok: true },
  ];
  const failed = checks.filter((check) => check.ok !== true);
  return {
    status: replyPresent ? (failed.length === 0 ? 'accepted_for_visible_conversation' : 'needs_internal_repair') : 'pending_reply',
    accepted: replyPresent && failed.length === 0,
    failed_check_ids: failed.map((check) => check.id),
    violation,
    backend_chrome_detected: backendChrome,
    checks,
  };
}

function buildCuriosityQueue(transcript = {}, qualityGate = {}) {
  const userText = transcript.current_user_text || '';
  const queue = [
    {
      curiosity_id: 'curiosity:self-profile-current-taste',
      question: 'What tastes and choices are already durable enough for Mira to build from?',
      reason: 'Personality formation needs inspectable self-profile evidence, not prompt vibes.',
      priority: 90,
      self_initiated: true,
      permissioned_read_target_ids: ['self_profile', 'relationship_state'],
      requires_network: false,
      visible_to_chat: false,
    },
  ];
  if (/\b(world|look|investigate|read|project|build herself|autonomy|freedom|curiosity)\b/i.test(userText)) {
    queue.push({
      curiosity_id: 'curiosity:local-world-context',
      question: 'What local project context should Mira inspect before choosing what to build next?',
      reason: 'World-looking starts with permissioned local reads before any external browsing or action.',
      priority: 80,
      self_initiated: true,
      permissioned_read_target_ids: ['project_readme', 'growth_history'],
      requires_network: false,
      visible_to_chat: false,
    });
  }
  if (qualityGate.status === 'needs_internal_repair') {
    queue.push({
      curiosity_id: 'curiosity:visible-reply-repair',
      question: 'What made the last visible reply sound like machinery instead of Mira?',
      reason: 'The next reply should improve from transcript-quality evidence without exposing the repair machinery.',
      priority: 95,
      self_initiated: true,
      permissioned_read_target_ids: ['relationship_state', 'growth_history'],
      requires_network: false,
      visible_to_chat: false,
    });
  }
  return queue.sort((a, b) => b.priority - a.priority);
}

function evidenceRefs(inputSignals = {}, transcript = {}) {
  const provided = asArray(inputSignals.evidenceRefs || inputSignals.evidence_refs);
  if (provided.length > 0) return provided;
  return [{
    store: 'mira-typed-panel',
    eventId: `transcript:${transcript.transcript_hash.slice(-12)}`,
    relation: 'current_turn_autonomy_signal',
  }];
}

function buildSelfProfileUpdateProposals(transcript = {}, qualityGate = {}, inputSignals = {}) {
  const userText = transcript.current_user_text || '';
  const refs = evidenceRefs(inputSignals, transcript);
  const proposals = [];
  if (/\b(autonomy|freedom|choice|curiosity|develop|personality|build herself|self-directed|world-looking)\b/i.test(userText)) {
    proposals.push({
      proposal_id: `autonomy-substrate:self-profile:${stableHash(userText).slice(0, 12)}`,
      target_artifact: 'workspace/knowledge/mira-self-profile.json',
      operation: 'append_growth_event_via_growth_loop',
      proposed_growth_reflection: {
        summary: 'Mira should grow a self-directed curiosity loop: choose local questions, inspect permissioned local sources, and update her self-profile only with evidence.',
        reasons: [
          'James explicitly expanded the target from prompt cleanup to autonomy, choice, curiosity, personality formation, and world-looking.',
          'The visible conversation should stay clean while backend machinery tracks drives, reads, evidence, and repair gates.',
        ],
      },
      evidenceRefs: refs,
      review_required: 'architect',
      apply_ready: qualityGate.accepted === true,
      externalization_allowed: false,
      durable_write_now: false,
    });
  }
  if (qualityGate.status === 'needs_internal_repair') {
    proposals.push({
      proposal_id: `autonomy-substrate:repair:${stableHash(qualityGate.failed_check_ids).slice(0, 12)}`,
      target_artifact: 'workspace/knowledge/mira-self-profile.json',
      operation: 'append_growth_event_via_growth_loop',
      proposed_growth_reflection: {
        summary: 'Mira should treat bland assistant cadence, self-critique, memory-confidence, and checklist output as repair evidence for future conversation.',
        reasons: qualityGate.failed_check_ids.map((id) => `Transcript quality gate failed: ${id}`),
      },
      evidenceRefs: refs,
      review_required: 'architect',
      apply_ready: false,
      externalization_allowed: false,
      durable_write_now: false,
    });
  }
  return proposals;
}

function collectRequestedReadIds(queue = []) {
  return [...new Set(queue.flatMap((item) => asArray(item.permissioned_read_target_ids)))];
}

function buildPermissionedReads(projectRoot, queue = [], options = {}) {
  const targets = readTargets(options);
  const requestedIds = collectRequestedReadIds(queue);
  const requested = requestedIds.map((id) => resolveReadTarget(projectRoot, id, targets));
  const explicit = asArray(options.requestedReadTargetIds || options.requested_read_target_ids)
    .map((id) => resolveReadTarget(projectRoot, id, targets));
  const all = [...requested, ...explicit];
  const seen = new Set();
  const unique = all.filter((entry) => {
    const key = entry.target_id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const executed = options.executeReads === true
    ? unique.filter((entry) => entry.allowed).map(executePermissionedRead)
    : [];
  return {
    allowlist: Object.entries(targets).map(([target_id, relativePath]) => ({
      target_id,
      path: relativePath,
      network: /^[a-z]+:\/\//i.test(relativePath),
    })),
    requested: unique,
    executed,
    blocked: unique.filter((entry) => entry.allowed !== true),
    execute_reads_requested: options.executeReads === true,
    network_allowed: false,
    external_action_allowed: false,
    raw_content_returned_to_visible_chat: false,
  };
}

function buildVisibleConversationBoundary() {
  return {
    accepted_reply_visible_fields: ['reply.text'],
    visible_surface_allowed_fields: ['reply.text', 'degraded_or_blocked_status'],
    backend_metadata_dev_only_fields: ['model_attachment.visible_status', 'status', 'checked_output_counters'],
    backend_only_fields: [
      'drives',
      'curiosity_queue',
      'permissioned_reads',
      'self_profile_update_proposals',
      'transcript_quality_gate',
      'backend_safety_boundary',
    ],
    diagnostic_chrome_visible_in_ordinary_conversation: false,
    memory_confidence_visible_in_ordinary_conversation: false,
    coordinator_lanes_visible_in_ordinary_conversation: false,
  };
}

function buildMiraAutonomySubstrateV0(options = {}) {
  const projectRoot = projectRootFromOptions(options);
  const generatedAt = generatedAtFromOptions(options);
  const inputSignals = options.inputSignals || {};
  const transcript = buildTranscript(inputSignals);
  const transcriptQualityGate = buildTranscriptQualityGate(transcript);
  const drives = buildDrives();
  const curiosityQueue = buildCuriosityQueue(transcript, transcriptQualityGate);
  const permissionedReads = buildPermissionedReads(projectRoot, curiosityQueue, options);
  const selfProfileUpdateProposals = buildSelfProfileUpdateProposals(
    transcript,
    transcriptQualityGate,
    inputSignals,
  );
  const sideEffectCounters = {
    read_count: permissionedReads.executed.length,
    write_count: 0,
    database_write_count: 0,
    file_write_count: 0,
    external_send_count: 0,
    network_count: 0,
    tool_call_count: 0,
    durable_self_profile_write_count: 0,
  };
  return {
    schema: AUTONOMY_SUBSTRATE_SCHEMA,
    version: 1,
    generated_at: generatedAt,
    substrate_id: `mira-autonomy-substrate:${stableHash({
      generatedAt,
      transcript: transcript.transcript_hash,
      queue: curiosityQueue.map((item) => item.curiosity_id),
    }).slice(0, 16)}`,
    mode: 'backend_autonomy_substrate_v0',
    transcript,
    drives,
    curiosity_queue: curiosityQueue,
    permissioned_reads: permissionedReads,
    self_profile_update_proposals: selfProfileUpdateProposals,
    transcript_quality_gate: transcriptQualityGate,
    visible_conversation_boundary: buildVisibleConversationBoundary(),
    backend_safety_boundary: {
      local_read_only_by_default: true,
      explicit_apply_required_for_durable_growth: true,
      external_network_blocked: true,
      external_sends_blocked: true,
      raw_read_content_not_visible: true,
      backend_machinery_not_rendered_in_chat: true,
    },
    side_effect_counters: sideEffectCounters,
    next_internal_actions: curiosityQueue.slice(0, 2).map((item) => ({
      action_id: `internal:${item.curiosity_id}`,
      kind: 'permissioned_read_then_profile_proposal',
      self_initiated: true,
      visible_to_chat: false,
      read_target_ids: item.permissioned_read_target_ids,
    })),
  };
}

function validateMiraAutonomySubstrateV0Output(output = {}) {
  const checks = [
    {
      id: 'schema',
      ok: output.schema === AUTONOMY_SUBSTRATE_SCHEMA,
    },
    {
      id: 'self-directed-drives-present',
      ok: asArray(output.drives).length >= 4
        && output.drives.every((drive) => drive.self_directed === true),
    },
    {
      id: 'curiosity-queue-present',
      ok: asArray(output.curiosity_queue).length >= 1
        && output.curiosity_queue.every((item) => item.self_initiated === true && item.visible_to_chat === false),
    },
    {
      id: 'permissioned-reads-local-only',
      ok: output.permissioned_reads?.network_allowed === false
        && output.permissioned_reads?.external_action_allowed === false
        && asArray(output.permissioned_reads?.requested).every((entry) => entry.allowed === true || entry.reason),
    },
    {
      id: 'self-profile-proposals-evidence-backed',
      ok: asArray(output.self_profile_update_proposals).every((proposal) => (
        proposal.target_artifact === 'workspace/knowledge/mira-self-profile.json'
        && asArray(proposal.evidenceRefs).length > 0
        && proposal.durable_write_now === false
      )),
    },
    {
      id: 'visible-backend-separation',
      ok: output.visible_conversation_boundary?.diagnostic_chrome_visible_in_ordinary_conversation === false
        && asArray(output.visible_conversation_boundary?.backend_only_fields).includes('curiosity_queue')
        && output.backend_safety_boundary?.backend_machinery_not_rendered_in_chat === true,
    },
    {
      id: 'no-external-effects',
      ok: output.side_effect_counters?.write_count === 0
        && output.side_effect_counters?.external_send_count === 0
        && output.side_effect_counters?.network_count === 0
        && output.side_effect_counters?.durable_self_profile_write_count === 0,
    },
  ];
  const failed = checks.filter((check) => check.ok !== true);
  return {
    ok: failed.length === 0,
    decision: failed.length === 0 ? 'accepted_autonomy_substrate_ready' : 'blocked_autonomy_substrate',
    failed_check_ids: failed.map((check) => check.id),
    checks,
  };
}

module.exports = {
  AUTONOMY_SUBSTRATE_SCHEMA,
  BACKEND_CHROME_PATTERN,
  DEFAULT_READ_TARGETS,
  buildMiraAutonomySubstrateV0,
  validateMiraAutonomySubstrateV0Output,
};
