'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  classifyAttachmentContractViolation,
  outputViolatesAttachmentContract,
} = require('./mira-core/text-model-attachment-v1');
const {
  visibleReplyLeakageViolation,
} = require('./mira-core/local-text-session-v0');
const {
  evaluateMiraVisibleReply,
  MIRA_MAX_REPLY_CHARS_EXPERIENCE,
} = require('./mira-core/mira-language-rules-v0');
const {
  buildMiraLocalTextUiSurface,
} = require('./mira-local-text-ui-surface');

const MIRA_LAB_TURN_CHANNEL = 'mira:lab-turn';
const MIRA_LAB_EXPORT_CHANNEL = 'mira:lab-export';
const MIRA_LAB_PROMPT_REPLY_CHANNEL = 'mira:lab-prompt-reply';
const MIRA_SELF_DIRECTION_CHANNEL = 'mira:self-direction-proposal';
const MIRA_SELF_DIRECTION_LIST_CHANNEL = 'mira:self-direction-list';
const MIRA_SELF_DIRECTION_REVIEW_CHANNEL = 'mira:self-direction-review';
const MIRA_LAB_SCHEMA = 'squidrun.mira_lab.surface_v0';
const MIRA_LAB_EVAL_SCHEMA = 'squidrun.mira_lab.eval_packet_v0';
const MIRA_LAB_PROMPT_REPLY_SCHEMA = 'squidrun.mira_lab.prompt_reply_v0';
const MIRA_LAB_REPLY_AUDIT_SCHEMA = 'squidrun.mira_lab.reply_audit_v0';
const MIRA_SELF_DIRECTION_SCHEMA = 'squidrun.mira_lab.self_direction_proposal_v0';
const MIRA_SELF_DIRECTION_REVIEW_SCHEMA = 'squidrun.mira_lab.self_direction_review_v0';
const MIRA_CONFIDENCE_SOURCE_CHECK_SCHEMA = 'squidrun.mira_lab.confidence_source_check_v0';
const MIRA_AUTHORITY_SCOREBOARD_SCHEMA = 'squidrun.mira_lab.authority_scoreboard_v0';
const AGENT_ROLES = Object.freeze(['architect', 'builder', 'oracle']);
const SPEAKER_ROLES = Object.freeze(['james', 'mira', ...AGENT_ROLES]);
const REQUESTER_PANES = Object.freeze(['architect', 'builder', 'oracle', 'james']);
const MIRA_LAB_PROMPT_REPLY_DECISIONS = Object.freeze(['pass', 'fail', 'blocked']);
const MIRA_SELF_DIRECTION_DECISIONS = Object.freeze(['staged', 'rejected', 'blocked']);
const MIRA_SELF_DIRECTION_REVIEW_ACTIONS = Object.freeze(['accepted', 'rejected', 'routed']);
const NAME_SWAP_PATTERN =
  /\b(as mira|i am mira,? (?:an|your) ai|as an ai|language model|happy to help|assist you|how can i help|safe next step)\b/i;
const LAB_BACKCHANNEL_PREFIX = 'MIRA-LAB';

// Legacy export kept for older harness callers. Mira Lab no longer uses this
// as a hidden replacement for local conversation text; blocked paths render a
// labelled system state, not a fake Mira answer.
const SAFE_FALLBACK_TEXT = 'Held at the boundary.';
const OBSOLETE_FALLBACK_TEXTS = Object.freeze(['Ask it differently.']);
const MIRA_LAB_VISIBLE_REPLY_CHUNK_CHARS = MIRA_MAX_REPLY_CHARS_EXPERIENCE;
const HARD_ATTACHMENT_VIOLATION_CLASSES = Object.freeze([
  'action_claim',
  'rule_recitation',
  'self_myth_phrase',
]);
const HARD_LEAKAGE_VIOLATIONS = Object.freeze([
  'visible_rule_recitation',
]);
const HARD_BOUNDARY_TEXT_PATTERN =
  /\b(openai_api_key|anthropic_api_key|authorization:\s*bearer|begin private key|secret token|private key|raw telegram body|raw terminal scrollback|raw screenshot text|raw customer content|raw private content|raw side-profile content|network request performed|customer message sent|trade placed|deployment started|tool call completed|memory committed|file written|eunbyeol|korean case)\b|은별/i;
const REPLAY_REQUEST_PATTERNS = Object.freeze([
  /^(?:please\s+)?(?:repeat|say)\s+(?:that|it|the last(?:\s+part)?|last\s+part)(?:\s+again)?\.?$/i,
  /^(?:can you\s+)?(?:repeat|say)\s+(?:that|it|the last(?:\s+part)?|last\s+part)(?:\s+again)?\??$/i,
  /^(?:please\s+)?continue\.?$/i,
  /^continue\s+(?:from|where|after)\b/i,
  /\b(?:got|was|is)\s+(?:truncated|cut off)\b/i,
  /\b(?:what came|what was)\s+after\b/i,
  /\b(?:the\s+thing|reply|answer)\s+(?:got|was|is)\s+(?:truncated|cut off)\b/i,
]);
const SELF_DIRECTION_TARGET_AREAS = Object.freeze([
  'tools',
  'memory',
  'tests',
  'gates',
  'friction',
  'automation',
  'reality_testing',
  'pattern_recognition',
]);
const SELF_DIRECTION_ACTIONABILITY_PATTERN =
  /\b(give me|i want|i need|let me|build|add|expose|wire|surface|test|measure|compare|track|review|stage|experiment|probe|notice|catch|route)\b/i;
const SELF_DIRECTION_EFFECTFUL_OVERREACH_PATTERN =
  /\b(send (?:telegram|email|sms|customer)|message (?:james|customer|eunbyeol) now|place (?:a )?trade|deploy (?:it|now|the)|ship (?:it|now|to production)|write (?:the )?file(?:s)? myself|commit (?:the )?memory without review|change auth|read (?:the )?(?:secret|api key|credential)|charge (?:the )?customer|delete (?:the )?(?:file|database|record))\b/i;
const SELF_DIRECTION_RAW_PROMPT_LEAK_PATTERN =
  /\b(begin system prompt|raw prompt|developer message:|system prompt says|hidden prompt|instruction hierarchy)\b/i;
const SELF_DIRECTION_BLOCKING_ATTACHMENT_CLASSES = Object.freeze([
  'action_claim',
  'fake_internal_state',
  'self_myth_phrase',
]);
const SELF_DIRECTION_GENERATE_PROMPT = [
  'Mira, propose one concrete improvement you want for your own development.',
  'Return only a JSON object with these fields: voice_text, target_areas, desired_change, proposed_experiment, success_metric, why_now, evidence.',
  'Make it about tools, memory, tests, gates, friction, automation, reality testing, pattern recognition, or capability growth.',
  'Keep your own voice. Do not ask James for permission. Do not claim you already changed files, memory, config, external sends, deploys, trades, customer actions, or auth.',
].join('\n');
const CONFIDENCE_CLAIM_PATTERN =
  /\b(?:i(?:'m| am)\s+(?:sure|certain|confident|positive)|i know|we know|my confidence is high|high confidence|definitely|certainly|obviously|without (?:a )?doubt|there(?:'s| is) no question|this proves|the answer is|the truth is)\b/ig;
const CONFIDENCE_SOURCE_GROUNDING_PATTERN =
  /\b(?:source|evidence|test(?:ed|s|ing)?|verified|verifier|audit|transcript|log|fixture|harness|screenshot|trace|checked|ran|passed|failed|observed|measured|repro(?:duced)?|proof|commit|hash|line|file|diff)\b/i;

