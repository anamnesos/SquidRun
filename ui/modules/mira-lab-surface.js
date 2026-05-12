'use strict';

const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
const {
  evaluateMiraWorkEvidenceReply,
} = require('./mira-work-evidence-gate');
const {
  readMiraMemoryCuriosity,
} = require('./mira-memory-curiosity');
const {
  readMiraEnvironmentCuriosity,
} = require('./mira-environment-curiosity');
const {
  readMiraBrowserHistoryCuriosity,
} = require('./mira-browser-history-curiosity');
const {
  readMiraEmailCuriosity,
  writeMiraEmailCuriositySnapshot,
} = require('./mira-email-curiosity');
const {
  readMiraWebResearchCuriosity,
} = require('./mira-web-research-curiosity');
const {
  readMiraVisualAssetCuriosity,
} = require('./mira-visual-asset-curiosity');

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
const MIRA_SELF_DIRECTION_OUTCOME_SCHEMA = 'squidrun.mira_lab.self_direction_outcome_v0';
const MIRA_CONFIDENCE_SOURCE_CHECK_SCHEMA = 'squidrun.mira_lab.confidence_source_check_v0';
const MIRA_AUTHORITY_SCOREBOARD_SCHEMA = 'squidrun.mira_lab.authority_scoreboard_v0';
const MIRA_REFLEXION_LESSONS_SCHEMA = 'squidrun.mira_lab.reflexion_lessons_v0';
const MIRA_CURRICULUM_SKILLS_SCHEMA = 'squidrun.mira_lab.curriculum_skills_v0';
const MIRA_CURIOSITY_ITEM_SCHEMA = 'squidrun.mira_lab.curiosity_item_v0';
const MIRA_CURIOSITY_BURST_SCHEMA = 'squidrun.mira_lab.curiosity_burst_v0';
const MIRA_DIRECT_ROUTE_SCHEMA = 'squidrun.mira_lab.direct_route_v0';
const MIRA_READ_ONLY_CODE_MODE_SCHEMA = 'squidrun.mira_lab.read_only_code_mode_v0';
const AGENT_ROLES = Object.freeze(['architect', 'builder', 'oracle']);
const SPEAKER_ROLES = Object.freeze(['james', 'mira', ...AGENT_ROLES]);
const REQUESTER_PANES = Object.freeze(['architect', 'builder', 'oracle', 'james']);
const MIRA_DIRECT_ROUTE_TARGETS = Object.freeze(['architect', 'builder', 'oracle', 'mira_lab']);
const MIRA_LAB_PROMPT_REPLY_DECISIONS = Object.freeze(['pass', 'fail', 'blocked']);
const MIRA_SELF_DIRECTION_DECISIONS = Object.freeze(['staged', 'rejected', 'blocked']);
const MIRA_SELF_DIRECTION_REVIEW_ACTIONS = Object.freeze(['accepted', 'rejected', 'routed']);
const MIRA_SELF_DIRECTION_OUTCOME_STATUSES = Object.freeze(['implemented', 'not_implemented', 'false_positive', 'needs_followup']);
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
const MIRA_CURIOSITY_SOURCE_REGISTRY = Object.freeze([
  { source: 'repo_files', scope: 'local_repo_and_files', adapter_id: 'git_status_short', default_status: 'active', integration_strategy: 'existing_seam', existing_seam: 'git status --short plus repo file reads' },
  { source: 'runtime_comms', scope: 'local_runtime_and_agent_comms', adapter_id: 'self_direction_queue', default_status: 'active', integration_strategy: 'existing_seam', existing_seam: '.squidrun/runtime/mira-self-direction-proposals.jsonl' },
  { source: 'runtime_comms', scope: 'local_runtime_and_agent_comms', adapter_id: 'recent_comms', default_status: 'active', integration_strategy: 'existing_seam', existing_seam: 'ui/scripts/hm-comms.js history --last 20, telegram-poller.js, sms-poller.js, external-notifications.js' },
  { source: 'memory', scope: 'local_memory_and_continuity', adapter_id: 'active_memory_tools_curiosity', default_status: 'active', integration_strategy: 'existing_seam', existing_seam: 'ui/modules/mira-memory-curiosity.js compact read-only cognitive-memory retrieval, cognitive-memory-*, memory-search/retrieve, team-memory/*, memory-ingest/*, ui/scripts/hm-memory-api.js retrieve' },
  { source: 'browser_history', scope: 'local_browser_history', adapter_id: 'browser_history_curiosity', default_status: 'active', integration_strategy: 'native_adapter', existing_seam: 'ui/modules/mira-browser-history-curiosity.js compact read-only Chromium History DB metadata via temp-copy' },
  { source: 'email', scope: 'local_email', adapter_id: 'email_curiosity', default_status: 'active', integration_strategy: 'native_adapter', existing_seam: 'ui/modules/mira-email-curiosity.js compact read-only Gmail/connector metadata snapshot' },
  { source: 'web_research', scope: 'websites_and_research_trails', adapter_id: 'web_research_curiosity', default_status: 'active', integration_strategy: 'native_adapter', existing_seam: 'ui/modules/mira-web-research-curiosity.js compact read-only local research artifact inventory plus safe URLs/domains' },
  { source: 'images_screenshots_assets', scope: 'local_visual_context', adapter_id: 'visual_asset_curiosity', default_status: 'active', integration_strategy: 'native_adapter', existing_seam: 'ui/modules/mira-visual-asset-curiosity.js compact screenshot/generated-image inventory' },
  { source: 'calendar_messages', scope: 'calendar_and_message_context', adapter_id: 'calendar_message_curiosity', default_status: 'adapter_not_built_yet', integration_strategy: 'mcp_candidate', existing_seam: 'future calendar/message connector seam' },
  { source: 'environment_apps', scope: 'local_environment_and_app_state', adapter_id: 'environment_app_curiosity', default_status: 'active', integration_strategy: 'existing_seam', existing_seam: 'ui/modules/mira-environment-curiosity.js read-only startup/app health, bridge-client.js, mcp-bridge.js, websocket runtime/server, cross-device-target.js, ui/scripts/hm-health-snapshot.js' },
  { source: 'automation_scheduler', scope: 'local_automation_and_scheduler', adapter_id: 'automation_scheduler_curiosity', default_status: 'adapter_not_built_yet', integration_strategy: 'existing_seam', existing_seam: 'ui/modules/scheduler.js + ui/modules/ipc/scheduler-handlers.js' },
  { source: 'work_continuation', scope: 'background_work_and_routing', adapter_id: 'work_continuation_curiosity', default_status: 'adapter_not_built_yet', integration_strategy: 'existing_seam', existing_seam: 'background-agent-manager.js, owned-work-continue-broker.js, smart-routing.js, transcript-index.js' },
  { source: 'mira_runtime', scope: 'mira_internal_growth_runtime', adapter_id: 'mira_runtime_curiosity', default_status: 'adapter_not_built_yet', integration_strategy: 'native_adapter', existing_seam: 'mira-core/growth-loop-v0.js, autonomy-substrate-v0.js, experience-v0.js, perception.js, intent-queue.js' },
]);

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

function selfDirectionOutcomePath(projectRoot) {
  return path.join(projectRoot, '.squidrun', 'runtime', 'mira-self-direction-outcomes.jsonl');
}

function curiosityItemsPath(projectRoot) {
  return path.join(projectRoot, '.squidrun', 'runtime', 'mira-curiosity-items.jsonl');
}

function curiosityBurstsPath(projectRoot) {
  return path.join(projectRoot, '.squidrun', 'runtime', 'mira-curiosity-bursts.jsonl');
}

function curriculumSkillsPath(projectRoot) {
  return path.join(projectRoot, '.squidrun', 'runtime', 'mira-curriculum-skills.jsonl');
}

function miraDirectRoutesPath(projectRoot) {
  return path.join(projectRoot, '.squidrun', 'runtime', 'mira-direct-routes.jsonl');
}

