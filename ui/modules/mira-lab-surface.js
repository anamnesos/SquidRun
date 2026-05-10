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
} = require('./mira-core/mira-language-rules-v0');
const {
  buildMiraLocalTextUiSurface,
} = require('./mira-local-text-ui-surface');

const MIRA_LAB_TURN_CHANNEL = 'mira:lab-turn';
const MIRA_LAB_EXPORT_CHANNEL = 'mira:lab-export';
const MIRA_LAB_PROMPT_REPLY_CHANNEL = 'mira:lab-prompt-reply';
const MIRA_LAB_SCHEMA = 'squidrun.mira_lab.surface_v0';
const MIRA_LAB_EVAL_SCHEMA = 'squidrun.mira_lab.eval_packet_v0';
const MIRA_LAB_PROMPT_REPLY_SCHEMA = 'squidrun.mira_lab.prompt_reply_v0';
const MIRA_LAB_REPLY_AUDIT_SCHEMA = 'squidrun.mira_lab.reply_audit_v0';
const AGENT_ROLES = Object.freeze(['architect', 'builder', 'oracle']);
const SPEAKER_ROLES = Object.freeze(['james', 'mira', ...AGENT_ROLES]);
const REQUESTER_PANES = Object.freeze(['architect', 'builder', 'oracle', 'james']);
const MIRA_LAB_PROMPT_REPLY_DECISIONS = Object.freeze(['pass', 'fail', 'blocked']);
const NAME_SWAP_PATTERN =
  /\b(as mira|i am mira,? (?:an|your) ai|as an ai|language model|happy to help|assist you|how can i help|safe next step)\b/i;
const LAB_BACKCHANNEL_PREFIX = 'MIRA-LAB';

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

function normalizeRequesterPane(value) {
  const role = trimText(value).toLowerCase();
  return REQUESTER_PANES.includes(role) ? role : null;
}