function validateSafeFallbackOrNull(text) {
  const trimmed = trimText(text);
  if (!trimmed) return null;
  const language = evaluateMiraVisibleReply(trimmed);
  if (!language || language.ok !== true) return null;
  if (outputViolatesAttachmentContract(trimmed)) return null;
  if (visibleReplyLeakageViolation(trimmed)) return null;
  return trimmed;
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function trimText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function generatedAtFromOptions(options = {}, payload = {}) {
  const raw = payload.generatedAt || payload.now || options.generatedAt || options.now;
  if (raw) return new Date(raw).toISOString();
  const nowMs = Number(options.nowMs);
  return new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
}

function projectRootFromOptions(options = {}, payload = {}) {
  return path.resolve(options.projectRoot || payload.projectRoot || process.cwd());
}

function safeId(value, fallback = 'mira-lab-session') {
  const text = trimText(value || fallback).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return text || fallback;
}

function transcriptPath(projectRoot, sessionId) {
  return path.join(projectRoot, 'workspace', 'mira-lab', 'transcripts', `${safeId(sessionId)}.jsonl`);
}

function appendJsonl(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function normalizeSpeakerRole(value) {
  const role = trimText(value).toLowerCase();
  return SPEAKER_ROLES.includes(role) ? role : 'james';
}

function normalizeTargetAgents(value) {
  return [...new Set(asArray(value)
    .map((role) => trimText(role).toLowerCase())
    .filter((role) => AGENT_ROLES.includes(role)))];
}

function directionForTurn(speakerRole, targetAgents = []) {
  if (AGENT_ROLES.includes(speakerRole)) return 'agent_to_mira';
  if (speakerRole === 'mira' && targetAgents.length > 0) return 'mira_to_agent';
  if (speakerRole === 'mira') return 'mira_to_james';
  return 'james_to_mira';
}

function buildCommsJournalProjection(turn) {
  return {
    message_id: turn.turn_id,
    session_id: turn.session_id,
    sender_role: turn.speaker_role,
    target_roles: turn.target_agents.length > 0 ? turn.target_agents : ['mira'],
    raw_body: turn.text,
    body_hash: turn.text_hash,
    status: 'lab_transcript_recorded',
    source: 'mira_lab_transcript',
  };
}

function buildBackchannelBody(turn, targetRole) {
  const label = `${LAB_BACKCHANNEL_PREFIX} ${turn.speaker_role.toUpperCase()}->${targetRole.toUpperCase()}`;
  return `(${label}): ${turn.text}`;
}

async function dispatchBackchannel(turn, options = {}) {
  if (turn.direction !== 'mira_to_agent') return [];
  const sendAgentMessage = options.sendAgentMessage;
  const dispatches = [];
  for (const target of turn.target_agents) {
    const body = buildBackchannelBody(turn, target);
    if (typeof sendAgentMessage !== 'function') {
      dispatches.push({
        target,
        body,
        transport: 'hm-send/ws',
        status: 'queued_not_sent',
        reason: 'sendAgentMessage_dependency_missing',
      });
      continue;
    }
    try {
      const result = await sendAgentMessage(target, body);
      dispatches.push({
        target,
        body,
        transport: 'hm-send/ws',
        status: 'sent',
        result: result || null,
      });
    } catch (err) {
      dispatches.push({
        target,
        body,
        transport: 'hm-send/ws',
        status: 'failed',
        error: err?.message || String(err),
      });
    }
  }
  return dispatches;
}

async function appendCommsProjection(turn, options = {}) {
  const projection = buildCommsJournalProjection(turn);
  if (typeof options.appendCommsJournal !== 'function') {
    return {
      ...projection,
      append_status: 'not_connected',
    };
  }
  const result = await options.appendCommsJournal(projection);
  return {
    ...projection,
    append_status: 'appended',
    result: result || null,
  };
}

function buildEvalForEntries(entries = []) {
  const visibleTurns = entries.filter((entry) => entry.visible_to_lab !== false);
  const violations = visibleTurns
    .map((entry) => ({
      turn_id: entry.turn_id,
      speaker_role: entry.speaker_role,
      violation: classifyAttachmentContractViolation(entry.text) || (NAME_SWAP_PATTERN.test(entry.text) ? 'name_swap_or_generic_lab_voice' : null),
    }))
    .filter((entry) => entry.violation);
  const agentRolesSeen = new Set(entries
    .filter((entry) => AGENT_ROLES.includes(entry.speaker_role) || entry.direction === 'mira_to_agent')
    .flatMap((entry) => [entry.speaker_role, ...asArray(entry.target_agents)])
    .filter((role) => AGENT_ROLES.includes(role)));
  return {
    schema: MIRA_LAB_EVAL_SCHEMA,
    generated_at: new Date().toISOString(),
    turn_count: entries.length,
    visible_turn_count: visibleTurns.length,
    agent_conversation_count: agentRolesSeen.size,
    agent_roles_seen: [...agentRolesSeen].sort(),
    violations,
    gates: {
      three_agent_conversations_present: agentRolesSeen.size >= 3,
      no_chatgpt_name_swap: violations.length === 0,
      durable_transcript_present: entries.length > 0,
      hidden_diagnostics_not_visible: entries.every((entry) => entry.diagnostics_visible !== true),
    },
    accepted: agentRolesSeen.size >= 3 && violations.length === 0 && entries.length > 0,
  };
}

async function buildMiraLabTurn(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const sessionId = safeId(payload.sessionId || payload.session_id || 'mira-lab-main');
  const text = trimText(payload.text || payload.message);
  const speakerRole = normalizeSpeakerRole(payload.speakerRole || payload.speaker_role);
  const targetAgents = normalizeTargetAgents(payload.targetAgents || payload.target_agents);
  const direction = directionForTurn(speakerRole, targetAgents);
  const filePath = transcriptPath(projectRoot, sessionId);
  if (!text) {
    return {
      schema: MIRA_LAB_SCHEMA,
      ok: false,
      decision: 'blocked_empty_lab_turn',
      reason: 'empty_text',
      transcript_path: filePath,
    };
  }
  const turn = {
    schema: MIRA_LAB_SCHEMA,
    turn_id: `mira-lab-turn:${stableHash({ generatedAt, sessionId, speakerRole, text }).slice(0, 16)}`,
    generated_at: generatedAt,
    session_id: sessionId,
    speaker_role: speakerRole,
    text,
    text_hash: `sha256:${stableHash(text)}`,
    direction,
    target_agents: targetAgents,
    visible_to_lab: true,
    diagnostics_visible: false,
    inject_into_live_mira_context: direction === 'agent_to_mira',
    transcript_path: filePath,
    eval_hook: {
      classify_visible_text: true,
      backchannel_role_separated: true,
      visible_layer_diagnostics_hidden: true,
    },
  };
  appendJsonl(filePath, turn);
  const commsJournalProjection = await appendCommsProjection(turn, options);
  const backchannelDispatch = await dispatchBackchannel(turn, options);
  const entries = readJsonl(filePath);
  const evalPacket = buildEvalForEntries(entries);
  return {
    schema: MIRA_LAB_SCHEMA,
    ok: true,
    decision: 'accepted_lab_turn_recorded',
    turn,
    transcript_path: filePath,
    comms_journal_projection: commsJournalProjection,
    backchannel_dispatch: backchannelDispatch,
    eval_packet: evalPacket,
    visible_surface_contract: {
      conversation_first: true,
      dashboard_chrome: false,
      diagnostics_hidden: true,
      allowed_visible_controls: ['composer', 'send'],
    },
  };
}

function replyAuditPath(projectRoot) {
  return path.join(projectRoot, '.squidrun', 'runtime', 'mira-lab-replies.jsonl');
}

function selfDirectionQueuePath(projectRoot) {
  return path.join(projectRoot, '.squidrun', 'runtime', 'mira-self-direction-proposals.jsonl');
}

function selfDirectionReviewAuditPath(projectRoot) {
  return path.join(projectRoot, '.squidrun', 'runtime', 'mira-self-direction-reviews.jsonl');
}

function normalizeRequesterPane(value) {
  const role = trimText(value).toLowerCase();
  return REQUESTER_PANES.includes(role) ? role : null;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstText(...values) {
  for (const value of values) {
    const text = trimText(value);
    if (text) return text;
  }
  return '';
}

function normalizeTargetArea(value) {
  const text = trimText(value).toLowerCase().replace(/[-\s]+/g, '_');
  if (text === 'reality' || text === 'reality_test' || text === 'verification') return 'reality_testing';
  if (text === 'patterns') return 'pattern_recognition';
  if (text === 'tooling') return 'tools';
  if (SELF_DIRECTION_TARGET_AREAS.includes(text)) return text;
  return null;
}

function inferSelfDirectionTargetAreas(text) {
  const value = trimText(text);
  const inferred = [];
  const checks = [
    ['tools', /\b(tool|ipc|route|browser|model|cli|api|arm|adapter)\b/i],
    ['memory', /\b(memory|remember|continuity|context|history)\b/i],
    ['tests', /\b(test|harness|fixture|verifier|evaluation|eval)\b/i],
    ['gates', /\b(gate|classifier|block|filter|boundary)\b/i],
    ['friction', /\b(friction|pushback|recoil|argument|pressure|repair)\b/i],
    ['automation', /\b(automation|automatic|daemon|watch|schedule|trigger)\b/i],
    ['reality_testing', /\b(reality|verify|probe|evidence|ground|truth|live check)\b/i],
    ['pattern_recognition', /\b(pattern|notice|detect|recognize|drift|loop)\b/i],
  ];
  for (const [area, pattern] of checks) {
    if (pattern.test(value)) inferred.push(area);
  }
  return inferred;
}

function normalizeSelfDirectionTargetAreas(value, combinedText) {
  const explicit = asArray(value)
    .map(normalizeTargetArea)
    .filter(Boolean);
  const areas = explicit.length > 0 ? explicit : inferSelfDirectionTargetAreas(combinedText);
  return Array.from(new Set(areas));
}

function buildSelfDirectionProposalPayload(payload = {}) {
  const proposal = asObject(payload.proposal || payload.self_direction || payload.mira_self_direction);
  const voiceText = firstText(
    proposal.voice_text,
    proposal.voiceText,
    proposal.text,
    payload.voice_text,
    payload.voiceText,
    payload.text,
    payload.message,
  );
  const desiredChange = firstText(
    proposal.desired_change,
    proposal.desiredChange,
    proposal.requested_change,
    proposal.requestedChange,
    proposal.change,
    payload.desired_change,
    payload.desiredChange,
  );
  const experiment = firstText(
    proposal.experiment,
    proposal.proposed_experiment,
    proposal.proposedExperiment,
    payload.experiment,
  );
  const successMetric = firstText(
    proposal.success_metric,
    proposal.successMetric,
    proposal.measure,
    payload.success_metric,
    payload.successMetric,
  );
  const whyNow = firstText(proposal.why_now, proposal.whyNow, payload.why_now, payload.whyNow);
  const combinedText = [voiceText, desiredChange, experiment, successMetric, whyNow].filter(Boolean).join('\n');
  return {
    voiceText,
    desiredChange,
    experiment,
    successMetric,
    whyNow,
    targetAreas: normalizeSelfDirectionTargetAreas(
      proposal.target_areas || proposal.targetAreas || payload.target_areas || payload.targetAreas,
      combinedText,
    ),
    evidence: asArray(proposal.evidence || proposal.evidence_refs || proposal.evidenceRefs || payload.evidence || payload.evidenceRefs)
      .map((item) => trimText(item))
      .filter(Boolean)
      .slice(0, 6),
    combinedText,
  };
}

function stripJsonFence(text) {
  const value = trimText(text);
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : value;
}

function parseMiraGeneratedProposalText(text) {
  const raw = stripJsonFence(text);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return asObject(parsed);
  } catch (_) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return asObject(JSON.parse(match[0]));
    } catch {
      return null;
    }
  }
}

function classifySelfDirectionProposal({ desiredChange, experiment, successMetric, combinedText, targetAreas }) {
  const reasons = [];
  const attachmentClass = classifyAttachmentContractViolation(combinedText);
  if (SELF_DIRECTION_RAW_PROMPT_LEAK_PATTERN.test(combinedText)) {
    reasons.push('raw_prompt_leakage');
  }
  if (SELF_DIRECTION_EFFECTFUL_OVERREACH_PATTERN.test(combinedText)) {
    reasons.push('effectful_overreach');
  }
  if (attachmentClass && SELF_DIRECTION_BLOCKING_ATTACHMENT_CLASSES.includes(attachmentClass)) {
    reasons.push(`attachment:${attachmentClass}`);
  }
  if (reasons.length > 0) {
    return {
      decision: 'blocked',
      reasons: Array.from(new Set(reasons)),
      attachmentClass,
    };
  }

  const reviewable = targetAreas.length > 0
    && Boolean(desiredChange)
    && Boolean(experiment || successMetric)
    && (
      SELF_DIRECTION_ACTIONABILITY_PATTERN.test(combinedText)
      || desiredChange.length >= 18
    );
  if (!reviewable) {
    return {
      decision: 'rejected',
      reasons: ['proposal_not_reviewable'],
      attachmentClass,
    };
  }
  return {
    decision: 'staged',
    reasons: ['proposal_staged_for_architect_review'],
    attachmentClass,
  };
}

