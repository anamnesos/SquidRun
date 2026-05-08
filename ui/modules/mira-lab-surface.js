'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  classifyAttachmentContractViolation,
} = require('./mira-core/text-model-attachment-v1');

const MIRA_LAB_TURN_CHANNEL = 'mira:lab-turn';
const MIRA_LAB_EXPORT_CHANNEL = 'mira:lab-export';
const MIRA_LAB_SCHEMA = 'squidrun.mira_lab.surface_v0';
const MIRA_LAB_EVAL_SCHEMA = 'squidrun.mira_lab.eval_packet_v0';
const AGENT_ROLES = Object.freeze(['architect', 'builder', 'oracle']);
const SPEAKER_ROLES = Object.freeze(['james', 'mira', ...AGENT_ROLES]);
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
  MIRA_LAB_SCHEMA,
  MIRA_LAB_TURN_CHANNEL,
  buildMiraLabTurn,
  exportMiraLabTranscript,
  transcriptPath,
};