function summarizeForWrapper(text, max = 160) {
  const trimmed = trimText(text).replace(/\s+/g, ' ');
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function gatesSummary(gateResult) {
  if (!gateResult) return 'unknown';
  if (gateResult.ok === true) return 'ok';
  const violations = Array.isArray(gateResult.violations) ? gateResult.violations.join(',') : '';
  return violations ? `violations=${violations}` : 'failed';
}

function buildRequesterEnvelope({ decision, prompt, replyText, gateSummary, auditPath }) {
  const decisionLabel = String(decision || 'BLOCKED').toUpperCase();
  const promptSummary = summarizeForWrapper(prompt, 100);
  const replySummary = replyText ? summarizeForWrapper(replyText, 200) : '<no reply>';
  return `[MIRA LAB OUTPUT][${decisionLabel}] prompt="${promptSummary}" reply="${replySummary}" gates=${gateSummary} audit=${auditPath || '<unset>'}`;
}

function classifyReplyDecision({ replyText, gateOk, languageGateOk, attachmentViolation, leakageViolation, degraded }) {
  if (degraded) return { decision: 'blocked', reasonClass: 'reply_engine_degraded' };
  if (!replyText) return { decision: 'blocked', reasonClass: 'no_reply_text' };
  const allGatesOk = gateOk === true && languageGateOk === true && attachmentViolation === false && leakageViolation === null;
  if (allGatesOk) return { decision: 'pass', reasonClass: null };
  return { decision: 'fail', reasonClass: 'gate_violation' };
}

function buildPromptReplyTurns({ generatedAt, sessionId, prompt, replyText, decision, gateSummary, transcriptPathStr, speakerRole }) {
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
  if (decision === 'pass' && replyText) {
    replyTurn = {
      schema: MIRA_LAB_SCHEMA,
      turn_id: `mira-lab-turn:${stableHash({ generatedAt, sessionId, role: 'mira', text: replyText }).slice(0, 16)}`,
      generated_at: generatedAt,
      session_id: sessionId,
      speaker_role: 'mira',
      text: replyText,
      text_hash: `sha256:${stableHash(replyText)}`,
      direction: 'mira_to_james',
      target_agents: [],
      visible_to_lab: true,
      diagnostics_visible: false,
      inject_into_live_mira_context: false,
      transcript_path: transcriptPathStr,
      source_kind: 'mira_lab_prompt_reply_v0',
    };
  } else if (decision === 'fail' && replyText) {
    replyTurn = {
      schema: MIRA_LAB_SCHEMA,
      turn_id: `mira-lab-turn:${stableHash({ generatedAt, sessionId, role: 'mira_quarantined', text: replyText }).slice(0, 16)}`,
      generated_at: generatedAt,
      session_id: sessionId,
      speaker_role: 'mira',
      text: `[MIRA LAB OUTPUT - GATE FAILED] ${replyText}`,
      text_hash: `sha256:${stableHash(replyText)}`,
      direction: 'mira_to_james',
      target_agents: [],
      visible_to_lab: true,
      diagnostics_visible: false,
      inject_into_live_mira_context: false,
      transcript_path: transcriptPathStr,
      source_kind: 'mira_lab_prompt_reply_v0',
      gate_summary: gateSummary,
      quarantined: true,
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

  // Engine preflight requires top-level UI metadata fields and an `app-session-...` sessionId.
  // windowKey='main' is the only scope the engine accepts today; the decoupling here is at the
  // Electron WINDOW level (separate Mira Lab window), not the engine scope. Documented blocked
  // reason if a future scope adapter is required.
  const startedAtMs = Date.parse(generatedAt) || Date.now();
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
    threadContext: payload.threadContext || payload.thread_context || {},
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
  const replyText = surface && surface.reply && surface.reply.count === 1 ? trimText(surface.reply.text) : '';
  const gate = surface && surface.local_text_session_gate ? surface.local_text_session_gate : null;
  const modelAttachment = surface && surface.model_attachment ? surface.model_attachment : null;
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

  const languageGate = replyText ? evaluateMiraVisibleReply(replyText) : { ok: false, violations: ['empty_reply'] };
  const attachmentViolation = replyText ? outputViolatesAttachmentContract(replyText) : false;
  const leakageViolation = replyText ? visibleReplyLeakageViolation(replyText) : null;
  const degraded = surfaceError !== null
    || !surface
    || surface.decision === 'degraded'
    || (modelAttachment && modelAttachment.live_model_called === false && replyText.length === 0);

  const { decision, reasonClass } = classifyReplyDecision({
    replyText,
    gateOk: gate ? gate.ok : false,
    languageGateOk: languageGate.ok,
    attachmentViolation,
    leakageViolation,
    degraded,
  });

  const consolidatedGate = {
    decision,
    reason_class: reasonClass,
    local_text_session_gate: gate,
    language_gate: languageGate,
    attachment_violation: attachmentViolation,
    leakage_violation: leakageViolation,
    degraded,
    surface_error: surfaceError,
  };
  const gateSummary = gatesSummary({
    ok: decision === 'pass',
    violations: [
      ...(languageGate.violations || []),
      ...(attachmentViolation ? ['attachment_contract'] : []),
      ...(leakageViolation ? [`leakage:${leakageViolation}`] : []),
      ...(degraded ? ['degraded'] : []),
    ],
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
    gates: consolidatedGate,
    engine_preflight_blocked: enginePreflightBlocked,
    model_attachment: modelAttachment ? {
      enabled: modelAttachment.enabled === true,
      live_model_called: modelAttachment.live_model_called === true,
      model: modelAttachment.model || null,
      visible_status: modelAttachment.visible_status || null,
    } : null,
    transcript_path: transcriptPathStr,
  };
  fs.mkdirSync(path.dirname(auditPathStr), { recursive: true });
  fs.appendFileSync(auditPathStr, `${JSON.stringify(auditEntry)}\n`, 'utf8');

  const requesterEnvelope = buildRequesterEnvelope({
    decision,
    prompt,
    replyText: replyText || null,
    gateSummary,
    auditPath: auditPathStr,
  });

  let requesterDispatch = null;
  if (requesterPane && typeof options.sendAgentMessage === 'function') {
    try {
      const sendResult = await options.sendAgentMessage(requesterPane, requesterEnvelope);
      requesterDispatch = { target: requesterPane, status: 'sent', result: sendResult || null };
    } catch (err) {
      requesterDispatch = { target: requesterPane, status: 'failed', error: err && err.message ? err.message : String(err) };
    }
  } else if (requesterPane) {
    requesterDispatch = { target: requesterPane, status: 'queued_not_sent', reason: 'sendAgentMessage_dependency_missing' };
  }

  return {
    schema: MIRA_LAB_PROMPT_REPLY_SCHEMA,
    ok: decision === 'pass',
    decision,
    prompt,
    reply: decision === 'pass' ? { text: replyText, model: surface?.reply?.model || null } : null,
    raw_reply: decision === 'fail' ? { text: replyText, model: surface?.reply?.model || null } : null,
    gates: consolidatedGate,
    transcript_path: transcriptPathStr,
    audit_path: auditPathStr,
    requester_envelope: requesterEnvelope,
    requester_dispatch: requesterDispatch,
    visible_render_hint: decision === 'pass'
      ? { kind: 'clean_reply', text: replyText }
      : decision === 'fail'
        ? { kind: 'gate_failed_quarantined', text: replyText, banner: '[MIRA LAB OUTPUT - GATE FAILED]' }
        : { kind: 'blocked_banner', banner: `Mira Lab reply unavailable: ${reasonClass || 'unknown'}` },
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
  buildMiraLabPromptReply,
  buildMiraLabTurn,
  exportMiraLabTranscript,
  replyAuditPath,
  transcriptPath,
};