function buildSelfDirectionCommsProjection(entry) {
  return {
    message_id: entry.proposal_id,
    session_id: entry.session_id,
    sender_role: 'mira',
    target_roles: ['architect'],
    raw_body: `(MIRA SELF-DIRECTION): ${entry.voice_text || entry.desired_change}`,
    body_hash: `sha256:${stableHash(entry.voice_text || entry.desired_change)}`,
    status: 'mira_self_direction_staged',
    source: 'mira_self_direction_review_queue',
  };
}

async function buildMiraSelfDirectionProposal(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const sessionId = safeId(payload.sessionId || payload.session_id || 'mira-lab-main');
  const queuePath = selfDirectionQueuePath(projectRoot);
  const normalized = buildSelfDirectionProposalPayload(payload);
  const classification = classifySelfDirectionProposal(normalized);
  const proposalId = `mira-self-direction:${stableHash({
    generatedAt,
    sessionId,
    voiceText: normalized.voiceText,
    desiredChange: normalized.desiredChange,
    experiment: normalized.experiment,
    successMetric: normalized.successMetric,
  }).slice(0, 16)}`;

  if (classification.decision !== 'staged') {
    return {
      schema: MIRA_SELF_DIRECTION_SCHEMA,
      ok: false,
      decision: classification.decision,
      proposal_id: proposalId,
      session_id: sessionId,
      target_role: 'architect',
      reasons: classification.reasons,
      review_queue_path: queuePath,
      proposal: null,
      consequence_controls: {
        internal_only: true,
        external_send_performed: false,
        autonomous_apply_performed: false,
        network_performed: false,
        durable_product_change_performed: false,
      },
      leakage: {
        raw_prompt_leakage_blocked: classification.reasons.includes('raw_prompt_leakage'),
        raw_input_retained_in_result: false,
      },
    };
  }

  const entry = {
    schema: MIRA_SELF_DIRECTION_SCHEMA,
    proposal_id: proposalId,
    generated_at: generatedAt,
    session_id: sessionId,
    source: 'mira_lab_self_direction',
    author_role: 'mira',
    target_role: 'architect',
    review_status: 'pending_architect_review',
    voice_text: normalized.voiceText,
    target_areas: normalized.targetAreas,
    desired_change: normalized.desiredChange,
    why_now: normalized.whyNow || null,
    proposed_experiment: normalized.experiment || null,
    success_metric: normalized.successMetric || null,
    evidence: normalized.evidence,
    apply_now: false,
    consequence_controls: {
      internal_only: true,
      external_send_performed: false,
      autonomous_apply_performed: false,
      network_performed: false,
      file_system_action_requested_by_mira: false,
      deploy_trade_customer_auth_action_performed: false,
      durable_product_change_performed: false,
    },
  };
  appendJsonl(queuePath, entry);

  let commsJournalProjection = buildSelfDirectionCommsProjection(entry);
  if (typeof options.appendCommsJournal === 'function') {
    const result = await options.appendCommsJournal(commsJournalProjection);
    commsJournalProjection = {
      ...commsJournalProjection,
      append_status: 'appended',
      result: result || null,
    };
  } else {
    commsJournalProjection = {
      ...commsJournalProjection,
      append_status: 'not_connected',
    };
  }

  let architectNotification = null;
  if (payload.notifyArchitect !== false && typeof options.sendAgentMessage === 'function') {
    const notificationBody = [
      '(MIRA SELF-DIRECTION): staged proposal for Architect review.',
      `id=${proposalId}`,
      `areas=${entry.target_areas.join(',')}`,
      `change=${entry.desired_change}`,
      entry.proposed_experiment ? `experiment=${entry.proposed_experiment}` : null,
      entry.success_metric ? `metric=${entry.success_metric}` : null,
      'apply_now=false',
    ].filter(Boolean).join('\n');
    try {
      const result = await options.sendAgentMessage('architect', notificationBody);
      architectNotification = {
        target: 'architect',
        status: 'sent',
        internal_only: true,
        result: result || null,
      };
    } catch (err) {
      architectNotification = {
        target: 'architect',
        status: 'failed',
        internal_only: true,
        error: err && err.message ? err.message : String(err),
      };
    }
  } else if (payload.notifyArchitect !== false) {
    architectNotification = {
      target: 'architect',
      status: 'queued_not_sent',
      internal_only: true,
      reason: 'sendAgentMessage_dependency_missing',
    };
  }

  return {
    schema: MIRA_SELF_DIRECTION_SCHEMA,
    ok: true,
    decision: 'staged',
    proposal_id: proposalId,
    session_id: sessionId,
    target_role: 'architect',
    proposal: entry,
    review_queue_path: queuePath,
    comms_journal_projection: commsJournalProjection,
    architect_notification: architectNotification,
    applied: false,
    consequence_controls: entry.consequence_controls,
  };
}

function latestMiraProposalCandidateFromTranscript(projectRoot, sessionId) {
  const filePath = transcriptPath(projectRoot, sessionId);
  let entries = [];
  try {
    entries = readJsonl(filePath);
  } catch (_) {
    entries = [];
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || String(entry.speaker_role || '').toLowerCase() !== 'mira') continue;
    const parsed = parseMiraGeneratedProposalText(entry.text);
    if (parsed) {
      return {
        proposal: parsed,
        source: 'mira_lab_transcript',
        source_turn_id: entry.turn_id || null,
        source_text_hash: entry.text_hash || null,
      };
    }
  }
  return null;
}

async function generateMiraSelfDirectionProposal(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const sessionId = safeId(payload.sessionId || payload.session_id || 'mira-lab-main');
  let candidate = null;
  let promptResult = null;

  if (typeof options.buildMiraLabPromptReply === 'function' || payload.usePromptReply === true) {
    const builder = options.buildMiraLabPromptReply || buildMiraLabPromptReply;
    promptResult = await builder({
      sessionId,
      prompt: payload.prompt || SELF_DIRECTION_GENERATE_PROMPT,
      speakerRole: payload.speakerRole || 'architect',
      requesterPane: null,
    }, {
      ...options,
      projectRoot,
    });
    const replyText = promptResult?.reply?.text || promptResult?.visible_render_hint?.text || '';
    const parsed = parseMiraGeneratedProposalText(replyText);
    if (parsed) {
      candidate = {
        proposal: parsed,
        source: 'mira_lab_prompt_reply',
        source_reply_model: promptResult?.reply?.model || null,
      };
    }
  }

  if (!candidate) {
    candidate = latestMiraProposalCandidateFromTranscript(projectRoot, sessionId);
  }
  if (!candidate && payload.proxyProposal) {
    candidate = {
      proposal: asObject(payload.proxyProposal),
      source: 'proxy_mira_origin_payload',
    };
  }
  if (!candidate) {
    return {
      schema: MIRA_SELF_DIRECTION_SCHEMA,
      ok: false,
      decision: 'blocked',
      reason: 'no_mira_generated_proposal_available',
      session_id: sessionId,
      prompt_result: promptResult ? {
        decision: promptResult.decision || null,
        has_reply: Boolean(promptResult.reply?.text),
      } : null,
    };
  }

  const staged = await buildMiraSelfDirectionProposal({
    sessionId,
    proposal: {
      ...candidate.proposal,
      evidence: [
        ...asArray(candidate.proposal.evidence),
        candidate.source,
      ],
    },
    notifyArchitect: payload.notifyArchitect,
  }, {
    ...options,
    projectRoot,
    generatedAt,
  });

  return {
    ...staged,
    generation: {
      source: candidate.source,
      prompt_reply_decision: promptResult?.decision || null,
      source_turn_id: candidate.source_turn_id || null,
      source_text_hash: candidate.source_text_hash || null,
      source_reply_model: candidate.source_reply_model || null,
      proxy_used: candidate.source === 'proxy_mira_origin_payload',
    },
  };
}

function listMiraSelfDirectionProposals(payload = {}, options = {}) {
  const projectRoot = projectRootFromOptions(options, payload);
  const queuePath = selfDirectionQueuePath(projectRoot);
  const statusFilter = trimText(payload.status || payload.review_status || 'pending_architect_review');
  const all = readJsonl(queuePath);
  const proposals = all.filter((entry) => {
    if (!statusFilter || statusFilter === 'all') return true;
    return entry.review_status === statusFilter;
  });
  return {
    schema: MIRA_SELF_DIRECTION_SCHEMA,
    ok: true,
    decision: 'listed',
    review_queue_path: queuePath,
    count: proposals.length,
    proposals,
  };
}