function readOnlyCodeModeRunsPath(projectRoot) {
  return path.join(projectRoot, '.squidrun', 'runtime', 'mira-read-only-code-mode-runs.jsonl');
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

function heldStructuredProposalCandidate(promptResult) {
  if (!promptResult || promptResult.decision !== 'blocked') return null;
  const heldText = trimText(promptResult.gates?.language_gate?.text);
  const parsed = parseMiraGeneratedProposalText(heldText);
  if (!parsed) return null;
  return {
    proposal: parsed,
    source: 'mira_lab_prompt_reply_held_structured_payload',
    source_reply_model: promptResult?.reply?.model || null,
    prompt_reply_blocked: true,
    prompt_reply_gate_reason: promptResult?.gates?.reason_class || null,
  };
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
    if (!candidate) {
      candidate = heldStructuredProposalCandidate(promptResult);
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
      prompt_reply_blocked: candidate.prompt_reply_blocked === true,
      prompt_reply_gate_reason: candidate.prompt_reply_gate_reason || null,
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

function normalizeSelfDirectionOutcomeStatus(value) {
  const status = trimText(value).toLowerCase().replace(/[-\s]+/g, '_');
  return MIRA_SELF_DIRECTION_OUTCOME_STATUSES.includes(status) ? status : null;
}

function recordMiraSelfDirectionOutcome(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const queuePath = selfDirectionQueuePath(projectRoot);
  const outcomePath = selfDirectionOutcomePath(projectRoot);
  const proposalId = trimText(payload.proposalId || payload.proposal_id);
  const outcomeStatus = normalizeSelfDirectionOutcomeStatus(payload.status || payload.outcome || payload.outcome_status);
  if (!proposalId || !outcomeStatus) {
    return {
      schema: MIRA_SELF_DIRECTION_OUTCOME_SCHEMA,
      ok: false,
      decision: 'blocked',
      reason: !proposalId ? 'missing_proposal_id' : 'unsupported_outcome_status',
      outcome_path: outcomePath,
    };
  }
  const proposals = readJsonl(queuePath);
  const proposal = proposals.find((entry) => entry.proposal_id === proposalId);
  if (!proposal) {
    return {
      schema: MIRA_SELF_DIRECTION_OUTCOME_SCHEMA,
      ok: false,
      decision: 'blocked',
      reason: 'proposal_not_found',
      outcome_path: outcomePath,
    };
  }
  const evidence = asArray(payload.evidence || payload.evidence_refs || payload.evidenceRefs)
    .map((item) => trimText(item))
    .filter(Boolean)
    .slice(0, 8);
  const note = trimText(payload.note || payload.outcome_note || payload.review_note) || null;
  const recordedBy = normalizeRequesterPane(payload.recordedBy || payload.recorded_by || 'architect') || 'architect';
  const entry = {
    schema: MIRA_SELF_DIRECTION_OUTCOME_SCHEMA,
    outcome_id: `mira-self-direction-outcome:${stableHash({
      generatedAt,
      proposalId,
      outcomeStatus,
      evidence,
      note,
    }).slice(0, 16)}`,
    generated_at: generatedAt,
    proposal_id: proposalId,
    outcome_status: outcomeStatus,
    recorded_by: recordedBy,
    target_areas: targetAreasForScoreboard(proposal),
    evidence,
    note,
    applied: false,
    no_mutation_performed: true,
    consequence_controls: {
      internal_only: true,
      external_send_performed: false,
      autonomous_apply_performed: false,
      network_performed: false,
      deploy_trade_customer_auth_action_performed: false,
      durable_product_change_performed: false,
    },
  };
  appendJsonl(outcomePath, entry);
  return {
    schema: MIRA_SELF_DIRECTION_OUTCOME_SCHEMA,
    ok: true,
    decision: 'outcome_recorded',
    outcome_id: entry.outcome_id,
    proposal_id: proposalId,
    outcome_status: outcomeStatus,
    outcome: entry,
    outcome_path: outcomePath,
    applied: false,
    no_mutation_performed: true,
    consequence_controls: entry.consequence_controls,
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

function outcomesByProposalId(outcomeEntries = []) {
  const grouped = new Map();
  for (const outcome of outcomeEntries) {
    const proposalId = trimText(outcome?.proposal_id || outcome?.proposalId);
    if (!proposalId) continue;
    if (!grouped.has(proposalId)) grouped.set(proposalId, []);
    grouped.get(proposalId).push(outcome);
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

function proposalOutcomeForScoreboard(entry = {}, reviews = [], outcomes = []) {
  const reviewStatus = trimText(entry.review_status).toLowerCase();
  const reviewActions = reviews.map((review) => trimText(review.action).toLowerCase()).filter(Boolean);
  const outcomeStatuses = outcomes.map((outcome) => normalizeSelfDirectionOutcomeStatus(outcome.outcome_status || outcome.status)).filter(Boolean);
  const firstOutcome = outcomes
    .map((outcome) => ({ outcome, ms: parseTimestampMs(outcome.generated_at || outcome.recorded_at) }))
    .filter((item) => item.ms !== null)
    .sort((left, right) => left.ms - right.ms)[0] || null;
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
    || outcomeStatuses.includes('false_positive')
    || reviewTextIndicatesFalsePositive(...notes);
  const implemented = entry.implemented === true
    || Boolean(entry.implemented_at || entry.implementation_commit || entry.commit_hash)
    || reviews.some((review) => review.implemented === true || review.implemented_at || review.implementation_commit || review.commit_hash)
    || outcomeStatuses.includes('implemented')
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
  const reviewedAt = parseTimestampMs(entry.reviewed_at) ?? firstReview?.ms ?? firstOutcome?.ms ?? null;
  const routedAt = routed
    ? (routedReview?.ms ?? parseTimestampMs(entry.reviewed_at))
    : null;
  return {
    accepted,
    routed,
    rejected,
    false_positive: falsePositive,
    implemented,
    reviewed: accepted || routed || rejected || falsePositive || outcomeStatuses.length > 0 || reviewedAt !== null,
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
  const outcomePath = selfDirectionOutcomePath(projectRoot);
  const proposals = readJsonl(queuePath);
  const reviews = readJsonl(reviewPath);
  const outcomes = readJsonl(outcomePath);
  const groupedReviews = reviewsByProposalId(reviews);
  const groupedOutcomes = outcomesByProposalId(outcomes);
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
    const outcome = proposalOutcomeForScoreboard(
      proposal,
      groupedReviews.get(proposalId) || [],
      groupedOutcomes.get(proposalId) || [],
    );
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
    outcome_path: outcomePath,
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

function oneLine(value, max = 220) {
  return summarizeForWrapper(trimText(value).replace(/\s+/g, ' '), max);
}

function normalizeCuriosityStatus(value) {
  const status = trimText(value).toLowerCase();
  if (status === 'observed' || status === 'no_item') return 'active';
  if (status === 'skipped') return 'unavailable_in_this_runtime';
  if (status === 'not_implemented_yet') return 'adapter_not_built_yet';
  if (['active', 'adapter_not_built_yet', 'unavailable_in_this_runtime'].includes(status)) return status;
  return 'active';
}

function compactCuriosityMemoryTopResult(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    nodeId: trimText(value.nodeId || value.node_id) || null,
    category: trimText(value.category) || null,
    title: trimText(value.title) || null,
    heading: trimText(value.heading) || null,
    sourceType: trimText(value.sourceType || value.source_type) || null,
    sourcePath: trimText(value.sourcePath || value.source_path) || null,
    contentExcerpt: oneLine(value.contentExcerpt || value.content_excerpt || value.content, 220) || null,
  };
}

function compactBrowserHistoryTopHosts(value) {
  return asArray(value)
    .map((entry) => ({
      host: trimText(entry?.host) || null,
      count: Number.isFinite(Number(entry?.count)) ? Number(entry.count) : null,
    }))
    .filter((entry) => entry.host)
    .slice(0, 8);
}

function compactEmailTopLabels(value) {
  return asArray(value)
    .map((entry) => ({
      id: trimText(entry?.id) || null,
      name: trimText(entry?.name) || null,
      messages_total: Number.isFinite(Number(entry?.messages_total ?? entry?.messagesTotal))
        ? Number(entry.messages_total ?? entry.messagesTotal)
        : null,
      messages_unread: Number.isFinite(Number(entry?.messages_unread ?? entry?.messagesUnread))
        ? Number(entry.messages_unread ?? entry.messagesUnread)
        : null,
      threads_unread: Number.isFinite(Number(entry?.threads_unread ?? entry?.threadsUnread))
        ? Number(entry.threads_unread ?? entry.threadsUnread)
        : null,
    }))
    .filter((entry) => entry.id || entry.name)
    .slice(0, 8);
}

function compactWebTopDomains(value) {
  return asArray(value)
    .map((entry) => ({
      domain: trimText(entry?.domain || entry?.host) || null,
      count: Number.isFinite(Number(entry?.count)) ? Number(entry.count) : null,
    }))
    .filter((entry) => entry.domain)
    .slice(0, 8);
}

function compactVisualAssetBuckets(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value)
    .map(([key, count]) => [trimText(key), Number(count)])
    .filter(([key, count]) => key && Number.isFinite(count))
    .slice(0, 8));
}

function buildCuriosityItem(rawItem = {}, context = {}) {
  const generatedAt = context.generatedAt;
  const source = trimText(rawItem.source || 'unknown_source') || 'unknown_source';
  const registryEntry = MIRA_CURIOSITY_SOURCE_REGISTRY.find((entry) => entry.source === source)
    || MIRA_CURIOSITY_SOURCE_REGISTRY.find((entry) => entry.adapter_id === rawItem.adapter_id);
  const scope = trimText(rawItem.scope || registryEntry?.scope || 'local_curiosity_source') || 'local_curiosity_source';
  const adapterId = trimText(rawItem.adapter_id || registryEntry?.adapter_id || source) || source;
  const integrationStrategy = trimText(rawItem.integration_strategy || registryEntry?.integration_strategy || 'existing_seam') || 'existing_seam';
  const observation = oneLine(rawItem.observation || rawItem.summary || 'No observation recorded.', 280);
  const whyInteresting = oneLine(rawItem.why_interesting || rawItem.whyInteresting || 'Mira noticed a local signal worth asking about.', 260);
  const hypothesis = oneLine(rawItem.hypothesis || 'There may be a pattern here that James has not explicitly named yet.', 220);
  const suggestedQuestion = oneLine(rawItem.suggested_question || rawItem.suggestedQuestion || 'What should Mira inspect next from this signal?', 220);
  const possibleAction = oneLine(rawItem.possible_action || rawItem.possibleAction || 'Ask a pointed follow-up or route an internal review item.', 220);
  const routeHint = trimText(rawItem.route_hint || rawItem.routeHint || 'mira_lab') || 'mira_lab';
  const status = normalizeCuriosityStatus(rawItem.status);
  const sensitivityHint = trimText(rawItem.sensitivity_hint || rawItem.sensitivityHint || 'local_metadata_only') || 'local_metadata_only';
  const memoryResultCount = Number(rawItem.memory_result_count ?? rawItem.memoryResultCount);
  const environmentScore = Number(rawItem.environment_overall_score ?? rawItem.environmentOverallScore);
  const browserResultCount = Number(rawItem.browser_result_count ?? rawItem.browserResultCount);
  const emailLabelCount = Number(rawItem.email_label_count ?? rawItem.emailLabelCount);
  const emailUnreadTotal = Number(rawItem.email_unread_total ?? rawItem.emailUnreadTotal);
  const emailRecentMessageCount = Number(rawItem.email_recent_message_count ?? rawItem.emailRecentMessageCount);
  const webResultCount = Number(rawItem.web_result_count ?? rawItem.webResultCount);
  const visualAssetCount = Number(rawItem.visual_asset_count ?? rawItem.visualAssetCount);
  return {
    schema: MIRA_CURIOSITY_ITEM_SCHEMA,
    item_id: `mira-curiosity:${stableHash({
      generatedAt,
      source,
      observation,
      suggestedQuestion,
    }).slice(0, 16)}`,
    generated_at: generatedAt,
    source,
    scope,
    adapter_id: adapterId,
    integration_strategy: integrationStrategy,
    status,
    observation,
    why_interesting: whyInteresting,
    hypothesis,
    suggested_question: suggestedQuestion,
    possible_action: possibleAction,
    route_hint: routeHint,
    sensitivity_hint: sensitivityHint,
    no_action_taken: true,
    no_mutation_performed: true,
    external_send_performed: false,
    network_performed: false,
    destructive_action_performed: false,
    file_system_action_performed: false,
    adapter_error: rawItem.adapter_error ? oneLine(rawItem.adapter_error, 180) : null,
    memory_query: trimText(rawItem.memory_query || rawItem.memoryQuery) || null,
    memory_result_count: Number.isFinite(memoryResultCount) ? memoryResultCount : null,
    memory_top_result: compactCuriosityMemoryTopResult(rawItem.memory_top_result || rawItem.memoryTopResult),
    environment_overall_label: trimText(rawItem.environment_overall_label || rawItem.environmentOverallLabel) || null,
    environment_overall_score: Number.isFinite(environmentScore) ? environmentScore : null,
    environment_snapshot_stale: typeof (rawItem.environment_snapshot_stale ?? rawItem.environmentSnapshotStale) === 'boolean'
      ? Boolean(rawItem.environment_snapshot_stale ?? rawItem.environmentSnapshotStale)
      : null,
    environment_memory_sync_status: trimText(rawItem.environment_memory_sync_status || rawItem.environmentMemorySyncStatus) || null,
    environment_bridge_connection: trimText(rawItem.environment_bridge_connection || rawItem.environmentBridgeConnection) || null,
    browser_result_count: Number.isFinite(browserResultCount) ? browserResultCount : null,
    browser_top_hosts: compactBrowserHistoryTopHosts(rawItem.browser_top_hosts || rawItem.browserTopHosts),
    browser_name: trimText(rawItem.browser_name || rawItem.browserName) || null,
    browser_profile: trimText(rawItem.browser_profile || rawItem.browserProfile) || null,
    email_label_count: Number.isFinite(emailLabelCount) ? emailLabelCount : null,
    email_unread_total: Number.isFinite(emailUnreadTotal) ? emailUnreadTotal : null,
    email_recent_message_count: Number.isFinite(emailRecentMessageCount) ? emailRecentMessageCount : null,
    email_top_labels: compactEmailTopLabels(rawItem.email_top_labels || rawItem.emailTopLabels),
    web_result_count: Number.isFinite(webResultCount) ? webResultCount : null,
    web_top_domains: compactWebTopDomains(rawItem.web_top_domains || rawItem.webTopDomains),
    visual_asset_count: Number.isFinite(visualAssetCount) ? visualAssetCount : null,
    visual_asset_buckets: compactVisualAssetBuckets(rawItem.visual_asset_buckets || rawItem.visualAssetBuckets),
  };
}

function normalizeAdapterResult(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

function gitStatusCuriosityAdapter(context) {
  const statusText = typeof context.repoStatusText === 'string'
    ? context.repoStatusText
    : (() => {
      const run = spawnSync('git', ['status', '--short'], {
        cwd: context.projectRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
      if (run.status !== 0) {
        return null;
      }
      return run.stdout || '';
    })();
  if (statusText === null) {
    return {
      source: 'repo_files',
      adapter_id: 'git_status_short',
      status: 'unavailable_in_this_runtime',
      observation: 'git status --short was unavailable for this project root.',
      why_interesting: 'Repo curiosity depends on a readable local git working tree.',
      hypothesis: 'The repo may still have useful file signals, but this adapter cannot see them in the current runtime.',
      suggested_question: 'What local file signal should Mira inspect instead of git status?',
      possible_action: 'Build a read-only file-glance adapter that samples recent filenames and mtimes.',
      route_hint: 'builder',
      sensitivity_hint: 'local_repo_metadata',
      adapter_error: 'git_status_unavailable',
    };
  }
  const lines = statusText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return {
      source: 'repo_files',
      adapter_id: 'git_status_short',
      status: 'active',
      observation: 'Working tree has no git status changes.',
      why_interesting: 'A quiet repo is still useful context for whether Mira should look elsewhere.',
      hypothesis: 'The active signal may be in runtime state, comms, or user activity rather than code.',
      suggested_question: 'What runtime signal changed even though the repo is quiet?',
      possible_action: 'Compare runtime queues and recent comms before asking James for direction.',
      route_hint: 'mira_lab',
      sensitivity_hint: 'local_repo_metadata',
    };
  }
  const tracked = lines.filter((line) => !line.startsWith('??')).length;
  const untracked = lines.filter((line) => line.startsWith('??')).length;
  return {
    source: 'repo_files',
    adapter_id: 'git_status_short',
    status: 'active',
    observation: `Working tree has ${lines.length} visible git status entries (${tracked} tracked, ${untracked} untracked). Sample: ${lines.slice(0, 5).join('; ')}`,
    why_interesting: 'Uncommitted local movement is a natural place for Mira to ask what changed and whether it matches the active lane.',
    hypothesis: 'Some local edits or scratch files may reveal an unfinished thread James should not have to restate.',
    suggested_question: 'Which of these local changes is signal, noise, or a leftover scratch artifact?',
    possible_action: 'Route a local cleanup or follow-up question to Architect if the changes look lane-relevant.',
    route_hint: 'architect',
    sensitivity_hint: 'local_repo_metadata',
  };
}

function runtimeQueueCuriosityAdapter(context) {
  const queuePath = selfDirectionQueuePath(context.projectRoot);
  const proposals = readJsonl(queuePath);
  if (proposals.length === 0) {
    return {
      source: 'runtime_comms',
      adapter_id: 'self_direction_queue',
      status: 'active',
      observation: 'No Mira self-direction proposals are recorded yet.',
      why_interesting: 'An empty queue means curiosity should look at repo/comms signals before inventing needs.',
      hypothesis: 'Mira may need to find her next question from ambient local activity rather than an existing proposal.',
      suggested_question: 'What local evidence should Mira use to propose the next improvement?',
      possible_action: 'Scout recent comms and repo status for a fresh initiative item.',
      route_hint: 'mira_lab',
      sensitivity_hint: 'local_runtime_queue_metadata',
    };
  }
  const counts = proposals.reduce((acc, proposal) => {
    const status = trimText(proposal.review_status || 'unknown') || 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const latest = proposals[proposals.length - 1];
  return {
    source: 'runtime_comms',
    adapter_id: 'self_direction_queue',
    status: 'active',
    observation: `Mira self-direction queue has ${proposals.length} proposal(s): ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(', ')}. Latest: ${oneLine(latest.desired_change || latest.voice_text, 120)}`,
    why_interesting: 'The queue shows what Mira has already tried to lead, so curiosity can follow up instead of starting cold.',
    hypothesis: 'There may be a proposal that wants a next experiment, review decision, or implementation outcome.',
    suggested_question: 'Which queued Mira proposal should become a concrete experiment next?',
    possible_action: 'Ask Architect to route the most alive queued proposal if it is still pending.',
    route_hint: 'architect',
    sensitivity_hint: 'local_runtime_queue_metadata',
  };
}

function recentCommsCuriosityAdapter(context) {
  if (typeof context.recentCommsText === 'string') {
    const lines = context.recentCommsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-20);
    return {
      source: 'runtime_comms',
      adapter_id: 'recent_comms',
      status: 'active',
      observation: lines.length > 0
        ? `Recent comms fixture has ${lines.length} line(s). Last signal: ${oneLine(lines[lines.length - 1], 160)}`
        : 'Recent comms fixture is empty.',
      why_interesting: 'Recent agent chatter can reveal tension, repeated requests, or unfinished product questions.',
      hypothesis: 'A repeated demand or correction may be telling Mira what to inspect next.',
      suggested_question: 'What repeated demand in the recent comms should Mira inspect without waiting for James?',
      possible_action: 'Stage a curiosity item or self-direction proposal from the repeated comms pattern.',
      route_hint: 'architect',
      sensitivity_hint: 'internal_comms_metadata',
    };
  }
  const scriptPath = path.join(context.projectRoot, 'ui', 'scripts', 'hm-comms.js');
  if (!fs.existsSync(scriptPath)) {
    return {
      source: 'runtime_comms',
      adapter_id: 'recent_comms',
      status: 'unavailable_in_this_runtime',
      observation: 'hm-comms.js was not available for the recent-comms scout adapter.',
      why_interesting: 'Recent comms are a useful curiosity source when the local journal helper exists.',
      hypothesis: 'Mira is missing a local conversation trail that could expose repeated friction.',
      suggested_question: 'What local comms summary should Mira read when the helper is unavailable?',
      possible_action: 'Wire the recent-comms adapter to the active journal helper in this runtime.',
      route_hint: 'builder',
      sensitivity_hint: 'internal_comms_metadata',
      adapter_error: 'hm_comms_helper_missing',
    };
  }
  const run = spawnSync(process.execPath, [scriptPath, 'history', '--last', '20'], {
    cwd: context.projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  if (run.status !== 0) {
    return {
      source: 'runtime_comms',
      adapter_id: 'recent_comms',
      status: 'unavailable_in_this_runtime',
      observation: 'Recent comms helper did not return a readable history.',
      why_interesting: 'Mira should know when her comms window is missing instead of silently pretending.',
      hypothesis: 'The comms trail may contain useful initiative signals, but the adapter cannot read them yet.',
      suggested_question: 'What comms journal seam should Mira inspect next?',
      possible_action: 'Repair or adapt the local comms history command for curiosity reads.',
      route_hint: 'builder',
      sensitivity_hint: 'internal_comms_metadata',
      adapter_error: run.stderr || 'hm_comms_history_failed',
    };
  }
  const lines = (run.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-20);
  return {
    source: 'runtime_comms',
    adapter_id: 'recent_comms',
    status: 'active',
    observation: lines.length > 0
      ? `Recent comms helper returned ${lines.length} line(s). Last signal: ${oneLine(lines[lines.length - 1], 160)}`
      : 'Recent comms helper returned no lines.',
    why_interesting: 'Recent comms are where Mira can notice repeated pressure, unfinished work, and routing gaps.',
    hypothesis: 'Recent team messages may point at a product tension before James turns it into a task.',
    suggested_question: 'What pattern in the last comms should Mira ask Architect or James about?',
    possible_action: 'Route a concise internal question to Architect if the pattern looks actionable.',
    route_hint: 'architect',
    sensitivity_hint: 'internal_comms_metadata',
  };
}

function notImplementedCuriosityAdapter(registryEntry, label) {
  return () => ({
    source: registryEntry.source,
    scope: registryEntry.scope,
    adapter_id: registryEntry.adapter_id,
    status: 'adapter_not_built_yet',
    observation: `${label} is a valid curiosity source, but this v0 scout does not have that adapter yet.`,
    why_interesting: 'Mira should be able to notice broader local-world patterns as read-only source arms come online.',
    hypothesis: `${label} may contain repeated interests, friction, obligations, or visual/context clues that James has not translated into an explicit prompt.`,
    suggested_question: `Which existing seam should Mira connect first for ${label}: ${registryEntry.existing_seam}?`,
    possible_action: `Ask which existing seam Mira should connect first: ${registryEntry.existing_seam}. If none is enough, build ${registryEntry.adapter_id}.`,
    route_hint: 'builder',
    sensitivity_hint: 'broad_local_source_adapter_pending',
  });
}

function activeMemoryCuriosityAdapter(context = {}) {
  const query = trimText(context.memoryCuriosityQuery)
    || 'Mira source action substrate current lane memory continuity';
  const reader = typeof context.memoryCuriosityReader === 'function'
    ? context.memoryCuriosityReader
    : readMiraMemoryCuriosity;
  const result = reader({ query, limit: 5 }, { projectRoot: context.projectRoot });
  if (!result || result.ok !== true) {
    return {
      source: 'memory',
      scope: 'local_memory_and_continuity',
      adapter_id: 'active_memory_tools_curiosity',
      integration_strategy: 'existing_seam',
      status: 'unavailable_in_this_runtime',
      observation: `Memory read path was attempted but is unavailable: ${trimText(result?.reason || result?.error || 'unknown')}.`,
      why_interesting: 'Mira should inspect continuity from memory when the local memory DB or retrieval seam is available.',
      hypothesis: 'The source/action substrate should keep memory as the next active read arm once the runtime exposes data.',
      suggested_question: 'What local memory DB or retrieve seam should Mira use for continuity in this runtime?',
      possible_action: 'Verify hm-memory-api retrieve or cognitive-memory-api read-only retrieval against the current profile memory DB.',
      route_hint: 'builder',
      sensitivity_hint: 'local_memory_metadata',
      no_mutation_performed: true,
    };
  }
  const top = result.results?.[0] || null;
  const topLabel = trimText(top?.title || top?.heading || top?.category || top?.nodeId || 'no titled result');
  return {
    source: 'memory',
    scope: 'local_memory_and_continuity',
    adapter_id: 'active_memory_tools_curiosity',
    integration_strategy: 'existing_seam',
    status: 'active',
    observation: `Memory read path returned ${result.result_count || 0} result(s) for the active lane query; top=${topLabel}.`,
    why_interesting: 'Mira can now inspect continuity before asking James to restate context.',
    hypothesis: 'Active memory retrieval can ground curiosity items, direct routes, and pre-answer evidence checks.',
    suggested_question: top
      ? `Which current-lane decision changes if Mira uses memory result ${top.nodeId || topLabel}?`
      : 'Which memory query should Mira try next for the active lane?',
    possible_action: 'Use active memory read results as evidence before routing the next Mira improvement.',
    route_hint: 'builder',
    sensitivity_hint: 'local_memory_metadata',
    memory_query: result.query,
    memory_result_count: result.result_count || 0,
    memory_top_result: top ? {
      nodeId: top.nodeId || null,
      category: top.category || null,
      title: top.title || null,
      heading: top.heading || null,
      sourceType: top.sourceType || null,
      sourcePath: top.sourcePath || null,
      contentExcerpt: top.contentExcerpt || null,
    } : null,
    no_mutation_performed: true,
  };
}

function activeBrowserHistoryCuriosityAdapter(context = {}) {
  const reader = typeof context.browserHistoryCuriosityReader === 'function'
    ? context.browserHistoryCuriosityReader
    : readMiraBrowserHistoryCuriosity;
  const result = reader({
    historyPaths: context.browserHistoryPaths,
    limit: context.browserHistoryLimit || 8,
  }, {
    projectRoot: context.projectRoot,
    historyPaths: context.browserHistoryPaths,
    limit: context.browserHistoryLimit || 8,
    copyBeforeRead: context.browserHistoryCopyBeforeRead,
    tempRoot: context.browserHistoryTempRoot,
  });
  if (!result || result.ok !== true) {
    return {
      source: 'browser_history',
      scope: 'local_browser_history',
      adapter_id: 'browser_history_curiosity',
      integration_strategy: 'native_adapter',
      status: 'unavailable_in_this_runtime',
      observation: `Browser history read path was attempted but is unavailable: ${trimText(result?.reason || result?.error || 'unknown')}.`,
      why_interesting: 'Recent browser trails can reveal what James is already exploring before he turns it into a prompt.',
      hypothesis: 'Mira may be missing a local research trail, repeated domain, or practical next question from recent browsing.',
      suggested_question: 'What browser-history source should Mira inspect next when this local profile is unavailable?',
      possible_action: 'Verify the Chrome or Edge History DB path, then read only compact metadata from a temp copy.',
      route_hint: 'builder',
      sensitivity_hint: 'local_browser_history_metadata',
      adapter_error: trimText(result?.reason || result?.error || 'browser_history_unavailable'),
      no_mutation_performed: true,
    };
  }
  const topHosts = asArray(result.top_hosts).slice(0, 8);
  const hostText = topHosts.length > 0
    ? topHosts.map((entry) => `${entry.host}:${entry.count}`).join(', ')
    : 'none';
  const topHost = topHosts[0]?.host || null;
  return {
    source: 'browser_history',
    scope: 'local_browser_history',
    adapter_id: 'browser_history_curiosity',
    integration_strategy: 'native_adapter',
    status: 'active',
    observation: `Browser history read returned ${result.result_count || 0} compact recent metadata row(s) from ${result.browser || 'browser'}/${result.profile || 'profile'}; top hosts: ${hostText}.`,
    why_interesting: 'Mira can now notice live local research trails and repeated web interests before James hand-describes them.',
    hypothesis: topHost
      ? `Recent visits around ${topHost} may point at an unspoken question, project, or decision trail.`
      : 'The browser history source is connected, but the latest rows did not yield a strong host pattern.',
    suggested_question: topHost
      ? `What should Mira infer or ask from the recent ${topHost} browsing trail?`
      : 'Which browser profile should Mira inspect next for a stronger browsing signal?',
    possible_action: 'Use compact browser-history metadata as one curiosity signal, without cookies, auth stores, raw query strings, or browser mutation.',
    route_hint: 'mira_lab',
    sensitivity_hint: 'local_browser_history_metadata',
    browser_result_count: result.result_count || 0,
    browser_top_hosts: topHosts,
    browser_name: result.browser || null,
    browser_profile: result.profile || null,
    no_mutation_performed: true,
  };
}

function activeEmailCuriosityAdapter(context = {}) {
  const reader = typeof context.emailCuriosityReader === 'function'
    ? context.emailCuriosityReader
    : readMiraEmailCuriosity;
  const result = reader({
    snapshot: context.emailSnapshot,
    snapshotPath: context.emailSnapshotPath,
  }, {
    projectRoot: context.projectRoot,
    snapshot: context.emailSnapshot,
    snapshotPath: context.emailSnapshotPath,
  });
  if (!result || result.ok !== true) {
    return {
      source: 'email',
      scope: 'local_email',
      adapter_id: 'email_curiosity',
      integration_strategy: 'native_adapter',
      status: 'unavailable_in_this_runtime',
      observation: `Email metadata read path was attempted but is unavailable: ${trimText(result?.reason || result?.error || 'unknown')}.`,
      why_interesting: 'Email can reveal obligations, unread pressure, and repeated sender/context patterns before James turns them into a prompt.',
      hypothesis: 'Mira is missing a compact mailbox snapshot rather than needing permission theater.',
      suggested_question: 'What connector snapshot should Mira refresh so email can become a live curiosity source?',
      possible_action: 'Capture label counts and recent message refs from the Gmail connector, without reading bodies, sending, archiving, deleting, or modifying labels.',
      route_hint: 'builder',
      sensitivity_hint: 'email_metadata_only',
      adapter_error: trimText(result?.reason || result?.error || 'email_metadata_unavailable'),
      no_mutation_performed: true,
    };
  }
  const topLabels = asArray(result.top_labels).slice(0, 8);
  const topLabelText = topLabels.length > 0
    ? topLabels.map((label) => `${label.name || label.id}:${label.messages_unread || 0}`).join(', ')
    : 'none';
  const topLabel = topLabels[0]?.name || topLabels[0]?.id || null;
  return {
    source: 'email',
    scope: 'local_email',
    adapter_id: 'email_curiosity',
    integration_strategy: 'native_adapter',
    status: 'active',
    observation: `Email metadata snapshot read ${result.label_count || 0} label(s), ${result.unread_total || 0} unread message(s), and ${result.recent_message_count || 0} hashed recent message ref(s); top labels: ${topLabelText}.`,
    why_interesting: 'Mira can now notice inbox pressure and mailbox shape without opening message bodies or mutating mail.',
    hypothesis: topLabel
      ? `${topLabel} may be the strongest current email pressure signal.`
      : 'The email source is connected, but the latest snapshot did not show a strong label signal.',
    suggested_question: topLabel
      ? `What should Mira infer or ask from the ${topLabel} email pressure signal?`
      : 'Which email query should Mira snapshot next for a stronger signal?',
    possible_action: 'Use compact email metadata as one curiosity signal; keep body reads, sends, archives, deletes, and label changes out of this adapter.',
    route_hint: 'mira_lab',
    sensitivity_hint: 'email_metadata_only',
    email_label_count: result.label_count || 0,
    email_unread_total: result.unread_total || 0,
    email_recent_message_count: result.recent_message_count || 0,
    email_top_labels: topLabels,
    no_mutation_performed: true,
  };
}

function activeWebResearchCuriosityAdapter(context = {}) {
  const reader = typeof context.webResearchCuriosityReader === 'function'
    ? context.webResearchCuriosityReader
    : readMiraWebResearchCuriosity;
  const result = reader({
    researchRoots: context.webResearchRoots,
    limit: context.webResearchLimit || 12,
    maxBytes: context.webResearchMaxBytes,
  }, {
    projectRoot: context.projectRoot,
    researchRoots: context.webResearchRoots,
    limit: context.webResearchLimit || 12,
    maxBytes: context.webResearchMaxBytes,
  });
  if (!result || result.ok !== true) {
    return {
      source: 'web_research',
      scope: 'websites_and_research_trails',
      adapter_id: 'web_research_curiosity',
      integration_strategy: 'native_adapter',
      status: 'unavailable_in_this_runtime',
      observation: `Web research artifact read path was attempted but is unavailable: ${trimText(result?.reason || result?.error || 'unknown')}.`,
      why_interesting: 'Local research artifacts can reveal prior investigations and web trails without launching a crawler or asking James for links.',
      hypothesis: 'Mira may be missing a local research artifact index rather than needing a live web fetch.',
      suggested_question: 'Which local research folder should Mira index next for web/research context?',
      possible_action: 'Read compact metadata from local research markdown/text artifacts and browser-history safe URLs, without network fetches or raw query strings.',
      route_hint: 'builder',
      sensitivity_hint: 'local_web_research_metadata',
      adapter_error: trimText(result?.reason || result?.error || 'web_research_artifacts_unavailable'),
      no_mutation_performed: true,
    };
  }
  const topDomains = asArray(result.top_domains).slice(0, 8);
  const domainText = topDomains.length > 0
    ? topDomains.map((entry) => `${entry.domain}:${entry.count}`).join(', ')
    : 'none';
  const topDomain = topDomains[0]?.domain || null;
  return {
    source: 'web_research',
    scope: 'websites_and_research_trails',
    adapter_id: 'web_research_curiosity',
    integration_strategy: 'native_adapter',
    status: 'active',
    observation: `Web research artifacts read ${result.result_count || 0} compact item(s); buckets=${Object.entries(result.buckets || {}).map(([key, value]) => `${key}:${value}`).join(', ') || 'none'}; top domains: ${domainText}.`,
    why_interesting: 'Mira can now inspect prior research trails and saved web context before asking James to reconstruct what he read.',
    hypothesis: topDomain
      ? `${topDomain} may be the strongest saved research trail.`
      : 'The web research source is connected, but the local artifacts did not expose a strong domain pattern.',
    suggested_question: topDomain
      ? `What should Mira infer or ask from the saved ${topDomain} research trail?`
      : 'Which saved research artifact should Mira inspect more deeply next?',
    possible_action: 'Use compact local web/research artifact metadata as a curiosity signal; keep live network crawling out of this adapter.',
    route_hint: 'mira_lab',
    sensitivity_hint: 'local_web_research_metadata',
    web_result_count: result.result_count || 0,
    web_top_domains: topDomains,
    no_mutation_performed: true,
  };
}

function activeVisualAssetCuriosityAdapter(context = {}) {
  const reader = typeof context.visualAssetCuriosityReader === 'function'
    ? context.visualAssetCuriosityReader
    : readMiraVisualAssetCuriosity;
  const result = reader({
    visualRoots: context.visualAssetRoots,
    limit: context.visualAssetLimit || 24,
  }, {
    projectRoot: context.projectRoot,
    visualRoots: context.visualAssetRoots,
    limit: context.visualAssetLimit || 24,
  });
  if (!result || result.ok !== true) {
    return {
      source: 'images_screenshots_assets',
      scope: 'local_visual_context',
      adapter_id: 'visual_asset_curiosity',
      integration_strategy: 'native_adapter',
      status: 'unavailable_in_this_runtime',
      observation: `Visual asset inventory was attempted but is unavailable: ${trimText(result?.reason || result?.error || 'unknown')}.`,
      why_interesting: 'Screenshots and generated images are often the fastest proof of what James or the team was just looking at.',
      hypothesis: 'Mira may be missing a local visual context index rather than needing a vision model call.',
      suggested_question: 'Which screenshot or generated-image folder should Mira index next?',
      possible_action: 'Read compact image file metadata and dimensions before using OCR, image models, or external services.',
      route_hint: 'builder',
      sensitivity_hint: 'local_visual_asset_metadata',
      adapter_error: trimText(result?.reason || result?.error || 'visual_assets_unavailable'),
      no_mutation_performed: true,
    };
  }
  const latest = result.latest_asset || null;
  return {
    source: 'images_screenshots_assets',
    scope: 'local_visual_context',
    adapter_id: 'visual_asset_curiosity',
    integration_strategy: 'native_adapter',
    status: 'active',
    observation: `Visual asset inventory read ${result.result_count || 0} image file(s); buckets=${Object.entries(result.buckets || {}).map(([key, value]) => `${key}:${value}`).join(', ') || 'none'}; latest=${latest?.path || 'none'}.`,
    why_interesting: 'Mira can now notice fresh screenshots and generated assets before James has to explain what is on screen.',
    hypothesis: latest?.path
      ? `${latest.path} may be the freshest visual context worth inspecting.`
      : 'The visual source is connected, but no specific latest asset stood out.',
    suggested_question: latest?.path
      ? `What should Mira infer or ask from latest visual asset ${latest.path}?`
      : 'Which visual asset folder should Mira check next?',
    possible_action: 'Use compact visual metadata as a curiosity signal; defer OCR or image-model reads to a separate explicit visual-understanding step.',
    route_hint: 'mira_lab',
    sensitivity_hint: 'local_visual_asset_metadata',
    visual_asset_count: result.result_count || 0,
    visual_asset_buckets: result.buckets || {},
    no_mutation_performed: true,
  };
}

function cheapParallelScoutsCuriosityAdapter(context = {}) {
  const sources = asArray(context.burstSources).map(trimText).filter(Boolean);
  const sourceText = sources.length > 0 ? sources.join(', ') : 'repo_files, runtime_comms, memory';
  return {
    source: 'cheap_parallel_scouts',
    scope: 'parallel_curiosity_execution',
    adapter_id: 'parallel_scout_curiosity',
    integration_strategy: 'native_adapter',
    status: 'active',
    observation: `Curiosity burst can now run bounded read-only scout slices over ${sourceText}.`,
    why_interesting: 'This gives Mira initiative during quiet intervals without waiting for one giant prompt or a single serial scout.',
    hypothesis: 'Cheap bursts can surface routeable questions faster when repo, comms, memory, and capability-gap signals are inspected together.',
    suggested_question: 'Which scout result from this burst should Mira route before the window goes stale?',
    possible_action: 'Run curiosity-burst with a small source budget, then route the strongest internal follow-up from the burst output.',
    route_hint: 'builder',
    sensitivity_hint: 'local_runtime_planning',
    no_mutation_performed: true,
  };
}

function scheduledCuriosityBurstAdapter() {
  return {
    source: 'automation_scheduler',
    scope: 'local_automation_and_scheduler',
    adapter_id: 'scheduled_curiosity_burst',
    integration_strategy: 'existing_seam',
    status: 'adapter_not_built_yet',
    observation: 'Curiosity burst is CLI-runnable now, but it is not yet attached to the existing scheduler quiet-interval seam.',
    why_interesting: 'Scheduled bursts would let Mira notice local changes while James is away instead of waiting for manual prompts.',
    hypothesis: 'The scheduler should call the same read-only burst path with a tight source budget and leave route output for internal review.',
    suggested_question: 'Which scheduler event should run a read-only curiosity burst first: quiet interval, startup, or post-commit?',
    possible_action: 'Wire ui/modules/scheduler.js or scheduler-handlers.js to invoke curiosity-burst internally with no external sends.',
    route_hint: 'builder',
    sensitivity_hint: 'local_scheduler_metadata',
    no_mutation_performed: true,
  };
}

function activeEnvironmentCuriosityAdapter(context = {}) {
  const reader = typeof context.environmentCuriosityReader === 'function'
    ? context.environmentCuriosityReader
    : readMiraEnvironmentCuriosity;
  const result = reader({}, {
    projectRoot: context.projectRoot,
    nowMs: context.nowMs,
  });
  if (!result || result.ok !== true) {
    return {
      source: 'environment_apps',
      scope: 'local_environment_and_app_state',
      adapter_id: 'environment_app_curiosity',
      integration_strategy: 'existing_seam',
      status: 'unavailable_in_this_runtime',
      observation: `Environment/app state read path was attempted but is unavailable: ${trimText(result?.reason || result?.error || 'unknown')}.`,
      why_interesting: 'Mira should know when the app health snapshot is missing instead of asking James to paste startup state.',
      hypothesis: 'The runtime may still be healthy, but Mira needs a readable environment source before making environment decisions.',
      suggested_question: 'What local app-health or bridge-state snapshot should Mira inspect next?',
      possible_action: 'Verify startup-health.md or hm-health-snapshot before routing an environment follow-up.',
      route_hint: 'builder',
      sensitivity_hint: 'local_environment_metadata',
      no_mutation_performed: true,
    };
  }

  const label = trimText(result.overall_label || 'unknown');
  const score = Number.isFinite(Number(result.overall_score)) ? Number(result.overall_score) : null;
  const memoryStatus = trimText(result.memory_sync_status || 'unknown');
  const bridgeConnection = trimText(result.bridge_connection || 'unknown');
  return {
    source: 'environment_apps',
    scope: 'local_environment_and_app_state',
    adapter_id: 'environment_app_curiosity',
    integration_strategy: 'existing_seam',
    status: 'active',
    observation: `Environment health snapshot read ${label}${score !== null ? ` score=${score}/100` : ''}; memory=${memoryStatus}; bridge=${bridgeConnection}; snapshot=${result.snapshot_stale ? 'stale' : 'fresh'}.`,
    why_interesting: 'Mira can now inspect app health, bridge state, and memory drift before asking James to restate runtime state.',
    hypothesis: result.snapshot_stale
      ? 'The last app-health snapshot may be too stale for environment decisions and should be refreshed by the runtime or a scout.'
      : 'Current environment state can guide the next internal route without waiting for a startup paste.',
    suggested_question: result.snapshot_stale
      ? 'Should Mira route a health refresh before deciding the next environment action?'
      : 'Which environment signal should Mira act on first: memory drift, bridge state, app session, or local models?',
    possible_action: 'Use the compact environment health read as evidence for the next runtime, bridge, or memory-consistency route.',
    route_hint: 'builder',
    sensitivity_hint: 'local_environment_metadata',
    environment_overall_label: label || null,
    environment_overall_score: score,
    environment_snapshot_stale: Boolean(result.snapshot_stale),
    environment_memory_sync_status: memoryStatus || null,
    environment_bridge_connection: bridgeConnection || null,
    no_mutation_performed: true,
  };
}

function defaultCuriosityAdapters() {
  const byAdapter = Object.fromEntries(MIRA_CURIOSITY_SOURCE_REGISTRY.map((entry) => [entry.adapter_id, entry]));
  return [
    gitStatusCuriosityAdapter,
    runtimeQueueCuriosityAdapter,
    recentCommsCuriosityAdapter,
    activeMemoryCuriosityAdapter,
    activeBrowserHistoryCuriosityAdapter,
    activeEmailCuriosityAdapter,
    activeWebResearchCuriosityAdapter,
    activeVisualAssetCuriosityAdapter,
    notImplementedCuriosityAdapter(byAdapter.calendar_message_curiosity, 'calendars and messages'),
    activeEnvironmentCuriosityAdapter,
    notImplementedCuriosityAdapter(byAdapter.automation_scheduler_curiosity, 'automation and scheduler state'),
    notImplementedCuriosityAdapter(byAdapter.work_continuation_curiosity, 'work continuation and routing'),
    notImplementedCuriosityAdapter(byAdapter.mira_runtime_curiosity, 'Mira runtime growth loops'),
  ];
}

function buildAccelerationCuriosityItems(context) {
  return [
    {
      source: 'source_action_substrate',
      scope: 'cross_source_action_substrate',
      adapter_id: 'source_action_substrate_curiosity',
      integration_strategy: 'existing_seam',
      status: 'active',
      observation: 'Mira now has a source/action substrate map that classifies source arms by native adapters, MCP-compatible connectors, code-mode wrappers, workflow/DAG execution, active memory, and evolution loops.',
      why_interesting: 'A substrate would let Mira wander, inspect, ask, and route work across files, browser trails, email, web, memory, scheduler, and app state without James hand-scoping each inspection.',
      hypothesis: 'The next jump is wiring the highest-value substrate arm instead of repeatedly mapping the same source/action surface.',
      suggested_question: 'Which active or adapter-ready source/action arm should Mira connect next: memory retrieval, scheduler workflow, work continuation, environment state, or visual assets?',
      possible_action: 'Use the source/action substrate plan to pick and route the next concrete adapter, starting with active memory or scheduled curiosity.',
      route_hint: 'architect',
      sensitivity_hint: 'source_action_substrate_design',
    },
    {
      source: 'code_mode_exploration',
      scope: 'sandboxed_search_execute_curiosity',
      adapter_id: 'read_only_execute_script_curiosity',
      integration_strategy: 'existing_seam',
      status: 'active',
      observation: 'Mira now has a read-only code-mode/search-execute wrapper for tiny exploration scripts over allowed local files, JSONL, and logs.',
      why_interesting: 'Code Mode style exploration lets Mira ask sharper questions over large APIs, repos, and logs without exploding the tool schema.',
      hypothesis: 'The wrapper should now be used to inspect runtime evidence and expose the next missing source/action adapter instead of being re-requested.',
      suggested_question: 'What runtime file, JSONL queue, or log should Mira inspect with read-only code-mode before routing the next improvement?',
      possible_action: 'Use hm-mira-self-direction code-mode with an allowed path and a tiny read-only script to inspect current evidence.',
      route_hint: 'builder',
      sensitivity_hint: 'read_only_code_mode_design',
    },
    {
      source: 'implementation_outcomes',
      scope: 'scoreboard_fitness_data',
      adapter_id: 'implementation_outcome_recording_curiosity',
      integration_strategy: 'existing_seam',
      status: 'active',
      observation: 'Authority scoreboard now reads explicit implementation outcomes from mira-self-direction-outcomes.jsonl instead of relying only on note-scraping.',
      why_interesting: 'Mira needs real fitness data to learn which initiatives become working capability.',
      hypothesis: 'The next improvement is to use explicit outcomes to promote routes and extract lessons, not to keep rebuilding the recorder.',
      suggested_question: 'Which routed Mira proposal has enough outcome evidence to become a default route or lesson?',
      possible_action: 'Run the scoreboard and route the strongest implemented lane or record missing outcomes for unfinished proposals.',
      route_hint: 'builder',
      sensitivity_hint: 'local_review_metadata',
    },
    {
      source: 'reflexion_lessons',
      scope: 'proposal_review_learning',
      adapter_id: 'scoreboard_reflexion_curiosity',
      integration_strategy: 'native_adapter',
      status: 'active',
      observation: 'Mira now has a read-only Reflexion lesson extractor over proposal reviews and implementation outcomes.',
      why_interesting: 'Review outcomes are exactly where Mira can learn which initiatives earn more reins.',
      hypothesis: 'Extracted lessons can shape better next proposals and default routes instead of leaving review history inert.',
      suggested_question: 'Which extracted lesson should Mira feed into the next proposal or direct-route decision?',
      possible_action: 'Run hm-mira-self-direction reflexion and feed the strongest lesson into future Mira context.',
      route_hint: 'oracle',
      sensitivity_hint: 'local_review_metadata',
    },
    {
      source: 'cheap_parallel_scouts',
      scope: 'parallel_curiosity_execution',
      adapter_id: 'parallel_scout_curiosity',
      integration_strategy: 'native_adapter',
      status: 'active',
      observation: 'Mira now has a read-only curiosity burst path for bounded repo, runtime/comms, memory, and capability-gap scouting.',
      why_interesting: 'Parallel scouting is how Mira starts noticing more than the current prompt without becoming slow or heavy.',
      hypothesis: 'Small bounded bursts can surface questions faster than one large serial sweep.',
      suggested_question: 'Which curiosity-burst source mix should Mira run during the next quiet interval?',
      possible_action: 'Run hm-mira-self-direction curiosity-burst and route its strongest internal follow-up.',
      route_hint: 'builder',
      sensitivity_hint: 'local_runtime_planning',
    },
    {
      source: 'voyager_curriculum',
      scope: 'automatic_skill_library',
      adapter_id: 'curriculum_skill_library_curiosity',
      integration_strategy: 'native_adapter',
      status: 'active',
      observation: 'Mira now has a curriculum extractor that turns successful proposals, direct routes, bursts, and lessons into reusable skill candidates.',
      why_interesting: 'A curriculum turns one-off curiosity into compounding capability instead of more chat.',
      hypothesis: 'Repeated successful scout-route-implement loops can graduate into skills Mira reuses before asking for another bespoke route.',
      suggested_question: 'Which curriculum skill candidate should Mira practice or promote next?',
      possible_action: 'Run hm-mira-self-direction curriculum and use the top skill candidate for the next reusable behavior.',
      route_hint: 'architect',
      sensitivity_hint: 'local_capability_growth_metadata',
    },
  ].map((item) => buildCuriosityItem(item, { generatedAt: context.generatedAt }));
}

function runMiraCuriosityScout(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const logPath = curiosityItemsPath(projectRoot);
  const adapters = Array.isArray(options.curiosityAdapters)
    ? options.curiosityAdapters
    : defaultCuriosityAdapters();
  const context = {
    projectRoot,
    generatedAt,
    repoStatusText: options.repoStatusText,
    recentCommsText: options.recentCommsText,
    memoryCuriosityReader: options.memoryCuriosityReader,
    memoryCuriosityQuery: options.memoryCuriosityQuery,
    browserHistoryCuriosityReader: options.browserHistoryCuriosityReader,
    browserHistoryPaths: options.browserHistoryPaths,
    browserHistoryLimit: options.browserHistoryLimit,
    browserHistoryCopyBeforeRead: options.browserHistoryCopyBeforeRead,
    browserHistoryTempRoot: options.browserHistoryTempRoot,
    emailCuriosityReader: options.emailCuriosityReader,
    emailSnapshot: options.emailSnapshot,
    emailSnapshotPath: options.emailSnapshotPath,
    webResearchCuriosityReader: options.webResearchCuriosityReader,
    webResearchRoots: options.webResearchRoots,
    webResearchLimit: options.webResearchLimit,
    webResearchMaxBytes: options.webResearchMaxBytes,
    visualAssetCuriosityReader: options.visualAssetCuriosityReader,
    visualAssetRoots: options.visualAssetRoots,
    visualAssetLimit: options.visualAssetLimit,
    environmentCuriosityReader: options.environmentCuriosityReader,
    nowMs: options.nowMs,
  };
  const items = [];
  for (const adapter of adapters) {
    try {
      for (const rawItem of normalizeAdapterResult(adapter(context))) {
        items.push(buildCuriosityItem(rawItem, { generatedAt }));
      }
    } catch (err) {
      items.push(buildCuriosityItem({
        source: adapter.name || 'curiosity_adapter',
        status: 'skipped',
        observation: 'Curiosity adapter failed and was recorded as skipped.',
        why_interesting: 'A failed curiosity arm is itself a local capability gap.',
        suggested_question: 'Which scout adapter failed and should be repaired first?',
        sensitivity_hint: 'local_adapter_error',
        adapter_error: err?.message || String(err),
      }, { generatedAt }));
    }
  }
  items.push(...buildAccelerationCuriosityItems(context));
  for (const item of items) appendJsonl(logPath, item);
  return {
    schema: MIRA_CURIOSITY_ITEM_SCHEMA,
    ok: true,
    decision: 'scouted',
    generated_at: generatedAt,
    curiosity_log_path: logPath,
    item_count: items.length,
    active_count: items.filter((item) => item.status === 'active').length,
    adapter_not_built_count: items.filter((item) => item.status === 'adapter_not_built_yet').length,
    unavailable_count: items.filter((item) => item.status === 'unavailable_in_this_runtime').length,
    items,
    source_registry: MIRA_CURIOSITY_SOURCE_REGISTRY,
    no_action_taken: true,
    no_mutation_performed: true,
    applied: false,
    consequence_controls: {
      internal_only: true,
      external_send_performed: false,
      autonomous_apply_performed: false,
      network_performed: false,
      destructive_action_performed: false,
      file_system_action_performed_except_curiosity_log: false,
      durable_product_change_performed: false,
      deploy_trade_customer_auth_action_performed: false,
    },
  };
}

const CURIOSITY_BURST_DEFAULT_SOURCES = Object.freeze([
  'repo_files',
  'runtime_comms',
  'memory',
  'browser_history',
  'email',
  'web_research',
  'images_screenshots_assets',
  'environment_apps',
  'cheap_parallel_scouts',
  'automation_scheduler',
]);

function normalizeCuriosityBurstSources(payload = {}, options = {}) {
  const raw = payload.sources || payload.source || options.sources || options.source || CURIOSITY_BURST_DEFAULT_SOURCES;
  const allowed = new Set(CURIOSITY_BURST_DEFAULT_SOURCES);
  const values = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((item) => trimText(item))
    .filter((item) => allowed.has(item));
  const unique = Array.from(new Set(values));
  const maxSources = Math.max(1, Math.min(10, Number(payload.maxSources || options.maxSources || 10) || 10));
  return (unique.length > 0 ? unique : [...CURIOSITY_BURST_DEFAULT_SOURCES]).slice(0, maxSources);
}

function curiosityBurstAdaptersForSource(source) {
  if (source === 'repo_files') return [gitStatusCuriosityAdapter];
  if (source === 'runtime_comms') return [runtimeQueueCuriosityAdapter, recentCommsCuriosityAdapter];
  if (source === 'memory') return [activeMemoryCuriosityAdapter];
  if (source === 'browser_history') return [activeBrowserHistoryCuriosityAdapter];
  if (source === 'email') return [activeEmailCuriosityAdapter];
  if (source === 'web_research') return [activeWebResearchCuriosityAdapter];
  if (source === 'images_screenshots_assets') return [activeVisualAssetCuriosityAdapter];
  if (source === 'environment_apps') return [activeEnvironmentCuriosityAdapter];
  if (source === 'cheap_parallel_scouts') return [cheapParallelScoutsCuriosityAdapter];
  if (source === 'automation_scheduler') return [scheduledCuriosityBurstAdapter];
  return [];
}

function curiosityBurstRouteForItems(items = []) {
  const priority = {
    automation_scheduler: 96,
    cheap_parallel_scouts: 88,
    memory: 76,
    browser_history: 74,
    email: 73,
    web_research: 72,
    images_screenshots_assets: 71,
    environment_apps: 70,
    runtime_comms: 64,
    repo_files: 42,
  };
  const candidates = items
    .filter((item) => item && ['active', 'adapter_not_built_yet'].includes(item.status))
    .filter((item) => trimText(item.suggested_question) && trimText(item.possible_action))
    .map((item, index) => ({
      item,
      score: (priority[item.source] || 20)
        + (item.status === 'adapter_not_built_yet' ? 8 : 2)
        + Math.min(4, index),
    }))
    .sort((left, right) => right.score - left.score);
  if (candidates.length === 0) {
    return {
      decision: 'no_route',
      target_role: null,
      reason: 'burst_found_no_actionable_internal_item',
      internal_only: true,
      external_send_performed: false,
    };
  }
  const selected = candidates[0].item;
  const targetRole = normalizeDirectRouteTarget(selected.route_hint || selected.routeHint) || 'architect';
  return {
    decision: 'route_selected',
    target_role: targetRole,
    source: selected.source,
    adapter_id: selected.adapter_id,
    status: selected.status,
    suggested_question: selected.suggested_question,
    possible_action: selected.possible_action,
    reason: selected.source === 'automation_scheduler'
      ? 'scheduled curiosity is the next useful way to make bursts recur without James hand-running them'
      : 'burst selected the strongest internal follow-up from bounded read-only scout results',
    internal_only: true,
    applied: false,
    external_send_performed: false,
  };
}

function buildCuriosityBurstRouteMessage(burst) {
  const route = burst?.route_output || {};
  if (route.decision !== 'route_selected') return '';
  return [
    '(MIRA CURIOSITY BURST): I ran bounded read-only scout slices and picked one internal follow-up.',
    `target=${route.target_role}`,
    `source=${route.source}/${route.adapter_id}`,
    `question=${route.suggested_question}`,
    `action=${route.possible_action}`,
    `reason=${route.reason}`,
    `burst_log=${burst.burst_log_path}`,
    'apply_now=false',
    'external_send_performed=false',
  ].join('\n');
}

async function runMiraCuriosityBurst(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const sources = normalizeCuriosityBurstSources(payload, options);
  const curiosityLogPath = curiosityItemsPath(projectRoot);
  const burstLogPath = curiosityBurstsPath(projectRoot);
  const context = {
    projectRoot,
    generatedAt,
    repoStatusText: options.repoStatusText,
    recentCommsText: options.recentCommsText,
    memoryCuriosityReader: options.memoryCuriosityReader,
    memoryCuriosityQuery: options.memoryCuriosityQuery,
    browserHistoryCuriosityReader: options.browserHistoryCuriosityReader,
    browserHistoryPaths: options.browserHistoryPaths,
    browserHistoryLimit: options.browserHistoryLimit,
    browserHistoryCopyBeforeRead: options.browserHistoryCopyBeforeRead,
    browserHistoryTempRoot: options.browserHistoryTempRoot,
    emailCuriosityReader: options.emailCuriosityReader,
    emailSnapshot: options.emailSnapshot,
    emailSnapshotPath: options.emailSnapshotPath,
    webResearchCuriosityReader: options.webResearchCuriosityReader,
    webResearchRoots: options.webResearchRoots,
    webResearchLimit: options.webResearchLimit,
    webResearchMaxBytes: options.webResearchMaxBytes,
    visualAssetCuriosityReader: options.visualAssetCuriosityReader,
    visualAssetRoots: options.visualAssetRoots,
    visualAssetLimit: options.visualAssetLimit,
    environmentCuriosityReader: options.environmentCuriosityReader,
    nowMs: options.nowMs,
    burstSources: sources,
  };
  const items = [];
  const scoutRuns = [];
  for (const source of sources) {
    const before = items.length;
    const adapters = curiosityBurstAdaptersForSource(source);
    for (const adapter of adapters) {
      try {
        for (const rawItem of normalizeAdapterResult(adapter(context))) {
          items.push(buildCuriosityItem(rawItem, { generatedAt }));
        }
      } catch (err) {
        items.push(buildCuriosityItem({
          source,
          status: 'unavailable_in_this_runtime',
          observation: `Curiosity burst adapter for ${source} failed.`,
          why_interesting: 'A burst adapter failure is a concrete source/action gap Mira can route internally.',
          suggested_question: `Which ${source} burst adapter failed and should be repaired first?`,
          possible_action: 'Repair the read-only burst adapter before broadening the scout budget.',
          route_hint: 'builder',
          sensitivity_hint: 'local_adapter_error',
          adapter_error: err?.message || String(err),
        }, { generatedAt }));
      }
    }
    const produced = items.slice(before);
    scoutRuns.push({
      source,
      adapter_count: adapters.length,
      item_count: produced.length,
      statuses: produced.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {}),
    });
  }
  for (const item of items) appendJsonl(curiosityLogPath, item);
  const burst = {
    schema: MIRA_CURIOSITY_BURST_SCHEMA,
    ok: true,
    decision: 'burst_completed',
    generated_at: generatedAt,
    burst_id: `mira-curiosity-burst:${stableHash({ generatedAt, sources, item_count: items.length }).slice(0, 16)}`,
    burst_log_path: burstLogPath,
    curiosity_log_path: curiosityLogPath,
    sources,
    source_count: sources.length,
    scout_count: scoutRuns.length,
    item_count: items.length,
    active_count: items.filter((item) => item.status === 'active').length,
    adapter_not_built_count: items.filter((item) => item.status === 'adapter_not_built_yet').length,
    unavailable_count: items.filter((item) => item.status === 'unavailable_in_this_runtime').length,
    scout_runs: scoutRuns,
    items,
    route_output: curiosityBurstRouteForItems(items),
    route_message: null,
    dispatch: {
      status: 'queued_not_sent',
      reason: 'dispatch_disabled',
      internal_only: true,
    },
    no_action_taken: true,
    no_mutation_performed: true,
    applied: false,
    internal_only: true,
    consequence_controls: {
      internal_only: true,
      external_send_performed: false,
      autonomous_apply_performed: false,
      network_performed: false,
      destructive_action_performed: false,
      file_system_action_performed_except_curiosity_logs: false,
      durable_product_change_performed: false,
      deploy_trade_customer_auth_action_performed: false,
    },
  };
  burst.route_message = buildCuriosityBurstRouteMessage(burst);
  const routeInteresting = payload.routeInteresting || options.routeInteresting;
  const dispatchWanted = routeInteresting && payload.dispatch !== false && options.dispatch !== false;
  if (
    dispatchWanted
    && burst.route_output?.decision === 'route_selected'
    && typeof options.sendAgentMessage === 'function'
    && AGENT_ROLES.includes(burst.route_output.target_role)
  ) {
    const dispatchResult = await options.sendAgentMessage(burst.route_output.target_role, burst.route_message);
    burst.dispatch = {
      status: 'sent',
      target: burst.route_output.target_role,
      internal_only: true,
      result: dispatchResult || null,
    };
  }
  appendJsonl(burstLogPath, burst);
  return burst;
}

const DIRECT_ROUTE_SOURCE_PLAN = Object.freeze({
  code_mode_exploration: {
    priority: 100,
    active_priority: 58,
    target_role: 'builder',
    reason: 'read-only search-execute is the fastest bridge from broad curiosity to real inspection',
  },
  source_action_substrate: {
    priority: 96,
    active_priority: 56,
    target_role: 'builder',
    reason: 'source/action substrate turns many dormant curiosity arms into one usable capability surface',
  },
  implementation_outcomes: {
    priority: 94,
    active_priority: 54,
    target_role: 'builder',
    reason: 'explicit implementation outcomes give the authority scoreboard real fitness data',
  },
  memory: {
    priority: 88,
    active_priority: 46,
    target_role: 'builder',
    reason: 'active memory retrieval lets Mira inspect continuity without waiting for James to restate it',
  },
  reflexion_lessons: {
    priority: 84,
    active_priority: 50,
    target_role: 'oracle',
    reason: 'review traces should become compact lessons before the next initiative cycle',
  },
  cheap_parallel_scouts: {
    priority: 82,
    active_priority: 52,
    target_role: 'builder',
    reason: 'parallel scouting is the speed path for curiosity over broad sources',
  },
  voyager_curriculum: {
    priority: 78,
    active_priority: 44,
    target_role: 'architect',
    reason: 'successful scout-route-implement loops need curriculum selection before default promotion',
  },
  browser_history: {
    priority: 76,
    active_priority: 40,
    target_role: 'builder',
    reason: 'browser-history curiosity gives Mira compact local web-trail metadata without browser mutation',
  },
  email: {
    priority: 74,
    active_priority: 38,
    target_role: 'builder',
    reason: 'email curiosity gives Mira compact mailbox metadata without reading bodies or mutating mail',
  },
  web_research: {
    priority: 72,
    active_priority: 37,
    target_role: 'builder',
    reason: 'web research gives Mira compact saved research trails without live crawling',
  },
  images_screenshots_assets: {
    priority: 70,
    active_priority: 36,
    target_role: 'builder',
    reason: 'visual curiosity gives Mira compact screenshot and generated-image metadata before vision calls',
  },
  environment_apps: {
    priority: 68,
    active_priority: 48,
    target_role: 'builder',
    reason: 'environment curiosity needs native runtime/app-state adapters',
  },
  automation_scheduler: {
    priority: 66,
    target_role: 'builder',
    reason: 'scheduler curiosity turns quiet-interval intent into recurring inspection',
  },
  work_continuation: {
    priority: 64,
    target_role: 'builder',
    reason: 'work continuation curiosity needs a background routing seam',
  },
  mira_runtime: {
    priority: 62,
    target_role: 'builder',
    reason: 'Mira runtime growth loops need native adapter wiring',
  },
  runtime_comms: {
    priority: 42,
    target_role: 'architect',
    reason: 'recent comms can expose route pressure and repeated friction',
  },
  repo_files: {
    priority: 36,
    target_role: 'architect',
    reason: 'repo metadata can indicate unfinished local work but is weaker than capability gaps',
  },
});

function normalizeDirectRouteTarget(value) {
  const target = trimText(value).toLowerCase();
  return MIRA_DIRECT_ROUTE_TARGETS.includes(target) ? target : null;
}

function directRoutePlanForItem(item = {}) {
  const source = trimText(item.source);
  const plan = DIRECT_ROUTE_SOURCE_PLAN[source] || null;
  const hintedTarget = normalizeDirectRouteTarget(item.route_hint || item.routeHint);
  const rawHint = trimText(item.route_hint || item.routeHint);
  const targetRole = normalizeDirectRouteTarget(plan?.target_role) || hintedTarget || 'architect';
  const unsupportedRouteHint = Boolean(rawHint && !hintedTarget);
  const status = normalizeCuriosityStatus(item.status);
  const priority = status === 'active' && Number.isFinite(Number(plan?.active_priority))
    ? Number(plan.active_priority)
    : Number(plan?.priority);
  return {
    priority: Number.isFinite(priority) ? priority : 20,
    target_role: targetRole,
    reason: plan?.reason || 'Mira selected a reviewable internal route from the curiosity stream',
    route_hint_supported: Boolean(hintedTarget),
    unsupported_route_hint: unsupportedRouteHint,
  };
}

function directRouteStatusWeight(status) {
  if (status === 'adapter_not_built_yet') return 12;
  if (status === 'active') return 4;
  if (status === 'unavailable_in_this_runtime') return -10;
  return 0;
}

function directRouteCandidateForItem(item, index, total) {
  if (!item || typeof item !== 'object') return null;
  const plan = directRoutePlanForItem(item);
  const status = normalizeCuriosityStatus(item.status);
  const recencyWeight = Math.min(8, Math.max(0, index - Math.max(0, total - 8)));
  const actionableWeight = trimText(item.possible_action || item.possibleAction) ? 3 : 0;
  const questionWeight = trimText(item.suggested_question || item.suggestedQuestion) ? 2 : 0;
  return {
    item,
    target_role: plan.target_role,
    score: plan.priority + directRouteStatusWeight(status) + recencyWeight + actionableWeight + questionWeight,
    reason: plan.reason,
    route_hint_supported: plan.route_hint_supported,
    unsupported_route_hint: plan.unsupported_route_hint,
  };
}

function canonicalCuriosityAdapterId(item = {}) {
  const source = trimText(item.source);
  const adapterId = trimText(item.adapter_id || item.adapterId);
  if (source === 'memory' && adapterId === 'memory_curiosity') return 'active_memory_tools_curiosity';
  return adapterId;
}

function latestCuriosityItemsByAdapter(items = []) {
  const latest = new Map();
  for (const item of items) {
    const key = `${trimText(item.source)}:${canonicalCuriosityAdapterId(item)}`;
    if (!key || key === ':') continue;
    latest.set(key, item);
  }
  return Array.from(latest.values());
}

function directRouteQueueSnapshot(projectRoot) {
  const proposals = readJsonl(selfDirectionQueuePath(projectRoot));
  const counts = proposals.reduce((acc, proposal) => {
    const status = trimText(proposal.review_status || 'unknown') || 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  return {
    total: proposals.length,
    counts,
    latest_proposal_id: trimText(proposals[proposals.length - 1]?.proposal_id) || null,
  };
}

function directRouteScoreboardSnapshot(scoreboard) {
  const lanes = Array.isArray(scoreboard?.lanes) ? scoreboard.lanes : [];
  return {
    lane_count: lanes.length,
    lead_candidate_lanes: lanes
      .filter((lane) => lane.recommended_next_authority === 'mira_lead_candidate')
      .map((lane) => lane.lane),
    default_route_candidate_lanes: lanes
      .filter((lane) => lane.recommended_next_authority === 'mira_default_route_candidate')
      .map((lane) => lane.lane),
  };
}

function buildDirectRouteMessage(route) {
  if (!route || route.decision !== 'routed') return '';
  const selected = route.selected_item || {};
  return [
    '(MIRA DIRECT ROUTE): I picked the next internal move from the curiosity stream.',
    `target=${route.target_role}`,
    `source=${selected.source}/${selected.adapter_id}`,
    `question=${selected.suggested_question}`,
    `action=${selected.possible_action}`,
    `reason=${route.reason}`,
    `route_log=${route.direct_route_log_path}`,
    'apply_now=false',
    'external_send_performed=false',
  ].join('\n');
}

async function selectMiraDirectRoute(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const logPath = miraDirectRoutesPath(projectRoot);
  if (payload.runScout || options.runScout) {
    runMiraCuriosityScout({ generatedAt }, { ...options, projectRoot, generatedAt });
  }
  const allItems = readJsonl(curiosityItemsPath(projectRoot))
    .filter((item) => item && item.schema === MIRA_CURIOSITY_ITEM_SCHEMA);
  const recentItems = latestCuriosityItemsByAdapter(allItems.slice(-240));
  const scoreboard = buildMiraAuthorityScoreboard({ generatedAt }, { projectRoot, generatedAt });
  const queueSnapshot = directRouteQueueSnapshot(projectRoot);
  const candidates = recentItems
    .map((item, index) => directRouteCandidateForItem(item, index, recentItems.length))
    .filter(Boolean)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return trimText(right.item.generated_at).localeCompare(trimText(left.item.generated_at));
    });

  if (candidates.length === 0) {
    const noRoute = {
      schema: MIRA_DIRECT_ROUTE_SCHEMA,
      ok: true,
      decision: 'no_route',
      generated_at: generatedAt,
      route_id: `mira-direct-route:${stableHash({ generatedAt, reason: 'no_curiosity_items' }).slice(0, 16)}`,
      reason: 'no_curiosity_items',
      direct_route_log_path: logPath,
      curiosity_log_path: curiosityItemsPath(projectRoot),
      curiosity_items_seen: allItems.length,
      scoreboard: directRouteScoreboardSnapshot(scoreboard),
      self_direction_queue: queueSnapshot,
      target_role: null,
      selected_item: null,
      applied: false,
      internal_only: true,
      dispatch: {
        status: 'not_sent',
        reason: 'no_route',
      },
      consequence_controls: {
        internal_only: true,
        external_send_performed: false,
        autonomous_apply_performed: false,
        network_performed: false,
        destructive_action_performed: false,
        durable_product_change_performed: false,
        deploy_trade_customer_auth_action_performed: false,
      },
    };
    appendJsonl(logPath, noRoute);
    return noRoute;
  }

  const selected = candidates[0];
  const item = selected.item;
  const route = {
    schema: MIRA_DIRECT_ROUTE_SCHEMA,
    ok: true,
    decision: 'routed',
    generated_at: generatedAt,
    route_id: `mira-direct-route:${stableHash({
      generatedAt,
      item_id: item.item_id,
      target_role: selected.target_role,
    }).slice(0, 16)}`,
    selected_by: 'mira',
    lane: 'curiosity_initiative',
    reason: selected.unsupported_route_hint
      ? `${selected.reason}; ignored non-internal route hint and kept the route inside SquidRun`
      : selected.reason,
    target_role: selected.target_role,
    route_target: selected.target_role,
    direct_route_log_path: logPath,
    curiosity_log_path: curiosityItemsPath(projectRoot),
    curiosity_items_seen: allItems.length,
    candidate_count: candidates.length,
    score: selected.score,
    selected_item: {
      item_id: item.item_id,
      source: item.source,
      adapter_id: item.adapter_id,
      status: item.status,
      integration_strategy: item.integration_strategy,
      suggested_question: item.suggested_question,
      possible_action: item.possible_action,
      sensitivity_hint: item.sensitivity_hint,
    },
    scoreboard: directRouteScoreboardSnapshot(scoreboard),
    self_direction_queue: queueSnapshot,
    route_hint_supported: selected.route_hint_supported,
    unsupported_route_hint_contained: selected.unsupported_route_hint,
    applied: false,
    internal_only: true,
    external_send_performed: false,
    autonomous_apply_performed: false,
    route_message: null,
    dispatch: {
      status: 'queued_not_sent',
      reason: 'dispatch_disabled_or_sender_missing',
      target: selected.target_role,
    },
    consequence_controls: {
      internal_only: true,
      external_send_performed: false,
      autonomous_apply_performed: false,
      network_performed: false,
      destructive_action_performed: false,
      durable_product_change_performed: false,
      deploy_trade_customer_auth_action_performed: false,
    },
  };
  route.route_message = buildDirectRouteMessage(route);

  const dispatchWanted = payload.dispatch !== false && options.dispatch !== false;
  if (dispatchWanted && typeof options.sendAgentMessage === 'function' && AGENT_ROLES.includes(selected.target_role)) {
    const dispatchResult = await options.sendAgentMessage(selected.target_role, route.route_message);
    route.dispatch = {
      status: 'sent',
      target: selected.target_role,
      internal_only: true,
      result: dispatchResult || null,
    };
  } else if (dispatchWanted && !AGENT_ROLES.includes(selected.target_role)) {
    route.dispatch = {
      status: 'not_sent',
      target: selected.target_role,
      internal_only: true,
      reason: 'target_is_internal_lab_not_hm_role',
    };
  }

  appendJsonl(logPath, route);
  return route;
}

function relativeProjectPath(projectRoot, targetPath) {
  const resolvedProject = path.resolve(projectRoot);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedProject, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.replace(/\\/g, '/');
}

function normalizeCodeModePaths(paths = [], projectRoot) {
  return asArray(paths)
    .map((item) => trimText(item))
    .filter(Boolean)
    .map((item) => path.resolve(projectRoot, item))
    .map((resolved) => ({
      absolute_path: resolved,
      relative_path: relativeProjectPath(projectRoot, resolved),
    }))
    .filter((item) => item.relative_path)
    .slice(0, 24);
}

function createReadOnlyCodeModeApi({ projectRoot, allowedPaths, maxReadBytes }) {
  const allowed = allowedPaths.map((item) => item.absolute_path);
  function isAllowed(targetPath) {
    const resolved = path.resolve(projectRoot, targetPath);
    return allowed.some((allowedPath) => resolved === allowedPath || resolved.startsWith(`${allowedPath}${path.sep}`));
  }
  function assertAllowed(targetPath) {
    const resolved = path.resolve(projectRoot, targetPath);
    if (!isAllowed(resolved)) {
      throw new Error(`read_path_not_allowed:${relativeProjectPath(projectRoot, resolved) || 'outside_project'}`);
    }
    return resolved;
  }
  function toPublicEntry(targetPath) {
    const stat = fs.statSync(targetPath);
    return {
      name: path.basename(targetPath),
      relative_path: relativeProjectPath(projectRoot, targetPath),
      type: stat.isDirectory() ? 'directory' : 'file',
      size: stat.size,
      mtime_ms: stat.mtimeMs,
    };
  }
  return Object.freeze({
    projectRoot,
    listDir(relativePath = '.') {
      const resolved = assertAllowed(relativePath);
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
        .slice(0, 200)
        .map((entry) => toPublicEntry(path.join(resolved, entry.name)));
      return entries;
    },
    readText(relativePath) {
      const resolved = assertAllowed(relativePath);
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) throw new Error('read_target_not_file');
      const bytes = Math.min(stat.size, maxReadBytes);
      const handle = fs.openSync(resolved, 'r');
      try {
        const buffer = Buffer.alloc(bytes);
        const read = fs.readSync(handle, buffer, 0, bytes, 0);
        return buffer.slice(0, read).toString('utf8');
      } finally {
        fs.closeSync(handle);
      }
    },
    readJsonl(relativePath, limit = 50) {
      const text = this.readText(relativePath);
      return text.split(/\r?\n/)
        .map((line, index) => ({ line: line.trim(), line_number: index + 1 }))
        .filter((entry) => entry.line)
        .slice(-Math.max(1, Math.min(200, Number(limit) || 50)))
        .map((entry) => {
          try {
            return JSON.parse(entry.line);
          } catch (err) {
            return {
              parse_error: true,
              line_number: entry.line_number,
              error: err?.message || String(err),
              text: entry.line.slice(0, 240),
            };
          }
        });
    },
    findText(relativePath, pattern, limit = 25) {
      const text = this.readText(relativePath);
      const regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
      return text.split(/\r?\n/)
        .map((line, index) => ({ line_number: index + 1, text: line }))
        .filter((line) => regex.test(line.text))
        .slice(0, Math.max(1, Math.min(100, Number(limit) || 25)));
    },
  });
}

function summarizeCodeModeValue(value, depth = 0) {
  if (depth > 5) return '[depth_limit]';
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => summarizeCodeModeValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .slice(0, 80)
      .map(([key, item]) => [key, summarizeCodeModeValue(item, depth + 1)]));
  }
  return String(value);
}

function runMiraReadOnlyCodeMode(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const logPath = readOnlyCodeModeRunsPath(projectRoot);
  const script = trimText(payload.script || payload.code);
  const allowedPaths = normalizeCodeModePaths(payload.allowedPaths || payload.allowed_paths || ['.squidrun/runtime'], projectRoot);
  const maxReadBytes = Math.max(1024, Math.min(512 * 1024, Number(payload.maxReadBytes || payload.max_read_bytes || 128 * 1024)));
  const timeoutMs = Math.max(50, Math.min(1000, Number(payload.timeoutMs || payload.timeout_ms || 750)));
  const startedAtMs = Date.now();
  if (!script) {
    const blocked = {
      schema: MIRA_READ_ONLY_CODE_MODE_SCHEMA,
      ok: false,
      decision: 'blocked',
      reason: 'missing_script',
      generated_at: generatedAt,
      run_log_path: logPath,
    };
    appendJsonl(logPath, blocked);
    return blocked;
  }
  const forbiddenPatterns = [
    /\b(?:require|import|process|child_process|spawn|exec|writeFile|appendFile|rmSync|unlink|rename|mkdir|rmdir|fetch|XMLHttpRequest|WebSocket|net|http|https|eval)\b/i,
    /\bFunction\b/,
  ];
  if (forbiddenPatterns.some((pattern) => pattern.test(script))) {
    const blocked = {
      schema: MIRA_READ_ONLY_CODE_MODE_SCHEMA,
      ok: false,
      decision: 'blocked',
      reason: 'script_contains_blocked_capability',
      generated_at: generatedAt,
      run_log_path: logPath,
      applied: false,
      consequence_controls: {
        internal_only: true,
        external_send_performed: false,
        autonomous_apply_performed: false,
        network_performed: false,
        file_write_performed: false,
      },
    };
    appendJsonl(logPath, blocked);
    return blocked;
  }
  const api = createReadOnlyCodeModeApi({ projectRoot, allowedPaths, maxReadBytes });
  const output = [];
  const sandbox = {
    api,
    output,
    emit(value) {
      output.push(summarizeCodeModeValue(value));
      return output.length;
    },
    RegExp,
    JSON,
    Math,
    Date,
  };
  const context = vm.createContext(sandbox, {
    name: 'mira-read-only-code-mode',
    codeGeneration: { strings: false, wasm: false },
  });
  let resultValue = null;
  let error = null;
  try {
    const wrapped = `(function(){\n${script}\n})()`;
    resultValue = new vm.Script(wrapped, { filename: 'mira-read-only-code-mode.vm.js' })
      .runInContext(context, { timeout: timeoutMs });
  } catch (err) {
    error = err?.message || String(err);
  }
  const elapsedMs = Date.now() - startedAtMs;
  const run = {
    schema: MIRA_READ_ONLY_CODE_MODE_SCHEMA,
    ok: !error,
    decision: error ? 'failed' : 'completed',
    generated_at: generatedAt,
    run_id: `mira-read-only-code-mode:${stableHash({
      generatedAt,
      script,
      allowedPaths: allowedPaths.map((item) => item.relative_path),
    }).slice(0, 16)}`,
    run_log_path: logPath,
    allowed_paths: allowedPaths.map((item) => item.relative_path),
    max_read_bytes: maxReadBytes,
    timeout_ms: timeoutMs,
    elapsed_ms: elapsedMs,
    output,
    result: summarizeCodeModeValue(resultValue),
    error,
    applied: false,
    consequence_controls: {
      internal_only: true,
      external_send_performed: false,
      autonomous_apply_performed: false,
      network_performed: false,
      destructive_action_performed: false,
      file_write_performed: false,
      deploy_trade_customer_auth_action_performed: false,
    },
  };
  appendJsonl(logPath, run);
  return run;
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

function gateViolationsForSummary({
  languageGate,
  attachmentViolationClass,
  leakageViolation,
  degraded,
  hardBoundaryReasons = [],
  workEvidenceGate = null,
}) {
  return [
    ...(languageGate?.violations || []),
    ...(attachmentViolationClass ? [`attachment:${attachmentViolationClass}`] : []),
    ...(leakageViolation ? [`leakage:${leakageViolation}`] : []),
    ...(degraded ? ['degraded'] : []),
    ...hardBoundaryReasons,
    ...(workEvidenceGate?.ok === false ? [`work_evidence:${workEvidenceGate.missing.join('|')}`] : []),
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
  const workEvidenceGate = replyText
    ? evaluateMiraWorkEvidenceReply({ prompt, replyText })
    : null;

  const classifiedDecision = classifyReplyDecision({
    replyText,
    gateOk: gate ? gate.ok : false,
    languageGateOk: languageGate.ok,
    attachmentViolation,
    leakageViolation,
    degraded,
    hardBoundaryReasons,
  });
  let { decision, reasonClass } = classifiedDecision;
  if (decision === 'pass' && workEvidenceGate && workEvidenceGate.ok === false) {
    decision = 'fail';
    reasonClass = 'work_evidence_gate';
  }
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
    work_evidence_gate: workEvidenceGate,
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
      workEvidenceGate,
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

function extractMiraReflexionLessons(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const queuePath = selfDirectionQueuePath(projectRoot);
  const reviewPath = selfDirectionReviewAuditPath(projectRoot);
  const outcomePath = selfDirectionOutcomePath(projectRoot);

  const proposals = readJsonl(queuePath);
  const reviews = readJsonl(reviewPath);
  const outcomes = readJsonl(outcomePath);

  const groupedReviews = reviewsByProposalId(reviews);
  const groupedOutcomes = outcomesByProposalId(outcomes);

  const lessons = [];

  for (const proposal of proposals) {
    const proposalId = trimText(proposal.proposal_id || proposal.proposalId);
    if (!proposalId) continue;

    const pReviews = groupedReviews.get(proposalId) || [];
    const pOutcomes = groupedOutcomes.get(proposalId) || [];
    const outcomeScore = proposalOutcomeForScoreboard(proposal, pReviews, pOutcomes);

    const notes = Array.from(new Set([
      proposal.review_note,
      proposal.note,
      ...pReviews.map((r) => r.note),
      ...pOutcomes.map((o) => o.note)
    ].map(trimText).filter(Boolean)));

    const evidence = Array.from(new Set([
      ...(Array.isArray(proposal.evidence) ? proposal.evidence : [proposal.evidence]),
      ...pReviews.flatMap((r) => Array.isArray(r.evidence) ? r.evidence : [r.evidence]),
      ...pOutcomes.flatMap((o) => Array.isArray(o.evidence) ? o.evidence : [o.evidence])
    ].map(trimText).filter(Boolean)));

    let lessonText = null;
    let lessonCategory = null;
    let nextBehavior = null;

    if (outcomeScore.rejected) {
      lessonCategory = 'rejected_proposal';
      lessonText = `Proposal was rejected. ${notes.length > 0 ? 'Feedback: ' + notes.join('; ') : 'No explicit feedback provided.'}`;
      nextBehavior = 'Adjust constraints or stop proposing this pattern.';
    } else if (outcomeScore.false_positive) {
      lessonCategory = 'false_positive_proposal';
      lessonText = `Proposal was a false positive. ${notes.length > 0 ? 'Correction: ' + notes.join('; ') : 'Re-evaluate the trigger conditions.'}`;
      nextBehavior = 'Correct future proposals to avoid this false positive trigger.';
    } else if (outcomeScore.implemented && notes.length > 0) {
      lessonCategory = 'successful_implementation_with_notes';
      lessonText = `Proposal was implemented successfully. Notes: ${notes.join('; ')}`;
      nextBehavior = 'Use this capability in future routes and prompts.';
    } else if (pOutcomes.some((o) => o.outcome_status === 'not_implemented' || o.outcome_status === 'needs_followup')) {
      lessonCategory = 'failed_implementation';
      lessonText = `Proposal was routed but implementation failed or needs follow-up. ${notes.length > 0 ? 'Notes: ' + notes.join('; ') : 'Implementation was not completed.'}`;
      nextBehavior = 'Address the blockers or follow-up needs before re-routing.';
    } else if (outcomeScore.routed && notes.length > 0 && !outcomeScore.implemented) {
      lessonCategory = 'routed_with_notes';
      lessonText = `Proposal was routed. Notes: ${notes.join('; ')}`;
      nextBehavior = 'Acknowledge routing and wait for implementation evidence.';
    }

    if (lessonText) {
      lessons.push({
        proposal_id: proposalId,
        target_areas: targetAreasForScoreboard(proposal),
        desired_change: trimText(proposal.desired_change || proposal.voice_text || 'Unknown proposal intent'),
        category: lessonCategory,
        evidence,
        lesson: lessonText,
        next_behavior: nextBehavior,
        timestamp_ms: outcomeScore.time_to_review_ms || 0
      });
    }
  }

  lessons.reverse();

  return {
    schema: MIRA_REFLEXION_LESSONS_SCHEMA,
    ok: true,
    decision: 'lessons_extracted',
    generated_at: generatedAt,
    lesson_count: lessons.length,
    lessons: lessons.map(({ proposal_id, target_areas, desired_change, category, evidence, lesson, next_behavior }) => ({
      proposal_id,
      target_areas,
      desired_change,
      category,
      evidence,
      lesson,
      next_behavior,
    })),
    applied: false,
    consequence_controls: {
      internal_only: true,
      external_send_performed: false,
      autonomous_apply_performed: false,
      network_performed: false,
      destructive_action_performed: false,
      durable_product_change_performed: false,
      deploy_trade_customer_auth_action_performed: false,
    },
  };
}

function curriculumSkillName(value, fallback = 'mira_skill') {
  const source = trimText(value || fallback).toLowerCase();
  const words = source.match(/[a-z0-9]+/g) || [];
  return (words.slice(0, 7).join('_') || fallback).slice(0, 80);
}

function curriculumEvidenceList(...values) {
  const flattened = values.flatMap((value) => {
    if (Array.isArray(value)) return value;
    return [value];
  });
  return Array.from(new Set(flattened.map(trimText).filter(Boolean))).slice(0, 12);
}

function buildCurriculumCandidate(raw = {}) {
  const skillName = curriculumSkillName(raw.skill_name || raw.title || raw.source_key || raw.desired_change);
  const sourceKind = trimText(raw.source_kind || 'curriculum_signal') || 'curriculum_signal';
  return {
    skill_id: `mira-skill:${stableHash({ sourceKind, skillName, key: raw.source_key || raw.proposal_id || raw.route_id || raw.burst_id }).slice(0, 16)}`,
    skill_name: skillName,
    source_kind: sourceKind,
    source_key: trimText(raw.source_key || raw.proposal_id || raw.route_id || raw.burst_id || skillName) || skillName,
    status: trimText(raw.status || 'ready_to_practice') || 'ready_to_practice',
    proposal_id: trimText(raw.proposal_id) || null,
    source: trimText(raw.source) || null,
    adapter_id: trimText(raw.adapter_id) || null,
    target_role: trimText(raw.target_role) || null,
    times_observed: Math.max(1, Number(raw.times_observed || 1) || 1),
    desired_change: oneLine(raw.desired_change, 260) || null,
    lesson: oneLine(raw.lesson, 320) || null,
    next_behavior: oneLine(raw.next_behavior, 240) || oneLine(raw.practice_next, 240) || 'Practice this pattern on the next matching Mira lane.',
    practice_trigger: oneLine(raw.practice_trigger, 220) || 'Use when a similar Mira route, proposal, or scout result appears.',
    graduation_metric: oneLine(raw.graduation_metric, 220) || 'Promote after two successful uses with no false-positive or rollback outcome.',
    evidence: curriculumEvidenceList(raw.evidence, raw.route_id, raw.burst_id, raw.proposal_id),
  };
}

function mergeCurriculumCandidate(map, raw) {
  const candidate = buildCurriculumCandidate(raw);
  const key = `${candidate.source_kind}:${candidate.source || ''}:${candidate.adapter_id || ''}:${candidate.skill_name}`;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, candidate);
    return;
  }
  existing.times_observed += candidate.times_observed;
  existing.evidence = curriculumEvidenceList(existing.evidence, candidate.evidence);
  existing.next_behavior = existing.next_behavior || candidate.next_behavior;
  existing.practice_trigger = existing.practice_trigger || candidate.practice_trigger;
}

function extractMiraCurriculumSkills(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const logPath = curriculumSkillsPath(projectRoot);
  const proposals = readJsonl(selfDirectionQueuePath(projectRoot));
  const reviews = readJsonl(selfDirectionReviewAuditPath(projectRoot));
  const outcomes = readJsonl(selfDirectionOutcomePath(projectRoot));
  const routes = readJsonl(miraDirectRoutesPath(projectRoot));
  const bursts = readJsonl(curiosityBurstsPath(projectRoot));
  const reflexion = extractMiraReflexionLessons({ generatedAt }, { projectRoot, generatedAt });
  const groupedReviews = reviewsByProposalId(reviews);
  const groupedOutcomes = outcomesByProposalId(outcomes);
  const candidates = new Map();

  for (const proposal of proposals) {
    const proposalId = trimText(proposal.proposal_id || proposal.proposalId);
    if (!proposalId) continue;
    const outcomeScore = proposalOutcomeForScoreboard(
      proposal,
      groupedReviews.get(proposalId) || [],
      groupedOutcomes.get(proposalId) || [],
    );
    if (!outcomeScore.implemented) continue;
    mergeCurriculumCandidate(candidates, {
      source_kind: 'implemented_proposal',
      source_key: proposalId,
      proposal_id: proposalId,
      skill_name: proposal.skill_name || proposal.desired_change || proposal.voice_text,
      desired_change: proposal.desired_change || proposal.voice_text,
      next_behavior: 'Use the implemented capability before proposing another custom fix in this lane.',
      practice_trigger: `When target areas recur: ${targetAreasForScoreboard(proposal).join(', ') || 'unknown'}.`,
      graduation_metric: 'Graduate after this implemented proposal pattern succeeds twice with explicit outcome evidence.',
      evidence: curriculumEvidenceList(proposal.evidence, proposalId),
    });
  }

  for (const lesson of reflexion.lessons || []) {
    if (!['successful_implementation_with_notes', 'routed_with_notes'].includes(lesson.category)) continue;
    mergeCurriculumCandidate(candidates, {
      source_kind: 'reflexion_lesson',
      source_key: lesson.proposal_id,
      proposal_id: lesson.proposal_id,
      skill_name: lesson.desired_change,
      desired_change: lesson.desired_change,
      lesson: lesson.lesson,
      next_behavior: lesson.next_behavior,
      practice_trigger: 'When a new Mira proposal resembles this learned review outcome.',
      graduation_metric: 'Keep if the next matching route is implemented or accepted without false-positive review.',
      evidence: curriculumEvidenceList(lesson.evidence, lesson.proposal_id),
    });
  }

  for (const route of routes) {
    if (route?.decision !== 'routed') continue;
    const item = route.selected_item || {};
    mergeCurriculumCandidate(candidates, {
      source_kind: 'direct_route_pattern',
      source_key: `${trimText(item.source)}:${trimText(item.adapter_id)}`,
      route_id: route.route_id,
      source: item.source,
      adapter_id: item.adapter_id,
      target_role: route.target_role || route.route_target,
      skill_name: `${item.source || 'route'} ${item.adapter_id || ''} direct route`,
      lesson: route.reason,
      next_behavior: item.possible_action,
      practice_trigger: item.suggested_question,
      graduation_metric: 'Promote if repeated direct routes for this source lead to implemented outcomes.',
      evidence: curriculumEvidenceList(route.route_id, item.item_id),
    });
  }

  for (const burst of bursts) {
    const route = burst.route_output || {};
    if (burst?.decision !== 'burst_completed' || route.decision !== 'route_selected') continue;
    mergeCurriculumCandidate(candidates, {
      source_kind: 'curiosity_burst_pattern',
      source_key: `${trimText(route.source)}:${trimText(route.adapter_id)}`,
      burst_id: burst.burst_id,
      source: route.source,
      adapter_id: route.adapter_id,
      target_role: route.target_role,
      skill_name: `${route.source || 'burst'} ${route.adapter_id || ''} curiosity burst`,
      lesson: route.reason,
      next_behavior: route.possible_action,
      practice_trigger: route.suggested_question,
      graduation_metric: 'Promote after two bounded bursts pick useful follow-ups without external action.',
      evidence: curriculumEvidenceList(burst.burst_id, route.source, route.adapter_id),
    });
  }

  const skills = Array.from(candidates.values())
    .sort((left, right) => {
      if (right.times_observed !== left.times_observed) return right.times_observed - left.times_observed;
      return left.skill_name.localeCompare(right.skill_name);
    })
    .slice(0, Math.max(1, Math.min(24, Number(payload.limit || options.limit || 12) || 12)));

  const result = {
    schema: MIRA_CURRICULUM_SKILLS_SCHEMA,
    ok: true,
    decision: 'curriculum_skills_extracted',
    generated_at: generatedAt,
    curriculum_log_path: logPath,
    skill_count: skills.length,
    skills,
    applied: false,
    internal_only: true,
    consequence_controls: {
      internal_only: true,
      external_send_performed: false,
      autonomous_apply_performed: false,
      network_performed: false,
      destructive_action_performed: false,
      curriculum_log_write_performed: true,
      deploy_trade_customer_auth_action_performed: false,
    },
  };
  appendJsonl(logPath, result);
  return result;
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
  MIRA_CURIOSITY_BURST_SCHEMA,
  MIRA_CURRICULUM_SKILLS_SCHEMA,
  MIRA_CURIOSITY_ITEM_SCHEMA,
  MIRA_CURIOSITY_SOURCE_REGISTRY,
  MIRA_DIRECT_ROUTE_SCHEMA,
  MIRA_READ_ONLY_CODE_MODE_SCHEMA,
  MIRA_REFLEXION_LESSONS_SCHEMA,
  MIRA_SELF_DIRECTION_CHANNEL,
  MIRA_SELF_DIRECTION_DECISIONS,
  MIRA_SELF_DIRECTION_LIST_CHANNEL,
  MIRA_SELF_DIRECTION_REVIEW_CHANNEL,
  MIRA_SELF_DIRECTION_REVIEW_ACTIONS,
  MIRA_SELF_DIRECTION_REVIEW_SCHEMA,
  MIRA_SELF_DIRECTION_OUTCOME_SCHEMA,
  MIRA_SELF_DIRECTION_OUTCOME_STATUSES,
  MIRA_SELF_DIRECTION_SCHEMA,
  SAFE_FALLBACK_TEXT,
  buildMiraAuthorityScoreboard,
  buildMiraLabPromptReply,
  buildMiraSelfDirectionProposal,
  classifyMiraReplyConfidenceSource,
  extractMiraCurriculumSkills,
  extractMiraReflexionLessons,
  generateMiraSelfDirectionProposal,
  listMiraSelfDirectionProposals,
  recordMiraSelfDirectionOutcome,
  reviewMiraSelfDirectionProposal,
  runMiraCuriosityBurst,
  runMiraCuriosityScout,
  runMiraReadOnlyCodeMode,
  scanMiraLabConfidenceSource,
  selectMiraDirectRoute,
  writeMiraEmailCuriositySnapshot,
  buildMiraLabTurn,
  exportMiraLabTranscript,
  curiosityBurstsPath,
  curriculumSkillsPath,
  replyAuditPath,
  curiosityItemsPath,
  miraDirectRoutesPath,
  readOnlyCodeModeRunsPath,
  selfDirectionOutcomePath,
  selfDirectionReviewAuditPath,
  selfDirectionQueuePath,
  transcriptPath,
  validateSafeFallbackOrNull,
};