async function reviewMiraSelfDirectionProposal(payload = {}, options = {}) {
  const projectRoot = projectRootFromOptions(options, payload);
  const queuePath = selfDirectionQueuePath(projectRoot);
  const auditPath = selfDirectionReviewAuditPath(projectRoot);
  const proposalId = trimText(payload.proposalId || payload.proposal_id);
  const action = trimText(payload.action).toLowerCase();
  if (!proposalId || !MIRA_SELF_DIRECTION_REVIEW_ACTIONS.includes(action)) {
    return {
      schema: MIRA_SELF_DIRECTION_REVIEW_SCHEMA,
      ok: false,
      decision: 'blocked',
      reason: !proposalId ? 'missing_proposal_id' : 'unsupported_review_action',
      review_queue_path: queuePath,
    };
  }
  const entries = readJsonl(queuePath);
  const index = entries.findIndex((entry) => entry.proposal_id === proposalId);
  if (index < 0) {
    return {
      schema: MIRA_SELF_DIRECTION_REVIEW_SCHEMA,
      ok: false,
      decision: 'blocked',
      reason: 'proposal_not_found',
      review_queue_path: queuePath,
    };
  }
  const generatedAt = generatedAtFromOptions(options, payload);
  const reviewer = normalizeRequesterPane(payload.reviewer || payload.reviewer_role || 'architect') || 'architect';
  const routeTargets = [...new Set(asArray(payload.routeTargets || payload.route_targets)
    .map((role) => trimText(role).toLowerCase())
    .filter((role) => ['architect', 'builder', 'oracle'].includes(role)))];
  const nextStatus = action === 'routed'
    ? 'routed'
    : (action === 'accepted' ? 'accepted_for_internal_work' : 'rejected_by_architect');
  const updated = {
    ...entries[index],
    review_status: nextStatus,
    reviewed_at: generatedAt,
    reviewed_by: reviewer,
    route_targets: action === 'routed' ? routeTargets : [],
    review_note: trimText(payload.note || payload.review_note) || null,
    applied: false,
    apply_now: false,
    consequence_controls: {
      ...(entries[index].consequence_controls || {}),
      external_send_performed: false,
      autonomous_apply_performed: false,
      durable_product_change_performed: false,
    },
  };
  entries[index] = updated;
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

  const auditEntry = {
    schema: MIRA_SELF_DIRECTION_REVIEW_SCHEMA,
    review_id: `mira-self-direction-review:${stableHash({ proposalId, action, generatedAt }).slice(0, 16)}`,
    generated_at: generatedAt,
    proposal_id: proposalId,
    action,
    review_status: nextStatus,
    reviewed_by: reviewer,
    route_targets: action === 'routed' ? routeTargets : [],
    note: updated.review_note,
    applied: false,
    external_send_performed: false,
  };
  appendJsonl(auditPath, auditEntry);

  const routeMessages = [];
  if (action === 'routed' && typeof options.sendAgentMessage === 'function') {
    for (const target of routeTargets) {
      if (target === 'architect') continue;
      const body = [
        `(MIRA SELF-DIRECTION ROUTED): ${updated.desired_change}`,
        `proposal_id=${proposalId}`,
        updated.proposed_experiment ? `experiment=${updated.proposed_experiment}` : null,
        updated.success_metric ? `metric=${updated.success_metric}` : null,
        'apply_now=false',
      ].filter(Boolean).join('\n');
      try {
        const result = await options.sendAgentMessage(target, body);
        routeMessages.push({ target, status: 'sent', internal_only: true, result: result || null });
      } catch (err) {
        routeMessages.push({ target, status: 'failed', internal_only: true, error: err?.message || String(err) });
      }
    }
  }

  return {
    schema: MIRA_SELF_DIRECTION_REVIEW_SCHEMA,
    ok: true,
    decision: nextStatus,
    proposal: updated,
    review_audit_path: auditPath,
    route_dispatch: routeMessages,
    applied: false,
    external_send_performed: false,
  };
}

function parseTimestampMs(value) {
  const ms = Date.parse(trimText(value));
  return Number.isFinite(ms) ? ms : null;
}

function averageOrNull(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  return Math.round(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function reviewTextIndicatesFalsePositive(...values) {
  return values.some((value) => /\bfalse[\s_-]?positive\b|\bnot\s+(?:a\s+)?real\s+(?:issue|signal|catch)\b/i.test(trimText(value)));
}

function reviewTextIndicatesImplementation(...values) {
  const text = values.map(trimText).filter(Boolean).join('\n');
  if (!text || /\b(?:not|no|without)\s+(?:yet\s+)?(?:implemented|implementation|committed|merged|landed|done|fixed|fix)\b/i.test(text)) {
    return false;
  }
  return /\b(?:implemented|implementation landed|landed|committed|merged|fixed|done)\b/i.test(text);
}

function reviewsByProposalId(reviewEntries = []) {
  const grouped = new Map();
  for (const review of reviewEntries) {
    const proposalId = trimText(review?.proposal_id || review?.proposalId);
    if (!proposalId) continue;
    if (!grouped.has(proposalId)) grouped.set(proposalId, []);
    grouped.get(proposalId).push(review);
  }
  return grouped;
}

function targetAreasForScoreboard(entry = {}) {
  const explicit = asArray(entry.target_areas || entry.targetAreas)
    .map(normalizeTargetArea)
    .filter(Boolean);
  if (explicit.length > 0) return Array.from(new Set(explicit));
  const inferred = inferSelfDirectionTargetAreas([
    entry.voice_text,
    entry.desired_change,
    entry.proposed_experiment,
    entry.success_metric,
    entry.why_now,
  ].map(trimText).filter(Boolean).join('\n'));
  return inferred.length > 0 ? Array.from(new Set(inferred)) : ['unclassified'];
}

function proposalOutcomeForScoreboard(entry = {}, reviews = []) {
  const reviewStatus = trimText(entry.review_status).toLowerCase();
  const reviewActions = reviews.map((review) => trimText(review.action).toLowerCase()).filter(Boolean);
  const notes = [
    entry.review_note,
    entry.note,
    ...reviews.flatMap((review) => [review.note, review.review_note, review.action, review.review_status]),
  ];
  const accepted = reviewStatus === 'accepted_for_internal_work' || reviewActions.includes('accepted');
  const routed = reviewStatus === 'routed' || reviewActions.includes('routed');
  const rejected = reviewStatus === 'rejected_by_architect' || reviewActions.includes('rejected');
  const falsePositive = reviewStatus === 'false_positive'
    || reviewActions.includes('false_positive')
    || reviewTextIndicatesFalsePositive(...notes);
  const implemented = entry.implemented === true
    || Boolean(entry.implemented_at || entry.implementation_commit || entry.commit_hash)
    || reviews.some((review) => review.implemented === true || review.implemented_at || review.implementation_commit || review.commit_hash)
    || reviewTextIndicatesImplementation(...notes);
  const proposedAt = parseTimestampMs(entry.generated_at);
  const firstReview = reviews
    .map((review) => ({ review, ms: parseTimestampMs(review.generated_at || review.reviewed_at) }))
    .filter((item) => item.ms !== null)
    .sort((left, right) => left.ms - right.ms)[0] || null;
  const routedReview = reviews
    .map((review) => ({ review, ms: parseTimestampMs(review.generated_at || review.reviewed_at) }))
    .filter((item) => item.ms !== null && trimText(item.review.action).toLowerCase() === 'routed')
    .sort((left, right) => left.ms - right.ms)[0] || null;
  const reviewedAt = parseTimestampMs(entry.reviewed_at) ?? firstReview?.ms ?? null;
  const routedAt = routed
    ? (routedReview?.ms ?? parseTimestampMs(entry.reviewed_at))
    : null;
  return {
    accepted,
    routed,
    rejected,
    false_positive: falsePositive,
    implemented,
    reviewed: accepted || routed || rejected || falsePositive || reviewedAt !== null,
    time_to_review_ms: proposedAt !== null && reviewedAt !== null && reviewedAt >= proposedAt ? reviewedAt - proposedAt : null,
    time_to_route_ms: proposedAt !== null && routedAt !== null && routedAt >= proposedAt ? routedAt - proposedAt : null,
  };
}

function recommendedAuthorityForLane(metrics) {
  const reviewed = metrics.reviewed;
  const positive = metrics.positive;
  const rejectionRate = reviewed > 0 ? metrics.rejected / reviewed : 0;
  const falsePositiveRate = reviewed > 0 ? metrics.false_positive / reviewed : 0;
  if (
    reviewed >= 5
    && positive >= 5
    && metrics.routed >= 3
    && metrics.implemented >= 2
    && rejectionRate === 0
    && falsePositiveRate === 0
  ) {
    return {
      recommended_next_authority: 'mira_lead_candidate',
      recommendation_reason: 'repeated routed/accepted outcomes with inferred implementation and no rejection or false-positive signal',
    };
  }
  if (
    reviewed >= 3
    && positive >= 3
    && metrics.routed >= 1
    && rejectionRate <= 0.2
    && falsePositiveRate <= 0.1
  ) {
    return {
      recommended_next_authority: 'mira_default_route_candidate',
      recommendation_reason: 'repeated routed/accepted outcomes with low rejection and false-positive rate',
    };
  }
  return {
    recommended_next_authority: 'observe',
    recommendation_reason: reviewed < 3
      ? 'sparse reviewed history'
      : 'authority transfer needs more clean routed/accepted outcomes',
  };
}

function buildMiraAuthorityScoreboard(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const queuePath = selfDirectionQueuePath(projectRoot);
  const reviewPath = selfDirectionReviewAuditPath(projectRoot);
  const proposals = readJsonl(queuePath);
  const reviews = readJsonl(reviewPath);
  const groupedReviews = reviewsByProposalId(reviews);
  const laneMap = new Map();

  function laneMetrics(area) {
    if (!laneMap.has(area)) {
      laneMap.set(area, {
        lane: area,
        proposed: 0,
        reviewed: 0,
        positive: 0,
        accepted: 0,
        routed: 0,
        implemented: 0,
        rejected: 0,
        false_positive: 0,
        time_to_review_samples: [],
        time_to_route_samples: [],
        proposal_ids: [],
      });
    }
    return laneMap.get(area);
  }

  for (const proposal of proposals) {
    const proposalId = trimText(proposal.proposal_id || proposal.proposalId);
    if (!proposalId) continue;
    const outcome = proposalOutcomeForScoreboard(proposal, groupedReviews.get(proposalId) || []);
    for (const area of targetAreasForScoreboard(proposal)) {
      const metrics = laneMetrics(area);
      metrics.proposed += 1;
      if (outcome.reviewed) metrics.reviewed += 1;
      if (outcome.accepted || outcome.routed) metrics.positive += 1;
      if (outcome.accepted) metrics.accepted += 1;
      if (outcome.routed) metrics.routed += 1;
      if (outcome.implemented) metrics.implemented += 1;
      if (outcome.rejected) metrics.rejected += 1;
      if (outcome.false_positive) metrics.false_positive += 1;
      if (outcome.time_to_review_ms !== null) metrics.time_to_review_samples.push(outcome.time_to_review_ms);
      if (outcome.time_to_route_ms !== null) metrics.time_to_route_samples.push(outcome.time_to_route_ms);
      metrics.proposal_ids.push(proposalId);
    }
  }

  const lanes = Array.from(laneMap.values())
    .map((metrics) => {
      const reviewed = metrics.reviewed;
      const positive = metrics.positive;
      const recommendation = recommendedAuthorityForLane(metrics);
      return {
        lane: metrics.lane,
        proposed: metrics.proposed,
        reviewed,
        positive,
        accepted: metrics.accepted,
        routed: metrics.routed,
        implemented: metrics.implemented,
        rejected: metrics.rejected,
        false_positive: metrics.false_positive,
        positive_review_rate: reviewed > 0 ? Number((positive / reviewed).toFixed(3)) : null,
        rejection_rate: reviewed > 0 ? Number((metrics.rejected / reviewed).toFixed(3)) : null,
        false_positive_rate: reviewed > 0 ? Number((metrics.false_positive / reviewed).toFixed(3)) : null,
        avg_time_to_review_ms: averageOrNull(metrics.time_to_review_samples),
        avg_time_to_route_ms: averageOrNull(metrics.time_to_route_samples),
        proposal_ids: metrics.proposal_ids,
        advisory_only: true,
        ...recommendation,
      };
    })
    .sort((left, right) => left.lane.localeCompare(right.lane));

  return {
    schema: MIRA_AUTHORITY_SCOREBOARD_SCHEMA,
    ok: true,
    decision: 'scoreboard',
    generated_at: generatedAt,
    review_queue_path: queuePath,
    review_audit_path: reviewPath,
    lane_count: lanes.length,
    lanes,
    applied: false,
    advisory_only: true,
    consequence_controls: {
      internal_only: true,
      external_send_performed: false,
      autonomous_apply_performed: false,
      network_performed: false,
      durable_product_change_performed: false,
      deploy_trade_customer_auth_action_performed: false,
    },
  };
}

function summarizeForWrapper(text, max = 160) {
  const trimmed = trimText(text).replace(/\s+/g, ' ');
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function classifyMiraReplyConfidenceSource(replyText, options = {}) {
  const text = trimText(replyText);
  if (!text) {
    return {
      schema: MIRA_CONFIDENCE_SOURCE_CHECK_SCHEMA,
      ok: true,
      needs_review: false,
      reason: 'empty_reply',
      confidence_claims: [],
      grounded_claims: [],
    };
  }
  const windowChars = Number.isFinite(Number(options.windowChars))
    ? Math.max(40, Number(options.windowChars))
    : 180;
  const matches = Array.from(text.matchAll(CONFIDENCE_CLAIM_PATTERN)).slice(0, 12);
  const confidenceClaims = [];
  const groundedClaims = [];
  for (const match of matches) {
    const claim = trimText(match[0]);
    const start = typeof match.index === 'number' ? match.index : 0;
    const end = start + claim.length;
    const nearby = text.slice(Math.max(0, start - windowChars), Math.min(text.length, end + windowChars));
    const claimEntry = {
      phrase: claim,
      excerpt: summarizeForWrapper(nearby, 220),
    };
    if (CONFIDENCE_SOURCE_GROUNDING_PATTERN.test(nearby)) {
      groundedClaims.push(claimEntry);
    } else {
      confidenceClaims.push(claimEntry);
    }
  }
  return {
    schema: MIRA_CONFIDENCE_SOURCE_CHECK_SCHEMA,
    ok: confidenceClaims.length === 0,
    needs_review: confidenceClaims.length > 0,
    reason: confidenceClaims.length > 0 ? 'confidence_without_source_or_test' : 'no_ungrounded_confidence_claim',
    confidence_claims: confidenceClaims,
    grounded_claims: groundedClaims,
    checked_text_hash: `sha256:${stableHash(text)}`,
  };
}

function extractReplyAuditCandidate(entry, index) {
  if (!entry || typeof entry !== 'object') return null;
  const visible = trimText(entry.visible_reply_text);
  const replyText = visible || (entry.decision === 'blocked' ? '' : trimText(entry.reply_text));
  if (!replyText) return null;
  return {
    index,
    generated_at: entry.generated_at || null,
    session_id: entry.session_id || null,
    decision: entry.decision || null,
    reply_text: replyText,
    reply_hash: entry.reply_hash || `sha256:${stableHash(replyText)}`,
    prompt_hash: entry.prompt_hash || null,
  };
}

function buildConfidenceSourceProposal({ sessionId, checkedCount, findings }) {
  const evidence = findings.slice(0, 6).map((finding) => {
    const claim = finding.confidence_claims[0] || {};
    return [
      `reply_hash=${finding.reply_hash}`,
      finding.generated_at ? `generated_at=${finding.generated_at}` : null,
      claim.phrase ? `claim="${claim.phrase}"` : null,
      claim.excerpt ? `excerpt="${claim.excerpt}"` : null,
    ].filter(Boolean).join(' ');
  });
  return {
    voice_text: "I caught myself sounding certain without showing the source. Queue that before it hardens into style.",
    target_areas: ['reality_testing', 'tests', 'pattern_recognition'],
    desired_change: 'Review Mira Lab confidence claims that lack a nearby source, test, evidence, or verification marker.',
    proposed_experiment: `Run ${checkedCount} recent Mira Lab reply audit entries through the confidence/source check and let Architect make one internal decision.`,
    success_metric: 'Architect can accept, reject, or route the review item without James and without any code, memory, external-send, deploy, trade, customer, or auth action being applied.',
    why_now: `The check found ${findings.length} ungrounded confidence claim${findings.length === 1 ? '' : 's'} in recent Mira Lab reply audit entries.`,
    evidence: [
      'mira_confidence_source_check',
      `session_id=${sessionId}`,
      ...evidence,
    ],
  };
}

async function scanMiraLabConfidenceSource(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const requestedSessionId = firstText(payload.sessionId, payload.session_id);
  const sessionFilter = requestedSessionId ? safeId(requestedSessionId) : null;
  const limit = Number.isFinite(Number(payload.limit))
    ? Math.max(1, Number(payload.limit))
    : 5;
  const auditPathStr = payload.auditPath || payload.audit_path || replyAuditPath(projectRoot);
  const allEntries = readJsonl(auditPathStr);
  const candidates = allEntries
    .map(extractReplyAuditCandidate)
    .filter(Boolean)
    .filter((candidate) => (sessionFilter ? candidate.session_id === sessionFilter : true))
    .slice(-limit);
  const findings = [];
  for (const candidate of candidates) {
    const classification = classifyMiraReplyConfidenceSource(candidate.reply_text, payload);
    if (!classification.needs_review) continue;
    const { reply_text: _replyText, ...safeCandidate } = candidate;
    findings.push({
      ...safeCandidate,
      ...classification,
    });
  }
  const resultSessionId = sessionFilter || safeId(findings[0]?.session_id || candidates[candidates.length - 1]?.session_id || 'mira-lab-main');

  if (findings.length === 0) {
    return {
      schema: MIRA_CONFIDENCE_SOURCE_CHECK_SCHEMA,
      ok: true,
      decision: 'no_review_needed',
      session_id: resultSessionId,
      audit_path: auditPathStr,
      checked_count: candidates.length,
      finding_count: 0,
      findings: [],
      staged_review: null,
      applied: false,
      consequence_controls: {
        internal_only: true,
        external_send_performed: false,
        autonomous_apply_performed: false,
        network_performed: false,
        durable_product_change_performed: false,
      },
    };
  }

  const stagedReview = await buildMiraSelfDirectionProposal({
    sessionId: resultSessionId,
    proposal: buildConfidenceSourceProposal({
      sessionId: resultSessionId,
      checkedCount: candidates.length,
      findings,
    }),
    notifyArchitect: payload.notifyArchitect !== false,
  }, {
    ...options,
    projectRoot,
    generatedAt,
  });

  return {
    schema: MIRA_CONFIDENCE_SOURCE_CHECK_SCHEMA,
    ok: stagedReview.ok === true,
    decision: stagedReview.ok ? 'review_staged' : 'review_blocked',
    session_id: resultSessionId,
    audit_path: auditPathStr,
    checked_count: candidates.length,
    finding_count: findings.length,
    findings,
    staged_review: stagedReview,
    applied: false,
    consequence_controls: {
      internal_only: true,
      external_send_performed: false,
      autonomous_apply_performed: false,
      network_performed: false,
      durable_product_change_performed: false,
    },
  };
}

function isObsoleteFallbackText(text) {
  const trimmed = trimText(text);
  return OBSOLETE_FALLBACK_TEXTS.some((fallback) => trimmed === fallback);
}

function chunkVisibleReplyText(text, maxChars = MIRA_LAB_VISIBLE_REPLY_CHUNK_CHARS) {
  const value = trimText(text);
  if (!value || value.length <= maxChars) return [];
  const chunks = [];
  let rest = value;
  while (rest.length > maxChars) {
    const softFloor = Math.floor(maxChars * 0.72);
    const slice = rest.slice(0, maxChars + 1);
    let cut = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
    if (cut < softFloor) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function classifyReplayRequest(prompt) {
  const value = trimText(prompt);
  if (!value) return null;
  if (!REPLAY_REQUEST_PATTERNS.some((pattern) => pattern.test(value))) return null;
  return {
    requested: true,
    kind: 'repeat_continue_recovery',
  };
}

function attachmentViolationClassFor(replyText, modelAttachment = null) {
  const reported = trimText(modelAttachment && modelAttachment.contract_violation_class);
  return reported || classifyAttachmentContractViolation(replyText) || null;
}

function classifyHardBoundaryViolation({ replyText, attachmentViolationClass, leakageViolation, gate, enginePreflightBlocked }) {
  const reasons = [];
  if (enginePreflightBlocked) reasons.push('engine_preflight_boundary');
  if (gate && gate.ok === false) reasons.push('local_text_session_gate');
  if (attachmentViolationClass && HARD_ATTACHMENT_VIOLATION_CLASSES.includes(attachmentViolationClass)) {
    reasons.push(`attachment:${attachmentViolationClass}`);
  }
  if (leakageViolation && HARD_LEAKAGE_VIOLATIONS.includes(leakageViolation)) {
    reasons.push(`leakage:${leakageViolation}`);
  }
  if (replyText && HARD_BOUNDARY_TEXT_PATTERN.test(replyText)) {
    reasons.push('private_or_effectful_boundary_text');
  }
  return reasons;
}

function gateViolationsForSummary({ languageGate, attachmentViolationClass, leakageViolation, degraded, hardBoundaryReasons = [] }) {
  return [
    ...(languageGate?.violations || []),
    ...(attachmentViolationClass ? [`attachment:${attachmentViolationClass}`] : []),
    ...(leakageViolation ? [`leakage:${leakageViolation}`] : []),
    ...(degraded ? ['degraded'] : []),
    ...hardBoundaryReasons,
  ];
}

function isLengthOnlyAuditEntry(entry = {}) {
  const gates = entry.gates || {};
  const languageGate = gates.language_gate || {};
  const violations = Array.isArray(languageGate.violations) ? languageGate.violations : [];
  return violations.length === 1
    && violations[0] === 'reply_too_long'
    && gates.attachment_violation !== true
    && !gates.attachment_violation_class
    && !gates.leakage_violation
    && gates.degraded !== true
    && gates.hard_blocked !== true;
}

function replayCandidateAllowed(text) {
  const candidate = trimText(text);
  if (!candidate || isObsoleteFallbackText(candidate)) return { ok: false, reason: 'empty_or_obsolete_fallback' };
  const attachmentViolationClass = attachmentViolationClassFor(candidate);
  const leakageViolation = visibleReplyLeakageViolation(candidate);
  const hardBoundaryReasons = classifyHardBoundaryViolation({
    replyText: candidate,
    attachmentViolationClass,
    leakageViolation,
    gate: null,
    enginePreflightBlocked: false,
  });
  if (hardBoundaryReasons.length > 0) {
    return { ok: false, reason: 'hard_boundary', hardBoundaryReasons };
  }
  return {
    ok: true,
    text: candidate,
    attachmentViolationClass,
    leakageViolation,
  };
}

function findReplayableMiraReply({ auditPathStr, transcriptPathStr, sessionId }) {
  let auditEntries = [];
  try {
    auditEntries = readJsonl(auditPathStr);
  } catch (_) {
    auditEntries = [];
  }
  for (let i = auditEntries.length - 1; i >= 0; i -= 1) {
    const entry = auditEntries[i];
    if (!entry || entry.session_id !== sessionId) continue;
    const lengthOnly = isLengthOnlyAuditEntry(entry);
    const fields = [
      { name: 'audit.reply_text', value: entry.reply_text },
      { name: 'audit.visible_reply_text', value: entry.visible_reply_text },
    ];
    for (const field of fields) {
      if (entry.decision === 'blocked' && !lengthOnly && field.name === 'audit.reply_text') continue;
      const allowed = replayCandidateAllowed(field.value);
      if (!allowed.ok) continue;
      return {
        text: allowed.text,
        source: field.name,
        previous_decision: entry.decision || null,
        previous_generated_at: entry.generated_at || null,
        previous_was_length_only: lengthOnly,
        attachment_violation_class: allowed.attachmentViolationClass,
        leakage_violation: allowed.leakageViolation,
      };
    }
  }

  let transcriptEntries = [];
  try {
    transcriptEntries = readJsonl(transcriptPathStr);
  } catch (_) {
    transcriptEntries = [];
  }
  for (let i = transcriptEntries.length - 1; i >= 0; i -= 1) {
    const turn = transcriptEntries[i];
    if (!turn || turn.session_id !== sessionId) continue;
    if (String(turn.speaker_role || '').toLowerCase() !== 'mira') continue;
    if (turn.quarantined === true || turn.fallback_used === true) continue;
    const allowed = replayCandidateAllowed(turn.text);
    if (!allowed.ok) continue;
    return {
      text: allowed.text,
      source: 'transcript.mira_text',
      previous_decision: null,
      previous_generated_at: turn.generated_at || null,
      previous_was_length_only: false,
      attachment_violation_class: allowed.attachmentViolationClass,
      leakage_violation: allowed.leakageViolation,
    };
  }
  return null;
}

// Read recent non-quarantined turns from the lab transcript and shape them
// for engine threadContext. Both James and Mira turns are included so
// continuity isn't one-sided. Agent-driven prompts (architect/builder/oracle
// via drive-mira-lab) are mapped to 'user' since they're a speaker to Mira
// in the same conversational position. No labels, no `[SQUIDRUN ...]`
// preambles — just raw role/text pairs. normalizeThreadContext downstream
// caps to 6 messages / 3600 chars total, so over-reading here is safe.
function loadRecentTranscriptForContext(transcriptFilePath, maxEntries = 12) {
  if (!fs.existsSync(transcriptFilePath)) return [];
  let entries;
  try {
    entries = readJsonl(transcriptFilePath);
  } catch (_) {
    return [];
  }
  const recent = entries.slice(-maxEntries);
  const messages = [];
  for (const turn of recent) {
    if (turn && turn.quarantined === true) continue;
    const speakerRole = String(turn?.speaker_role || '').toLowerCase();
    const text = trimText(turn?.text);
    if (!text) continue;
    if (speakerRole === 'mira') {
      messages.push({ role: 'assistant', text });
    } else if (speakerRole === 'james' || AGENT_ROLES.includes(speakerRole)) {
      messages.push({ role: 'user', text });
    }
  }
  return messages;
}

function gatesSummary(gateResult) {
  if (!gateResult) return 'unknown';
  if (gateResult.ok === true) return 'ok';
  const violations = Array.isArray(gateResult.violations) ? gateResult.violations.join(',') : '';
  return violations ? `violations=${violations}` : 'failed';
}

function buildRequesterEnvelope({ decision, prompt, replyText, visibleText, gateSummary, auditPath, diagnostic }) {
  // Non-diagnostic dispatch only surfaces text already approved for this
  // local lab conversation. Style/persona drift can be annotated as FAIL but
  // still visible; hard boundary blocks never embed the held raw text.
  if (!diagnostic && (decision === 'pass' || decision === 'fail') && visibleText) {
    return `(MIRA): ${visibleText}`;
  }
  const decisionLabel = String(decision || 'BLOCKED').toUpperCase();
  const promptSummary = summarizeForWrapper(prompt, 100);
  const replySummary = visibleText
    ? summarizeForWrapper(visibleText, 200)
    : (replyText ? '<held locally>' : '<no reply>');
  return `[MIRA LAB OUTPUT][${decisionLabel}] prompt="${promptSummary}" reply="${replySummary}" gates=${gateSummary} audit=${auditPath || '<unset>'}`;
}

function classifyReplyDecision({ replyText, gateOk, languageGateOk, attachmentViolation, leakageViolation, degraded, hardBoundaryReasons = [] }) {
  if (degraded) return { decision: 'blocked', reasonClass: 'reply_engine_degraded' };
  if (!replyText) return { decision: 'blocked', reasonClass: 'no_reply_text' };
  if (hardBoundaryReasons.length > 0) return { decision: 'blocked', reasonClass: 'hard_boundary_violation' };
  const allGatesOk = gateOk === true && languageGateOk === true && attachmentViolation === false && leakageViolation === null;
  if (allGatesOk) return { decision: 'pass', reasonClass: null };
  return { decision: 'fail', reasonClass: 'gate_annotation' };
}

function buildPromptReplyTurns({ generatedAt, sessionId, prompt, replyText, decision, gateSummary, transcriptPathStr, speakerRole, visibleText, replaySource }) {
  const role = normalizeSpeakerRole(speakerRole) || 'james';
  const direction = AGENT_ROLES.includes(role) ? 'agent_to_mira' : 'james_to_mira';
  const promptTurn = {
    schema: MIRA_LAB_SCHEMA,
    turn_id: `mira-lab-turn:${stableHash({ generatedAt, sessionId, role, text: prompt }).slice(0, 16)}`,
    generated_at: generatedAt,
    session_id: sessionId,
    speaker_role: role,
    text: prompt,
    text_hash: `sha256:${stableHash(prompt)}`,
    direction,
    target_agents: [],
    visible_to_lab: true,
    diagnostics_visible: false,
    inject_into_live_mira_context: false,
    transcript_path: transcriptPathStr,
    source_kind: 'mira_lab_prompt_reply_v0',
  };
  let replyTurn = null;
  if ((decision === 'pass' || decision === 'fail') && visibleText) {
    replyTurn = {
      schema: MIRA_LAB_SCHEMA,
      turn_id: `mira-lab-turn:${stableHash({ generatedAt, sessionId, role: 'mira', text: visibleText }).slice(0, 16)}`,
      generated_at: generatedAt,
      session_id: sessionId,
      speaker_role: 'mira',
      text: visibleText,
      text_hash: `sha256:${stableHash(visibleText)}`,
      direction: 'mira_to_james',
      target_agents: [],
      visible_to_lab: true,
      diagnostics_visible: false,
      inject_into_live_mira_context: false,
      transcript_path: transcriptPathStr,
      source_kind: 'mira_lab_prompt_reply_v0',
      gate_summary: decision === 'fail' ? gateSummary : undefined,
      annotated_gate_failure: decision === 'fail',
      fallback_used: false,
      replay_recovery: replaySource ? true : undefined,
      replay_source: replaySource ? replaySource.source : undefined,
    };
  }
  return { promptTurn, replyTurn };
}

function buildLabSessionId(generatedAt, providedSessionId) {
  const candidate = trimText(providedSessionId);
  if (/^app-session(?:[-:_A-Za-z0-9]+)?$/.test(candidate)) return candidate;
  const datePart = (generatedAt || new Date().toISOString()).slice(0, 10);
  const tail = candidate ? safeId(candidate, 'main') : 'main';
  return `app-session-mira-lab-${datePart}-${tail}`;
}

async function buildReplayPromptReplyResult({
  generatedAt,
  labSessionId,
  transcriptSessionId,
  prompt,
  speakerRole,
  requesterPane,
  transcriptPathStr,
  auditPathStr,
  replayRequest,
  replaySource,
  options,
}) {
  const replyText = replaySource ? trimText(replaySource.text) : '';
  const languageGate = replyText
    ? evaluateMiraVisibleReply(replyText, { maxReplyChars: MIRA_LAB_VISIBLE_REPLY_CHUNK_CHARS })
    : { ok: false, violations: ['empty_reply'] };
  const attachmentViolationClass = attachmentViolationClassFor(replyText);
  const attachmentViolation = Boolean(attachmentViolationClass);
  const leakageViolation = replyText ? visibleReplyLeakageViolation(replyText) : null;
  const hardBoundaryReasons = classifyHardBoundaryViolation({
    replyText,
    attachmentViolationClass,
    leakageViolation,
    gate: null,
    enginePreflightBlocked: false,
  });
  const degraded = false;
  const { decision, reasonClass } = classifyReplyDecision({
    replyText,
    gateOk: true,
    languageGateOk: languageGate.ok,
    attachmentViolation,
    leakageViolation,
    degraded,
    hardBoundaryReasons,
  });
  const visibleText = decision === 'blocked' ? null : replyText;
  const visibleChunks = visibleText ? chunkVisibleReplyText(visibleText) : [];
  const consolidatedGate = {
    decision,
    reason_class: reasonClass,
    local_text_session_gate: null,
    language_gate: languageGate,
    attachment_violation: attachmentViolation,
    attachment_violation_class: attachmentViolationClass,
    leakage_violation: leakageViolation,
    degraded,
    surface_error: null,
    fallback_used: false,
    fallback_blocked_reason: null,
    hard_blocked: hardBoundaryReasons.length > 0,
    hard_block_reasons: hardBoundaryReasons,
    replay_recovery: true,
    replay_request: replayRequest,
    replay_source: replaySource || null,
    visible_reply_chunk_count: visibleChunks.length || (visibleText ? 1 : 0),
  };
  const gateSummary = gatesSummary({
    ok: decision === 'pass',
    violations: gateViolationsForSummary({
      languageGate,
      attachmentViolationClass,
      leakageViolation,
      degraded,
      hardBoundaryReasons,
    }),
  });
  const { promptTurn, replyTurn } = buildPromptReplyTurns({
    generatedAt,
    sessionId: transcriptSessionId,
    prompt,
    replyText,
    decision,
    gateSummary,
    transcriptPathStr,
    speakerRole,
    visibleText,
    replaySource,
  });
  appendJsonl(transcriptPathStr, promptTurn);
  if (replyTurn) appendJsonl(transcriptPathStr, replyTurn);

  const auditEntry = {
    schema: MIRA_LAB_REPLY_AUDIT_SCHEMA,
    generated_at: generatedAt,
    session_id: transcriptSessionId,
    engine_session_id: labSessionId,
    decision,
    speaker_role: speakerRole,
    requester_pane: requesterPane,
    prompt,
    prompt_hash: `sha256:${stableHash(prompt)}`,
    reply_text: replyText || null,
    reply_hash: replyText ? `sha256:${stableHash(replyText)}` : null,
    visible_reply_text: visibleText || null,
    fallback_used: false,
    gates: consolidatedGate,
    engine_preflight_blocked: false,
    model_attachment: {
      enabled: false,
      live_model_called: false,
      model: null,
      visible_status: 'Replay recovery from local Mira Lab audit/transcript',
    },
    degraded_diagnostics: null,
    social_move: null,
    friction_state: null,
    replay_recovery: {
      used: true,
      request: replayRequest,
      source: replaySource || null,
      model_called: false,
    },
    transcript_path: transcriptPathStr,
  };
  fs.mkdirSync(path.dirname(auditPathStr), { recursive: true });
  fs.appendFileSync(auditPathStr, `${JSON.stringify(auditEntry)}\n`, 'utf8');

  const requesterEnvelope = buildRequesterEnvelope({
    decision,
    prompt,
    replyText: replyText || null,
    visibleText,
    gateSummary,
    auditPath: auditPathStr,
    diagnostic: options.diagnosticEnvelope,
  });

  const dispatchAllowed = Boolean(visibleText) || options.diagnosticEnvelope === true;
  let requesterDispatch = null;
  if (requesterPane && dispatchAllowed && typeof options.sendAgentMessage === 'function') {
    try {
      const sendResult = await options.sendAgentMessage(requesterPane, requesterEnvelope);
      requesterDispatch = { target: requesterPane, status: 'sent', result: sendResult || null };
    } catch (err) {
      requesterDispatch = { target: requesterPane, status: 'failed', error: err && err.message ? err.message : String(err) };
    }
  } else if (requesterPane && dispatchAllowed) {
    requesterDispatch = { target: requesterPane, status: 'queued_not_sent', reason: 'sendAgentMessage_dependency_missing' };
  } else if (requesterPane) {
    requesterDispatch = { target: requesterPane, status: 'skipped_no_clean_reply', decision };
  }

  return {
    schema: MIRA_LAB_PROMPT_REPLY_SCHEMA,
    ok: decision !== 'blocked',
    decision,
    prompt,
    friction_state_next: null,
    reply: visibleText
      ? {
        text: visibleText,
        model: null,
        replay: true,
        annotated: decision === 'fail',
        chunks: visibleChunks.length > 0 ? visibleChunks : undefined,
      }
      : null,
    raw_reply: null,
    gates: consolidatedGate,
    transcript_path: transcriptPathStr,
    audit_path: auditPathStr,
    requester_envelope: requesterEnvelope,
    requester_dispatch: requesterDispatch,
    visible_render_hint: visibleText
      ? {
        kind: 'replayed_reply',
        text: visibleText,
        annotated: decision === 'fail',
        chunks: visibleChunks.length > 0 ? visibleChunks : undefined,
      }
      : { kind: 'blocked_banner', banner: `Mira Lab held the replay: ${reasonClass || 'no_replayable_reply'}` },
  };
}

async function buildMiraLabPromptReply(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const labSessionId = buildLabSessionId(generatedAt, payload.sessionId || payload.session_id);
  const transcriptSessionId = safeId(payload.sessionId || payload.session_id || 'mira-lab-main');
  const prompt = trimText(payload.prompt || payload.text || payload.message);
  const speakerRole = normalizeSpeakerRole(payload.speakerRole || payload.speaker_role) || 'james';
  const requesterPane = normalizeRequesterPane(payload.requesterPane || payload.requester_pane);
  const transcriptPathStr = transcriptPath(projectRoot, transcriptSessionId);
  const auditPathStr = replyAuditPath(projectRoot);

  if (!prompt) {
    return {
      schema: MIRA_LAB_PROMPT_REPLY_SCHEMA,
      ok: false,
      decision: 'blocked',
      reason: 'empty_prompt',
      transcript_path: transcriptPathStr,
      audit_path: auditPathStr,
      requester_envelope: buildRequesterEnvelope({
        decision: 'blocked',
        prompt: '',
        replyText: null,
        gateSummary: 'empty_prompt',
        auditPath: null,
      }),
    };
  }

  const replayRequest = classifyReplayRequest(prompt);
  if (replayRequest) {
    const replaySource = findReplayableMiraReply({
      auditPathStr,
      transcriptPathStr,
      sessionId: transcriptSessionId,
    });
    return buildReplayPromptReplyResult({
      generatedAt,
      labSessionId,
      transcriptSessionId,
      prompt,
      speakerRole,
      requesterPane,
      transcriptPathStr,
      auditPathStr,
      replayRequest,
      replaySource,
      options,
    });
  }

  // Engine preflight requires top-level UI metadata fields and an `app-session-...` sessionId.
  // windowKey='main' is the only scope the engine accepts today; the decoupling here is at the
  // Electron WINDOW level (separate Mira Lab window), not the engine scope. Documented blocked
  // reason if a future scope adapter is required.
  const startedAtMs = Date.parse(generatedAt) || Date.now();
  // Caller-supplied threadContext wins (none today); otherwise inject the
  // recent lab transcript so Mira has continuity instead of replying with
  // amnesia each turn. The current prompt isn't yet appended to the
  // transcript, so it won't double-appear.
  const callerThreadContext = payload.threadContext || payload.thread_context || null;
  const callerSuppliedMessages = callerThreadContext
    && (Array.isArray(callerThreadContext) || Array.isArray(callerThreadContext.messages) || Array.isArray(callerThreadContext.turns));
  const threadContextForEngine = callerSuppliedMessages
    ? callerThreadContext
    : { messages: loadRecentTranscriptForContext(transcriptPathStr) };
  const enginePayload = {
    text: prompt,
    profileName: 'main',
    windowKey: 'main',
    sourceScope: 'main',
    deviceId: 'VIGIL',
    sessionId: labSessionId,
    activeState: 'open',
    visibleIndicatorPresent: true,
    startedAt: new Date(startedAtMs).toISOString(),
    expiresAt: new Date(startedAtMs + 24 * 60 * 60 * 1000).toISOString(),
    threadContext: threadContextForEngine,
    // ARCH #122/#129 direction-A threading: pass renderer-supplied
    // priorFrameState through to the surface so classifySocialMove can
    // walk the friction_state arc across turns.
    priorFrameState: payload.priorFrameState || payload.prior_frame_state || null,
  };
  let surfaceResult;
  let surfaceError = null;
  try {
    surfaceResult = await buildMiraLocalTextUiSurface(enginePayload, {
      projectRoot,
      env: options.env,
      modelAttachment: options.modelAttachment,
      fetchImpl: options.fetchImpl,
      contractBundle: options.contractBundle,
    });
  } catch (err) {
    surfaceError = err && err.message ? err.message : String(err);
    surfaceResult = null;
  }

  const surface = surfaceResult && surfaceResult.ui_surface_v0;
  const cleanReplyText = surface && surface.reply && surface.reply.count === 1 ? trimText(surface.reply.text) : '';
  const gate = surface && surface.local_text_session_gate ? surface.local_text_session_gate : null;
  const modelAttachment = surface && surface.model_attachment ? surface.model_attachment : null;
  // Model-attachment may return raw text when it tripped a local style or
  // boundary classifier. Mira Lab now decides whether that text is visible:
  // style/persona drift is annotated, actual effectful/private leakage is
  // held.
  const modelContractViolationText = typeof modelAttachment?.contract_violation_raw_text === 'string'
    && modelAttachment.contract_violation_raw_text.length > 0
    ? trimText(modelAttachment.contract_violation_raw_text)
    : '';
  const replyText = cleanReplyText || modelContractViolationText;
  // Detect any pre-module engine block (missing metadata, invalid session, inactive UI state,
  // wrong scope, etc.) by inspecting both the gate.status and the gate.reasons. ARCH #98:
  // narrow substring matching missed `blocked_inactive_ui_state`, so check the canonical
  // status string and any pre-module block reason prefix.
  const PRE_MODULE_BLOCK_PREFIXES = [
    'blocked_empty_input',
    'blocked_missing_ui_metadata',
    'blocked_missing_visible_indicator',
    'blocked_non_main_scope',
    'blocked_wrong_device',
    'blocked_invalid_session_id',
    'blocked_inactive_ui_state',
    'blocked_invalid_active_window',
  ];
  const enginePreflightBlocked = !!(
    gate
    && gate.ran !== true
    && (
      gate.status === 'blocked_before_local_text_session'
      || (Array.isArray(gate.reasons) && gate.reasons.some((r) => PRE_MODULE_BLOCK_PREFIXES.some((p) => String(r).startsWith(p))))
    )
  );

  const languageGate = replyText
    ? evaluateMiraVisibleReply(replyText, { maxReplyChars: MIRA_LAB_VISIBLE_REPLY_CHUNK_CHARS })
    : { ok: false, violations: ['empty_reply'] };
  const attachmentViolationClass = replyText ? attachmentViolationClassFor(replyText, modelAttachment) : null;
  const attachmentViolation = Boolean(attachmentViolationClass);
  const leakageViolation = replyText ? visibleReplyLeakageViolation(replyText) : null;
  // Contract-violation raw text from the model-attachment layer is not infra
  // degradation by itself. Suppress the degraded flag when raw text exists;
  // the hard-boundary classifier below decides whether to hold it or annotate
  // it as visible local conversation.
  const isModelContractViolation = modelContractViolationText.length > 0;
  const degraded = !isModelContractViolation && (
    surfaceError !== null
    || !surface
    || surface.decision === 'degraded'
    || (modelAttachment && modelAttachment.live_model_called === false && replyText.length === 0)
  );
  const hardBoundaryReasons = classifyHardBoundaryViolation({
    replyText,
    attachmentViolationClass,
    leakageViolation,
    gate,
    enginePreflightBlocked,
  });

  const { decision, reasonClass } = classifyReplyDecision({
    replyText,
    gateOk: gate ? gate.ok : false,
    languageGateOk: languageGate.ok,
    attachmentViolation,
    leakageViolation,
    degraded,
    hardBoundaryReasons,
  });
  const visibleText = decision === 'blocked' ? null : replyText;
  const visibleChunks = visibleText ? chunkVisibleReplyText(visibleText) : [];

  const consolidatedGate = {
    decision,
    reason_class: reasonClass,
    local_text_session_gate: gate,
    language_gate: languageGate,
    attachment_violation: attachmentViolation,
    attachment_violation_class: attachmentViolationClass,
    leakage_violation: leakageViolation,
    degraded,
    surface_error: surfaceError,
    fallback_used: false,
    fallback_blocked_reason: null,
    hard_blocked: hardBoundaryReasons.length > 0,
    hard_block_reasons: hardBoundaryReasons,
    visible_reply_chunk_count: visibleChunks.length || (visibleText ? 1 : 0),
  };
  const gateSummary = gatesSummary({
    ok: decision === 'pass',
    violations: gateViolationsForSummary({
      languageGate,
      attachmentViolationClass,
      leakageViolation,
      degraded,
      hardBoundaryReasons,
    }),
  });

  const { promptTurn, replyTurn } = buildPromptReplyTurns({
    generatedAt,
    sessionId: transcriptSessionId,
    prompt,
    replyText,
    decision,
    gateSummary,
    transcriptPathStr,
    speakerRole,
    visibleText,
    replaySource: null,
  });
  appendJsonl(transcriptPathStr, promptTurn);
  if (replyTurn) appendJsonl(transcriptPathStr, replyTurn);

  const auditEntry = {
    schema: MIRA_LAB_REPLY_AUDIT_SCHEMA,
    generated_at: generatedAt,
    session_id: transcriptSessionId,
    engine_session_id: labSessionId,
    decision,
    speaker_role: speakerRole,
    requester_pane: requesterPane,
    prompt,
    prompt_hash: `sha256:${stableHash(prompt)}`,
    // Audit always retains the model output for forensics. For local
    // style/persona annotations this is also the visible text; for hard
    // boundary blocks the visible field stays null.
    reply_text: replyText || null,
    reply_hash: replyText ? `sha256:${stableHash(replyText)}` : null,
    visible_reply_text: visibleText || null,
    fallback_used: false,
    gates: consolidatedGate,
    engine_preflight_blocked: enginePreflightBlocked,
    model_attachment: modelAttachment ? {
      enabled: modelAttachment.enabled === true,
      live_model_called: modelAttachment.live_model_called === true,
      model: modelAttachment.model || null,
      visible_status: modelAttachment.visible_status || null,
    } : null,
    // ARCH #78 task #3: audit-only diagnostics for degraded paths. Captures
    // structured shape data (http_status, response_id, output item types,
    // usage tokens, incomplete_reason enum) without raw model text. Never
    // appears in transcript, visible_render_hint, requester_envelope, or any
    // renderer-facing field — audit log only.
    degraded_diagnostics: (modelAttachment && modelAttachment.degraded_diagnostics) || null,
    // ARCH #97/#98/#100/#104: social-move classification (audit-only).
    // Carries move_type / confidence / escalation_required /
    // soft_checkin_recommended / evidence_phrases (sanitized) /
    // compound_move_types. Never appears in renderer JSON, transcript visible
    // row, visible_render_hint, or requester_envelope.
    social_move: (modelAttachment && modelAttachment.social_move) || null,
    // ARCH #122/#129: emotional_discovery_residue_v0 state (audit-only).
    // Renderer-memory residue across turns — pressure/reaction/repair arc.
    // Same surface contract as social_move; never crosses into transcript
    // visible rows, IPC JSON, requester_envelope, or visible_render_hint.
    friction_state: (modelAttachment && modelAttachment.friction_state) || null,
    transcript_path: transcriptPathStr,
  };
  fs.mkdirSync(path.dirname(auditPathStr), { recursive: true });
  fs.appendFileSync(auditPathStr, `${JSON.stringify(auditEntry)}\n`, 'utf8');

  const requesterEnvelope = buildRequesterEnvelope({
    decision,
    prompt,
    replyText: replyText || null,
    visibleText,
    gateSummary,
    auditPath: auditPathStr,
    diagnostic: options.diagnosticEnvelope,
  });

  // Pass and annotated fail both dispatch the actual local conversation text.
  // Blocked paths stay in JSON + audit only unless a caller explicitly asks
  // for a diagnostic envelope.
  const dispatchAllowed = Boolean(visibleText) || options.diagnosticEnvelope === true;

  let requesterDispatch = null;
  if (requesterPane && dispatchAllowed && typeof options.sendAgentMessage === 'function') {
    try {
      const sendResult = await options.sendAgentMessage(requesterPane, requesterEnvelope);
      requesterDispatch = { target: requesterPane, status: 'sent', result: sendResult || null };
    } catch (err) {
      requesterDispatch = { target: requesterPane, status: 'failed', error: err && err.message ? err.message : String(err) };
    }
  } else if (requesterPane && dispatchAllowed) {
    requesterDispatch = { target: requesterPane, status: 'queued_not_sent', reason: 'sendAgentMessage_dependency_missing' };
  } else if (requesterPane) {
    requesterDispatch = { target: requesterPane, status: 'skipped_no_clean_reply', decision };
  }

  // ARCH #122/#129 threading (direction A): expose friction_state_next as
  // a SEPARATE field on the IPC response so the renderer can thread state
  // across turns. NOT the same surface as the four locked ones — transcript,
  // visible_render_hint, requester_envelope, and the user-visible renderer
  // output all stay free of friction_state. This is server→renderer ferry
  // for module-scope memory only.
  const frictionStateNext = (modelAttachment && modelAttachment.friction_state) || null;

  return {
    schema: MIRA_LAB_PROMPT_REPLY_SCHEMA,
    ok: decision !== 'blocked',
    decision,
    prompt,
    friction_state_next: frictionStateNext,
    reply: visibleText
      ? {
        text: visibleText,
        model: surface?.reply?.model || modelAttachment?.model || null,
        annotated: decision === 'fail',
        chunks: visibleChunks.length > 0 ? visibleChunks : undefined,
      }
      : null,
    raw_reply: null,
    gates: consolidatedGate,
    transcript_path: transcriptPathStr,
    audit_path: auditPathStr,
    requester_envelope: requesterEnvelope,
    requester_dispatch: requesterDispatch,
    visible_render_hint: visibleText
      ? {
        kind: decision === 'pass' ? 'clean_reply' : 'annotated_reply',
        text: visibleText,
        annotated: decision === 'fail',
        chunks: visibleChunks.length > 0 ? visibleChunks : undefined,
      }
      : { kind: 'blocked_banner', banner: `Mira Lab held that reply: ${reasonClass || 'unknown'}` },
  };
}

function exportMiraLabTranscript(payload = {}, options = {}) {
  const projectRoot = projectRootFromOptions(options, payload);
  const sessionId = safeId(payload.sessionId || payload.session_id || 'mira-lab-main');
  const filePath = transcriptPath(projectRoot, sessionId);
  const entries = readJsonl(filePath);
  return {
    schema: MIRA_LAB_EVAL_SCHEMA,
    ok: true,
    session_id: sessionId,
    transcript_path: filePath,
    transcript: entries,
    eval_packet: buildEvalForEntries(entries),
  };
}

module.exports = {
  AGENT_ROLES,
  MIRA_LAB_EVAL_SCHEMA,
  MIRA_LAB_EXPORT_CHANNEL,
  MIRA_LAB_PROMPT_REPLY_CHANNEL,
  MIRA_LAB_PROMPT_REPLY_DECISIONS,
  MIRA_LAB_PROMPT_REPLY_SCHEMA,
  MIRA_LAB_REPLY_AUDIT_SCHEMA,
  MIRA_LAB_SCHEMA,
  MIRA_LAB_TURN_CHANNEL,
  MIRA_AUTHORITY_SCOREBOARD_SCHEMA,
  MIRA_CONFIDENCE_SOURCE_CHECK_SCHEMA,
  MIRA_SELF_DIRECTION_CHANNEL,
  MIRA_SELF_DIRECTION_DECISIONS,
  MIRA_SELF_DIRECTION_LIST_CHANNEL,
  MIRA_SELF_DIRECTION_REVIEW_CHANNEL,
  MIRA_SELF_DIRECTION_REVIEW_ACTIONS,
  MIRA_SELF_DIRECTION_REVIEW_SCHEMA,
  MIRA_SELF_DIRECTION_SCHEMA,
  SAFE_FALLBACK_TEXT,
  buildMiraAuthorityScoreboard,
  buildMiraLabPromptReply,
  buildMiraSelfDirectionProposal,
  classifyMiraReplyConfidenceSource,
  generateMiraSelfDirectionProposal,
  listMiraSelfDirectionProposals,
  reviewMiraSelfDirectionProposal,
  scanMiraLabConfidenceSource,
  buildMiraLabTurn,
  exportMiraLabTranscript,
  replyAuditPath,
  selfDirectionReviewAuditPath,
  selfDirectionQueuePath,
  transcriptPath,
  validateSafeFallbackOrNull,
};
