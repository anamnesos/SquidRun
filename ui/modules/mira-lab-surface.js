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
const {
  readMiraAutomationSchedulerCuriosity,
  defaultSchedulerStatePaths,
} = require('./mira-automation-scheduler-curiosity');
const {
  readMiraWorkContinuationCuriosity,
} = require('./mira-work-continuation-curiosity');
const {
  readMiraRuntimeCuriosity,
} = require('./mira-runtime-curiosity');
const {
  readMiraCalendarMessageCuriosity,
} = require('./mira-calendar-message-curiosity');

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
const MIRA_ACTIVE_INITIATIVE_SCHEMA = 'squidrun.mira_lab.active_initiative_v0';
const MIRA_ACTIVE_INITIATIVE_OUTCOME_SCHEMA = 'squidrun.mira_lab.active_initiative_outcome_v0';
const MIRA_READ_ONLY_CODE_MODE_SCHEMA = 'squidrun.mira_lab.read_only_code_mode_v0';
const MIRA_QUIET_CURIOSITY_SCHEDULE_SCHEMA = 'squidrun.mira_lab.quiet_curiosity_schedule_v0';
const AGENT_ROLES = Object.freeze(['architect', 'builder', 'oracle']);
const SPEAKER_ROLES = Object.freeze(['james', 'mira', ...AGENT_ROLES]);
const REQUESTER_PANES = Object.freeze(['architect', 'builder', 'oracle', 'james']);
const MIRA_DIRECT_ROUTE_TARGETS = Object.freeze(['architect', 'builder', 'oracle', 'mira_lab']);
const MIRA_LAB_PROMPT_REPLY_DECISIONS = Object.freeze(['pass', 'fail', 'blocked']);
const MIRA_SELF_DIRECTION_DECISIONS = Object.freeze(['staged', 'rejected', 'blocked']);
const MIRA_SELF_DIRECTION_REVIEW_ACTIONS = Object.freeze(['accepted', 'rejected', 'routed']);
const MIRA_SELF_DIRECTION_OUTCOME_STATUSES = Object.freeze(['implemented', 'not_implemented', 'false_positive', 'needs_followup']);
const MIRA_ACTIVE_INITIATIVE_OUTCOME_STATUSES = MIRA_SELF_DIRECTION_OUTCOME_STATUSES;
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
  'hostile_compliance_smoothing',
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
  { source: 'memory_broker', scope: 'hybrid_memory_recall', adapter_id: 'unified_memory_broker_curiosity', default_status: 'active', integration_strategy: 'existing_seam', existing_seam: 'ui/modules/memory-broker.js RRF recall + ui/scripts/hm-memory-broker.js recall + deliverHumanMessageWithRecall' },
  { source: 'browser_history', scope: 'local_browser_history', adapter_id: 'browser_history_curiosity', default_status: 'active', integration_strategy: 'native_adapter', existing_seam: 'ui/modules/mira-browser-history-curiosity.js compact read-only Chromium History DB metadata via temp-copy' },
  { source: 'email', scope: 'local_email', adapter_id: 'email_curiosity', default_status: 'active', integration_strategy: 'native_adapter', existing_seam: 'ui/modules/mira-email-curiosity.js compact read-only Gmail/connector metadata snapshot' },
  { source: 'web_research', scope: 'websites_and_research_trails', adapter_id: 'web_research_curiosity', default_status: 'active', integration_strategy: 'native_adapter', existing_seam: 'ui/modules/mira-web-research-curiosity.js compact read-only local research artifact inventory plus safe URLs/domains' },
  { source: 'images_screenshots_assets', scope: 'local_visual_context', adapter_id: 'visual_asset_curiosity', default_status: 'active', integration_strategy: 'native_adapter', existing_seam: 'ui/modules/mira-visual-asset-curiosity.js compact screenshot/generated-image inventory' },
  { source: 'calendar_messages', scope: 'calendar_and_message_context', adapter_id: 'calendar_message_curiosity', default_status: 'active', integration_strategy: 'mcp_candidate', existing_seam: 'ui/modules/mira-calendar-message-curiosity.js plus ui/scripts/hm-comms.js compact local calendar/message metadata before future calendar/message connectors' },
  { source: 'environment_apps', scope: 'local_environment_and_app_state', adapter_id: 'environment_app_curiosity', default_status: 'active', integration_strategy: 'existing_seam', existing_seam: 'ui/modules/mira-environment-curiosity.js read-only startup/app health, bridge-client.js, mcp-bridge.js, websocket runtime/server, cross-device-target.js, ui/scripts/hm-health-snapshot.js' },
  { source: 'automation_scheduler', scope: 'local_automation_and_scheduler', adapter_id: 'automation_scheduler_curiosity', default_status: 'active', integration_strategy: 'existing_seam', existing_seam: 'ui/modules/mira-automation-scheduler-curiosity.js compact read-only schedules.json metadata, ui/modules/scheduler.js + ui/modules/ipc/scheduler-handlers.js' },
  { source: 'work_continuation', scope: 'background_work_and_routing', adapter_id: 'work_continuation_curiosity', default_status: 'active', integration_strategy: 'existing_seam', existing_seam: 'ui/modules/mira-work-continuation-curiosity.js compact read-only owned-work queue and continuation-card metadata' },
  { source: 'mira_runtime', scope: 'mira_internal_growth_runtime', adapter_id: 'mira_runtime_curiosity', default_status: 'active', integration_strategy: 'native_adapter', existing_seam: 'ui/modules/mira-runtime-curiosity.js compact runtime health over growth/autonomy/experience/perception/intent modules' },
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

function activeInitiativesPath(projectRoot) {
  return path.join(projectRoot, '.squidrun', 'runtime', 'mira-active-initiatives.jsonl');
}

function activeInitiativeOutcomesPath(projectRoot) {
  return path.join(projectRoot, '.squidrun', 'runtime', 'mira-active-initiative-outcomes.jsonl');
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

function compactMemoryBrokerTopResult(value) {
  if (!value || typeof value !== 'object') return null;
  const rank = Number(value.rank);
  const score = Number(value.score);
  const contributors = asArray(value.contributors)
    .map((entry) => ({
      source: trimText(entry?.source) || null,
      sourceKind: trimText(entry?.sourceKind || entry?.source_kind) || null,
      rank: Number.isFinite(Number(entry?.rank)) ? Number(entry.rank) : null,
    }))
    .filter((entry) => entry.source || entry.sourceKind)
    .slice(0, 5);
  return {
    rank: Number.isFinite(rank) ? rank : null,
    score: Number.isFinite(score) ? Number(score.toFixed(6)) : null,
    sourceKind: trimText(value.sourceKind || value.source_kind) || null,
    source: trimText(value.source) || null,
    id: trimText(value.id) || null,
    ref: oneLine(value.ref, 160) || null,
    title: oneLine(value.title, 140) || null,
    excerpt: oneLine(value.excerpt, 240) || null,
    contributors,
  };
}

function compactMemoryBrokerSources(value) {
  return asArray(value)
    .map((entry) => ({
      source: trimText(entry?.source) || null,
      sourceKind: trimText(entry?.sourceKind || entry?.source_kind) || null,
      ok: entry?.ok !== false,
      reason: trimText(entry?.reason) || null,
      itemCount: Number.isFinite(Number(entry?.itemCount ?? entry?.item_count))
        ? Number(entry.itemCount ?? entry.item_count)
        : 0,
      elapsedMs: Number.isFinite(Number(entry?.elapsedMs ?? entry?.elapsed_ms))
        ? Number(entry.elapsedMs ?? entry.elapsed_ms)
        : null,
    }))
    .filter((entry) => entry.source || entry.sourceKind)
    .slice(0, 8);
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

function compactEmailPressureBuckets(value) {
  return asArray(value)
    .map((entry) => ({
      bucket: trimText(entry?.bucket) || null,
      label_id: trimText(entry?.label_id || entry?.labelId) || null,
      label_name: trimText(entry?.label_name || entry?.labelName) || null,
      messages_unread: Number.isFinite(Number(entry?.messages_unread ?? entry?.messagesUnread))
        ? Number(entry.messages_unread ?? entry.messagesUnread)
        : null,
      threads_unread: Number.isFinite(Number(entry?.threads_unread ?? entry?.threadsUnread))
        ? Number(entry.threads_unread ?? entry.threadsUnread)
        : null,
      pressure_score: Number.isFinite(Number(entry?.pressure_score ?? entry?.pressureScore))
        ? Number(entry.pressure_score ?? entry.pressureScore)
        : null,
    }))
    .filter((entry) => entry.bucket)
    .slice(0, 8);
}

function compactEmailSnapshotGaps(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    recent_message_count: Number.isFinite(Number(value.recent_message_count ?? value.recentMessageCount))
      ? Number(value.recent_message_count ?? value.recentMessageCount)
      : 0,
    missing_sender_domain_count: Number.isFinite(Number(value.missing_sender_domain_count ?? value.missingSenderDomainCount))
      ? Number(value.missing_sender_domain_count ?? value.missingSenderDomainCount)
      : 0,
    missing_subject_count: Number.isFinite(Number(value.missing_subject_count ?? value.missingSubjectCount))
      ? Number(value.missing_subject_count ?? value.missingSubjectCount)
      : 0,
    missing_timestamp_count: Number.isFinite(Number(value.missing_timestamp_count ?? value.missingTimestampCount))
      ? Number(value.missing_timestamp_count ?? value.missingTimestampCount)
      : 0,
    missing_label_ids_count: Number.isFinite(Number(value.missing_label_ids_count ?? value.missingLabelIdsCount))
      ? Number(value.missing_label_ids_count ?? value.missingLabelIdsCount)
      : 0,
    thread_poor_snapshot: value.thread_poor_snapshot === true || value.threadPoorSnapshot === true,
  };
}

function compactEmailSuggestedSnapshotQueries(value) {
  return asArray(value)
    .map((entry) => ({
      query: oneLine(entry?.query, 180) || null,
      purpose: oneLine(entry?.purpose, 180) || null,
      requested_metadata: asArray(entry?.requested_metadata || entry?.requestedMetadata).map(trimText).filter(Boolean).slice(0, 8),
      metadata_only: entry?.metadata_only !== false,
      body_read_required: entry?.body_read_required === true,
      send_or_modify_required: entry?.send_or_modify_required === true,
    }))
    .filter((entry) => entry.query)
    .slice(0, 5);
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

function safeWebUrlForOutput(value) {
  try {
    const parsed = new URL(String(value));
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return null;
  }
}

function stripWebUrlDetails(value) {
  return String(value || '').replace(/https?:\/\/[^\s<>)"'`]+/g, (url) => safeWebUrlForOutput(url) || '[url]');
}

function compactWebResearchTopArtifact(value) {
  if (!value || typeof value !== 'object') return null;
  const title = oneLine(value.title || value.heading, 120);
  const artifactPath = oneLine(value.path || value.sourcePath || value.source_path, 180);
  const sourceBucket = oneLine(value.source_bucket || value.sourceBucket || value.bucket, 80);
  const excerpt = oneLine(stripWebUrlDetails(value.excerpt || value.contentExcerpt || value.summary), 220);
  const safeUrls = asArray(value.safe_urls || value.safeUrls || value.urls)
    .map(safeWebUrlForOutput)
    .filter(Boolean)
    .slice(0, 4);
  const domains = asArray(value.domains || value.domain || value.hosts)
    .map((domain) => trimText(domain).replace(/^www\./i, '').toLowerCase())
    .filter((domain) => domain && /^[a-z0-9.-]+$/i.test(domain))
    .slice(0, 8);
  if (!title && !artifactPath && !excerpt && domains.length === 0 && safeUrls.length === 0) return null;
  return {
    title: title || null,
    path: artifactPath || null,
    source_bucket: sourceBucket || null,
    excerpt: excerpt || null,
    domains,
    safe_urls: safeUrls,
  };
}

function compactVisualAssetBuckets(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value)
    .map(([key, count]) => [trimText(key), Number(count)])
    .filter(([key, count]) => key && Number.isFinite(count))
    .slice(0, 8));
}

function compactVisualAssetFollowup(value) {
  if (!value || typeof value !== 'object') return null;
  const rawWidth = value.width;
  const rawHeight = value.height;
  const rawSize = value.size_bytes ?? value.sizeBytes;
  const numericWidth = rawWidth === null || rawWidth === undefined ? NaN : Number(rawWidth);
  const numericHeight = rawHeight === null || rawHeight === undefined ? NaN : Number(rawHeight);
  const numericSize = rawSize === null || rawSize === undefined ? NaN : Number(rawSize);
  const step = value.visual_understanding_step || value.visualUnderstandingStep || {};
  const followup = {
    path: oneLine(value.path || value.sourcePath || value.source_path, 180) || null,
    name: oneLine(value.name, 100) || null,
    source_bucket: oneLine(value.source_bucket || value.sourceBucket || value.bucket, 80) || null,
    ext: oneLine(value.ext, 24) || null,
    size_bytes: Number.isFinite(numericSize) ? numericSize : null,
    width: Number.isFinite(numericWidth) ? numericWidth : null,
    height: Number.isFinite(numericHeight) ? numericHeight : null,
    aspect_hint: oneLine(value.aspect_hint || value.aspectHint, 80) || null,
    suggested_question: oneLine(value.suggested_question || value.suggestedQuestion, 240) || null,
    possible_action: oneLine(value.possible_action || value.possibleAction, 260) || null,
    visual_understanding_step: {
      status: oneLine(step.status, 100) || null,
      image_ocr_performed: step.image_ocr_performed === true || step.imageOcrPerformed === true,
      image_model_performed: step.image_model_performed === true || step.imageModelPerformed === true,
      file_write_performed: step.file_write_performed === true || step.fileWritePerformed === true,
      external_send_performed: step.external_send_performed === true || step.externalSendPerformed === true,
    },
  };
  if (!followup.path && !followup.suggested_question && !followup.possible_action) return null;
  return followup;
}

function compactSchedulerTypeCounts(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value)
    .map(([key, count]) => [trimText(key), Number(count)])
    .filter(([key, count]) => key && Number.isFinite(count))
    .slice(0, 8));
}

function compactSchedulerFollowthroughDesign(value) {
  if (!value || typeof value !== 'object') return null;
  const candidateSources = asArray(value.candidate_sources || value.candidateSources)
    .map(trimText)
    .filter((source) => CURIOSITY_BURST_DEFAULT_SOURCES.includes(source))
    .slice(0, 13);
  return {
    proposal_kind: trimText(value.proposal_kind || value.proposalKind) || 'reviewed_recurring_curiosity_burst',
    cadence: trimText(value.cadence) || 'quiet_interval',
    review_owner: trimText(value.review_owner || value.reviewOwner) || 'architect',
    review_required_before_schedule_creation: value.review_required_before_schedule_creation !== false,
    candidate_sources: candidateSources,
    command_harness: oneLine(value.command_harness || value.commandHarness, 260) || null,
    followup_code_mode_practice_step: oneLine(value.followup_code_mode_practice_step || value.followupCodeModePracticeStep, 220) || null,
    schedule_count: numberSignal(value.schedule_count ?? value.scheduleCount),
    active_count: numberSignal(value.active_count ?? value.activeCount),
    due_soon_count: numberSignal(value.due_soon_count ?? value.dueSoonCount),
    overdue_count: numberSignal(value.overdue_count ?? value.overdueCount),
    schedule_created: value.schedule_created === true,
    schedule_updated: value.schedule_updated === true,
    schedule_deleted: value.schedule_deleted === true,
    schedule_run_performed: value.schedule_run_performed === true,
  };
}

function compactParallelScoutPlan(value) {
  if (!value || typeof value !== 'object') return null;
  const candidateSources = asArray(value.candidate_sources || value.candidateSources)
    .map(trimText)
    .filter((source) => CURIOSITY_BURST_DEFAULT_SOURCES.includes(source) && source !== 'cheap_parallel_scouts')
    .slice(0, 8);
  if (candidateSources.length === 0) return null;
  return {
    plan_kind: trimText(value.plan_kind || value.planKind) || 'reviewed_parallel_curiosity_burst',
    cadence: trimText(value.cadence) || 'quiet_interval',
    candidate_sources: candidateSources,
    max_sources: Number.isFinite(Number(value.max_sources ?? value.maxSources))
      ? Number(value.max_sources ?? value.maxSources)
      : candidateSources.length,
    command_harness: oneLine(value.command_harness || value.commandHarness, 280) || null,
    followup_rule: oneLine(value.followup_rule || value.followupRule, 240) || null,
    route_strongest_internal_followup: value.route_strongest_internal_followup !== false,
    dispatch_performed: value.dispatch_performed === true,
    schedule_created: value.schedule_created === true,
    schedule_run_performed: value.schedule_run_performed === true,
    external_send_performed: value.external_send_performed === true,
  };
}

function compactEnvironmentMemoryCounts(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value)
      .map(([key, count]) => [trimText(key), Number(count)])
      .filter(([key, count]) => key && Number.isFinite(count))
      .slice(0, 8));
  }
  const counts = {};
  for (const part of String(value).split(',')) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(\d+)\s*$/.exec(part);
    if (match) counts[match[1]] = Number(match[2]);
  }
  return counts;
}

function compactWorkContinuationTotals(value) {
  if (!value || typeof value !== 'object') return {};
  const fields = [
    'active_count',
    'carried_count',
    'stale_count',
    'blocked_count',
    'approval_required_count',
  ];
  return Object.fromEntries(fields
    .map((field) => [field, Number(value[field] ?? value[field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())])])
    .filter(([, count]) => Number.isFinite(count)));
}

function compactRuntimeSignals(value) {
  return asArray(value).map(trimText).filter(Boolean).slice(0, 8);
}

function compactCalendarMessageConnectorCandidates(value) {
  return asArray(value)
    .map((entry) => ({
      candidate: trimText(entry?.candidate) || null,
      seam: trimText(entry?.seam) || null,
      writes_or_sends: entry?.writes_or_sends === true,
    }))
    .filter((entry) => entry.candidate)
    .slice(0, 6);
}

function compactCalendarMessageSelectedConnector(value) {
  if (!value || typeof value !== 'object') return null;
  const candidate = trimText(value.candidate) || null;
  if (!candidate) return null;
  return {
    candidate,
    seam: trimText(value.seam) || null,
    reason: oneLine(value.reason || '', 220) || null,
    evidence: value.evidence && typeof value.evidence === 'object'
      ? Object.fromEntries(Object.entries(value.evidence)
        .map(([key, entryValue]) => [trimText(key), Number.isFinite(Number(entryValue)) ? Number(entryValue) : trimText(entryValue)])
        .filter(([key, entryValue]) => key && entryValue !== ''))
      : {},
    writes_or_sends: value.writes_or_sends === true,
  };
}

function compactCalendarMessageCommsMetadata(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    ok: value.ok === true,
    source: trimText(value.source || 'hm-comms') || 'hm-comms',
    scope: trimText(value.scope) || null,
    history_limit: Number.isFinite(Number(value.history_limit ?? value.historyLimit)) ? Number(value.history_limit ?? value.historyLimit) : null,
    row_count: Number.isFinite(Number(value.row_count ?? value.rowCount)) ? Number(value.row_count ?? value.rowCount) : 0,
    latest_timestamp_ms: Number.isFinite(Number(value.latest_timestamp_ms ?? value.latestTimestampMs))
      ? Number(value.latest_timestamp_ms ?? value.latestTimestampMs)
      : null,
    latest_message_ids: asArray(value.latest_message_ids || value.latestMessageIds).map(trimText).filter(Boolean).slice(0, 8),
    sender_counts: compactSchedulerTypeCounts(value.sender_counts || value.senderCounts),
    target_counts: compactSchedulerTypeCounts(value.target_counts || value.targetCounts),
    status_counts: compactSchedulerTypeCounts(value.status_counts || value.statusCounts),
    role_pair_counts: compactSchedulerTypeCounts(value.role_pair_counts || value.rolePairCounts),
    thread_pressure: asArray(value.thread_pressure || value.threadPressure)
      .map((entry) => ({
        pair: trimText(entry?.pair) || null,
        count: Number.isFinite(Number(entry?.count)) ? Number(entry.count) : null,
        latest_timestamp_ms: Number.isFinite(Number(entry?.latest_timestamp_ms ?? entry?.latestTimestampMs))
          ? Number(entry.latest_timestamp_ms ?? entry.latestTimestampMs)
          : null,
      }))
      .filter((entry) => entry.pair)
      .slice(0, 6),
    mira_route_count: Number.isFinite(Number(value.mira_route_count ?? value.miraRouteCount))
      ? Number(value.mira_route_count ?? value.miraRouteCount)
      : 0,
  };
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
  const rawPossibleAction = rawItem.possible_action ?? rawItem.possibleAction;
  const possibleAction = oneLine(rawPossibleAction == null ? 'Ask a pointed follow-up or route an internal review item.' : rawPossibleAction, 220);
  const routeHint = trimText(rawItem.route_hint || rawItem.routeHint || 'mira_lab') || 'mira_lab';
  const status = normalizeCuriosityStatus(rawItem.status);
  const sensitivityHint = trimText(rawItem.sensitivity_hint || rawItem.sensitivityHint || 'local_metadata_only') || 'local_metadata_only';
  const memoryResultCount = Number(rawItem.memory_result_count ?? rawItem.memoryResultCount);
  const selfDirectionPendingCount = Number(rawItem.self_direction_pending_count ?? rawItem.selfDirectionPendingCount);
  const memoryBrokerResultCount = Number(rawItem.memory_broker_result_count ?? rawItem.memoryBrokerResultCount);
  const environmentScore = Number(rawItem.environment_overall_score ?? rawItem.environmentOverallScore);
  const browserResultCount = Number(rawItem.browser_result_count ?? rawItem.browserResultCount);
  const emailLabelCount = Number(rawItem.email_label_count ?? rawItem.emailLabelCount);
  const emailUnreadTotal = Number(rawItem.email_unread_total ?? rawItem.emailUnreadTotal);
  const emailRecentMessageCount = Number(rawItem.email_recent_message_count ?? rawItem.emailRecentMessageCount);
  const webResultCount = Number(rawItem.web_result_count ?? rawItem.webResultCount);
  const visualAssetCount = Number(rawItem.visual_asset_count ?? rawItem.visualAssetCount);
  const schedulerScheduleCount = Number(rawItem.scheduler_schedule_count ?? rawItem.schedulerScheduleCount);
  const schedulerActiveCount = Number(rawItem.scheduler_active_count ?? rawItem.schedulerActiveCount);
  const schedulerDueSoonCount = Number(rawItem.scheduler_due_soon_count ?? rawItem.schedulerDueSoonCount);
  const schedulerOverdueCount = Number(rawItem.scheduler_overdue_count ?? rawItem.schedulerOverdueCount);
  const workCarriedCount = Number(rawItem.work_carried_count ?? rawItem.workCarriedCount);
  const workStaleCount = Number(rawItem.work_stale_count ?? rawItem.workStaleCount);
  const workApprovalRequiredCount = Number(rawItem.work_approval_required_count ?? rawItem.workApprovalRequiredCount);
  const workDueCount = Number(rawItem.work_due_count ?? rawItem.workDueCount);
  const workHeldCount = Number(rawItem.work_held_count ?? rawItem.workHeldCount);
  const runtimeModuleCount = Number(rawItem.runtime_module_count ?? rawItem.runtimeModuleCount);
  const runtimeActiveSignalCount = Number(rawItem.runtime_active_signal_count ?? rawItem.runtimeActiveSignalCount);
  const runtimeBlockedCount = Number(rawItem.runtime_blocked_count ?? rawItem.runtimeBlockedCount);
  const calendarArtifactCount = Number(rawItem.calendar_artifact_count ?? rawItem.calendarArtifactCount);
  const messageArtifactCount = Number(rawItem.message_artifact_count ?? rawItem.messageArtifactCount);
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
    self_direction_pending_count: Number.isFinite(selfDirectionPendingCount) ? selfDirectionPendingCount : null,
    recent_comms_signal: oneLine(rawItem.recent_comms_signal || rawItem.recentCommsSignal, 220) || null,
    recent_comms_actionable: typeof (rawItem.recent_comms_actionable ?? rawItem.recentCommsActionable) === 'boolean'
      ? Boolean(rawItem.recent_comms_actionable ?? rawItem.recentCommsActionable)
      : null,
    memory_query: trimText(rawItem.memory_query || rawItem.memoryQuery) || null,
    memory_result_count: Number.isFinite(memoryResultCount) ? memoryResultCount : null,
    memory_top_result: compactCuriosityMemoryTopResult(rawItem.memory_top_result || rawItem.memoryTopResult),
    memory_broker_query: trimText(rawItem.memory_broker_query || rawItem.memoryBrokerQuery) || null,
    memory_broker_result_count: Number.isFinite(memoryBrokerResultCount) ? memoryBrokerResultCount : null,
    memory_broker_top_result: compactMemoryBrokerTopResult(rawItem.memory_broker_top_result || rawItem.memoryBrokerTopResult),
    memory_broker_sources: compactMemoryBrokerSources(rawItem.memory_broker_sources || rawItem.memoryBrokerSources),
    environment_overall_label: trimText(rawItem.environment_overall_label || rawItem.environmentOverallLabel) || null,
    environment_overall_score: Number.isFinite(environmentScore) ? environmentScore : null,
    environment_snapshot_stale: typeof (rawItem.environment_snapshot_stale ?? rawItem.environmentSnapshotStale) === 'boolean'
      ? Boolean(rawItem.environment_snapshot_stale ?? rawItem.environmentSnapshotStale)
      : null,
    environment_memory_sync_status: trimText(rawItem.environment_memory_sync_status || rawItem.environmentMemorySyncStatus) || null,
    environment_memory_counts: compactEnvironmentMemoryCounts(rawItem.environment_memory_counts || rawItem.environmentMemoryCounts),
    environment_memory_repair_state: trimText(rawItem.environment_memory_repair_state || rawItem.environmentMemoryRepairState) || null,
    environment_memory_review_only: typeof (rawItem.environment_memory_review_only ?? rawItem.environmentMemoryReviewOnly) === 'boolean'
      ? Boolean(rawItem.environment_memory_review_only ?? rawItem.environmentMemoryReviewOnly)
      : null,
    environment_memory_review_queue: compactEnvironmentMemoryCounts(rawItem.environment_memory_review_queue || rawItem.environmentMemoryReviewQueue),
    environment_bridge_connection: trimText(rawItem.environment_bridge_connection || rawItem.environmentBridgeConnection) || null,
    browser_result_count: Number.isFinite(browserResultCount) ? browserResultCount : null,
    browser_top_hosts: compactBrowserHistoryTopHosts(rawItem.browser_top_hosts || rawItem.browserTopHosts),
    browser_name: trimText(rawItem.browser_name || rawItem.browserName) || null,
    browser_profile: trimText(rawItem.browser_profile || rawItem.browserProfile) || null,
    email_label_count: Number.isFinite(emailLabelCount) ? emailLabelCount : null,
    email_unread_total: Number.isFinite(emailUnreadTotal) ? emailUnreadTotal : null,
    email_recent_message_count: Number.isFinite(emailRecentMessageCount) ? emailRecentMessageCount : null,
    email_top_labels: compactEmailTopLabels(rawItem.email_top_labels || rawItem.emailTopLabels),
    email_label_pressure_buckets: compactEmailPressureBuckets(rawItem.email_label_pressure_buckets || rawItem.emailLabelPressureBuckets),
    email_snapshot_gaps: compactEmailSnapshotGaps(rawItem.email_snapshot_gaps || rawItem.emailSnapshotGaps),
    email_suggested_next_snapshot_queries: compactEmailSuggestedSnapshotQueries(rawItem.email_suggested_next_snapshot_queries || rawItem.emailSuggestedNextSnapshotQueries),
    email_pressure_question: oneLine(rawItem.email_pressure_question || rawItem.emailPressureQuestion, 220) || null,
    web_result_count: Number.isFinite(webResultCount) ? webResultCount : null,
    web_top_domains: compactWebTopDomains(rawItem.web_top_domains || rawItem.webTopDomains),
    web_top_artifact: compactWebResearchTopArtifact(rawItem.web_top_artifact || rawItem.webTopArtifact),
    visual_asset_count: Number.isFinite(visualAssetCount) ? visualAssetCount : null,
    visual_asset_buckets: compactVisualAssetBuckets(rawItem.visual_asset_buckets || rawItem.visualAssetBuckets),
    visual_latest_asset_followup: compactVisualAssetFollowup(rawItem.visual_latest_asset_followup || rawItem.visualLatestAssetFollowup),
    scheduler_schedule_count: Number.isFinite(schedulerScheduleCount) ? schedulerScheduleCount : null,
    scheduler_active_count: Number.isFinite(schedulerActiveCount) ? schedulerActiveCount : null,
    scheduler_due_soon_count: Number.isFinite(schedulerDueSoonCount) ? schedulerDueSoonCount : null,
    scheduler_overdue_count: Number.isFinite(schedulerOverdueCount) ? schedulerOverdueCount : null,
    scheduler_type_counts: compactSchedulerTypeCounts(rawItem.scheduler_type_counts || rawItem.schedulerTypeCounts),
    scheduler_followthrough_design: compactSchedulerFollowthroughDesign(rawItem.scheduler_followthrough_design || rawItem.schedulerFollowthroughDesign),
    parallel_scout_plan: compactParallelScoutPlan(rawItem.parallel_scout_plan || rawItem.parallelScoutPlan),
    work_continuation_totals: compactWorkContinuationTotals(rawItem.work_continuation_totals || rawItem.workContinuationTotals),
    work_carried_count: Number.isFinite(workCarriedCount) ? workCarriedCount : null,
    work_stale_count: Number.isFinite(workStaleCount) ? workStaleCount : null,
    work_approval_required_count: Number.isFinite(workApprovalRequiredCount) ? workApprovalRequiredCount : null,
    work_due_count: Number.isFinite(workDueCount) ? workDueCount : null,
    work_held_count: Number.isFinite(workHeldCount) ? workHeldCount : null,
    work_next_agent: trimText(rawItem.work_next_agent || rawItem.workNextAgent) || null,
    work_next_task_id: trimText(rawItem.work_next_task_id || rawItem.workNextTaskId) || null,
    runtime_healthy: typeof (rawItem.runtime_healthy ?? rawItem.runtimeHealthy) === 'boolean'
      ? Boolean(rawItem.runtime_healthy ?? rawItem.runtimeHealthy)
      : null,
    runtime_module_count: Number.isFinite(runtimeModuleCount) ? runtimeModuleCount : null,
    runtime_active_signal_count: Number.isFinite(runtimeActiveSignalCount) ? runtimeActiveSignalCount : null,
    runtime_blocked_count: Number.isFinite(runtimeBlockedCount) ? runtimeBlockedCount : null,
    runtime_active_signals: compactRuntimeSignals(rawItem.runtime_active_signals || rawItem.runtimeActiveSignals),
    runtime_blocked_modules: compactRuntimeSignals(rawItem.runtime_blocked_modules || rawItem.runtimeBlockedModules),
    calendar_artifact_count: Number.isFinite(calendarArtifactCount) ? calendarArtifactCount : null,
    message_artifact_count: Number.isFinite(messageArtifactCount) ? messageArtifactCount : null,
    calendar_first_start: trimText(rawItem.calendar_first_start || rawItem.calendarFirstStart) || null,
    calendar_last_start: trimText(rawItem.calendar_last_start || rawItem.calendarLastStart) || null,
    calendar_message_connector_candidates: compactCalendarMessageConnectorCandidates(rawItem.connector_candidates || rawItem.connectorCandidates),
    calendar_message_selected_connector: compactCalendarMessageSelectedConnector(rawItem.selected_connector_candidate || rawItem.selectedConnectorCandidate),
    calendar_message_comms_metadata: compactCalendarMessageCommsMetadata(rawItem.native_comms_metadata || rawItem.nativeCommsMetadata),
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
  const pendingCount = Object.entries(counts).reduce((total, [status, count]) => (
    /pending|queued|needs_review|review_required/i.test(status) ? total + count : total
  ), 0);
  const latest = proposals[proposals.length - 1];
  return {
    source: 'runtime_comms',
    adapter_id: 'self_direction_queue',
    status: 'active',
    observation: `Mira self-direction queue has ${proposals.length} proposal(s): ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(', ')}. Latest: ${oneLine(latest.desired_change || latest.voice_text, 120)}`,
    why_interesting: 'The queue shows what Mira has already tried to lead, so curiosity can follow up instead of starting cold.',
    hypothesis: 'There may be a proposal that wants a next experiment, review decision, or implementation outcome.',
    suggested_question: 'Which queued Mira proposal should become a concrete experiment next?',
    possible_action: pendingCount > 0
      ? 'Ask Architect to route the most alive queued proposal if it is still pending.'
      : '',
    route_hint: 'architect',
    sensitivity_hint: 'local_runtime_queue_metadata',
    self_direction_pending_count: pendingCount,
  };
}

function compactRecentCommsLines(text, limit = 20) {
  const maxLines = Math.max(1, Math.min(100, Number(limit) || 20));
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Rows:\s*\d+\s*$/i.test(line))
    .filter((line) => !/^\[dotenv@/i.test(line))
    .filter((line) => !/^\(node:\d+\)\s+ExperimentalWarning:/i.test(line))
    .slice(-maxLines);
}

function newestRecentCommsSignal(lines = []) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(lines[0])) return lines[0];
  return lines[lines.length - 1];
}

function actionableRecentCommsSignal(lines = []) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  const newestFirst = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(lines[0]);
  const ordered = newestFirst ? lines : [...lines].reverse();
  return ordered.find((line) => (
    /\buser\s*->\s*(architect|builder|oracle|mira)\b/i.test(line)
    || /^\[Telegram from /i.test(line)
  )) || '';
}

function recentCommsCuriosityAdapter(context) {
  if (typeof context.recentCommsText === 'string') {
    const lines = compactRecentCommsLines(context.recentCommsText);
    const newestSignal = newestRecentCommsSignal(lines);
    const actionableSignal = actionableRecentCommsSignal(lines);
    return {
      source: 'runtime_comms',
      adapter_id: 'recent_comms',
      status: 'active',
      observation: lines.length > 0
        ? `Recent comms fixture has ${lines.length} line(s). Newest signal: ${oneLine(newestSignal, 160)}${actionableSignal ? ` Actionable signal: ${oneLine(actionableSignal, 160)}` : ' No current user/Mira-origin action signal.'}`
        : 'Recent comms fixture is empty.',
      why_interesting: 'Recent agent chatter can reveal tension, repeated requests, or unfinished product questions.',
      hypothesis: 'A repeated demand or correction may be telling Mira what to inspect next.',
      suggested_question: 'What repeated demand in the recent comms should Mira inspect without waiting for James?',
      possible_action: actionableSignal
        ? 'Stage a curiosity item or self-direction proposal from the repeated comms pattern.'
        : '',
      route_hint: 'architect',
      sensitivity_hint: 'internal_comms_metadata',
      recent_comms_signal: actionableSignal || newestSignal,
      recent_comms_actionable: Boolean(actionableSignal),
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
  const lines = compactRecentCommsLines(run.stdout);
  const newestSignal = newestRecentCommsSignal(lines);
  const actionableSignal = actionableRecentCommsSignal(lines);
  return {
    source: 'runtime_comms',
    adapter_id: 'recent_comms',
    status: 'active',
    observation: lines.length > 0
      ? `Recent comms helper returned ${lines.length} line(s). Newest signal: ${oneLine(newestSignal, 160)}${actionableSignal ? ` Actionable signal: ${oneLine(actionableSignal, 160)}` : ' No current user/Mira-origin action signal.'}`
      : 'Recent comms helper returned no lines.',
    why_interesting: 'Recent comms are where Mira can notice repeated pressure, unfinished work, and routing gaps.',
    hypothesis: 'Recent team messages may point at a product tension before James turns it into a task.',
    suggested_question: 'What pattern in the last comms should Mira ask Architect or James about?',
    possible_action: actionableSignal
      ? 'Route a concise internal question to Architect if the pattern looks actionable.'
      : '',
    route_hint: 'architect',
    sensitivity_hint: 'internal_comms_metadata',
    recent_comms_signal: actionableSignal || newestSignal,
    recent_comms_actionable: Boolean(actionableSignal),
  };
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

function memoryBrokerHasReadableStore(projectRoot) {
  const root = path.resolve(projectRoot || process.cwd());
  return [
    path.join(root, '.squidrun', 'runtime', 'cognitive-memory.db'),
    path.join(root, '.squidrun', 'memory', 'cognitive-memory.db'),
    path.join(root, '.squidrun', 'runtime', 'team-memory.sqlite'),
    path.join(root, '.squidrun', 'runtime', 'evidence-ledger.db'),
  ].some((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

function readMiraMemoryBrokerCuriosity(payload = {}, options = {}) {
  const projectRoot = projectRootFromOptions(options, payload);
  const query = oneLine(payload.query || options.query || 'Mira current lane source/action substrate continuity', 1000);
  const limit = Math.max(1, Math.min(8, Number(payload.limit || options.limit || 3) || 3));
  const providerLimit = Math.max(1, Math.min(8, Number(payload.providerLimit || payload.provider_limit || options.providerLimit || 2) || 2));
  const timeoutMs = Math.max(100, Math.min(5000, Number(payload.timeoutMs || payload.timeout_ms || options.timeoutMs || 600) || 600));
  const storePreflight = payload.storePreflight !== false && options.storePreflight !== false;
  if (storePreflight && !memoryBrokerHasReadableStore(projectRoot)) {
    return {
      ok: false,
      decision: 'memory_broker_unavailable',
      reason: 'no_local_memory_broker_stores_found',
      query,
      results: [],
      sources: [],
      consequence_controls: {
        internal_only: true,
        read_only: true,
        external_send_performed: false,
        autonomous_apply_performed: false,
        file_write_performed: false,
        network_performed: false,
      },
    };
  }
  const scriptPath = path.join(__dirname, '..', 'scripts', 'hm-memory-broker.js');
  const run = spawnSync(process.execPath, [
    scriptPath,
    'recall',
    query,
    '--limit', String(limit),
    '--provider-limit', String(providerLimit),
    '--timeout-ms', String(timeoutMs),
    '--json',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: Math.max(3500, timeoutMs * 6),
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
    },
  });
  if (run.status !== 0) {
    return {
      ok: false,
      decision: 'memory_broker_unavailable',
      reason: 'hm_memory_broker_failed',
      error: oneLine(run.stderr || run.stdout || 'memory broker command failed', 260),
      query,
      results: [],
      sources: [],
      consequence_controls: {
        internal_only: true,
        read_only: true,
        external_send_performed: false,
        autonomous_apply_performed: false,
        file_write_performed: false,
        network_performed: false,
      },
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(run.stdout || '{}');
  } catch (err) {
    return {
      ok: false,
      decision: 'memory_broker_unavailable',
      reason: 'hm_memory_broker_json_parse_failed',
      error: err.message,
      query,
      results: [],
      sources: [],
      consequence_controls: {
        internal_only: true,
        read_only: true,
        external_send_performed: false,
        autonomous_apply_performed: false,
        file_write_performed: false,
        network_performed: false,
      },
    };
  }
  const results = asArray(parsed.results).slice(0, limit);
  return {
    ok: parsed.ok === true,
    decision: parsed.ok === true ? 'memory_broker_recalled_read_only' : 'memory_broker_unavailable',
    query: trimText(parsed.query || query),
    result_count: results.length,
    results,
    sources: compactMemoryBrokerSources(parsed.sources),
    consequence_controls: {
      internal_only: true,
      read_only: true,
      external_send_performed: false,
      autonomous_apply_performed: false,
      file_write_performed: false,
      network_performed: false,
      ...(parsed.consequence_controls || {}),
    },
  };
}

function activeMemoryBrokerCuriosityAdapter(context = {}) {
  const query = trimText(context.memoryBrokerCuriosityQuery || context.memoryCuriosityQuery)
    || 'Mira source action substrate current lane memory continuity';
  const reader = typeof context.memoryBrokerCuriosityReader === 'function'
    ? context.memoryBrokerCuriosityReader
    : readMiraMemoryBrokerCuriosity;
  const result = reader({
    query,
    limit: context.memoryBrokerLimit || 3,
    providerLimit: context.memoryBrokerProviderLimit || 2,
    timeoutMs: context.memoryBrokerTimeoutMs || 600,
    storePreflight: context.memoryBrokerStorePreflight,
  }, {
    projectRoot: context.projectRoot,
    query,
    limit: context.memoryBrokerLimit || 3,
    providerLimit: context.memoryBrokerProviderLimit || 2,
    timeoutMs: context.memoryBrokerTimeoutMs || 600,
    storePreflight: context.memoryBrokerStorePreflight,
  });
  if (!result || result.ok !== true) {
    return {
      source: 'memory_broker',
      scope: 'hybrid_memory_recall',
      adapter_id: 'unified_memory_broker_curiosity',
      integration_strategy: 'existing_seam',
      status: 'unavailable_in_this_runtime',
      observation: `Unified memory broker recall was attempted but is unavailable: ${trimText(result?.reason || result?.error || 'unknown')}.`,
      why_interesting: 'Mira should have one ranked recall arm over vector/cognitive, graph/team, and episodic/ledger stores instead of choosing memory stores manually.',
      hypothesis: 'The substrate should keep the unified broker as the next memory arm once local stores are present.',
      suggested_question: 'What local memory broker store or provider is missing from this runtime?',
      possible_action: 'Verify hm-memory-broker recall over local cognitive, team, and evidence stores before routing memory-based initiatives.',
      route_hint: 'builder',
      sensitivity_hint: 'local_memory_metadata',
      adapter_error: trimText(result?.reason || result?.error || 'memory_broker_unavailable'),
      memory_broker_query: query,
      memory_broker_result_count: 0,
      memory_broker_sources: compactMemoryBrokerSources(result?.sources),
      no_mutation_performed: true,
    };
  }
  const top = compactMemoryBrokerTopResult(asArray(result.results)[0]);
  const topLabel = top?.title || top?.ref || top?.id || 'no titled result';
  const sourceText = compactMemoryBrokerSources(result.sources)
    .map((entry) => `${entry.source || entry.sourceKind}:${entry.itemCount}`)
    .join(', ') || 'no provider counts';
  return {
    source: 'memory_broker',
    scope: 'hybrid_memory_recall',
    adapter_id: 'unified_memory_broker_curiosity',
    integration_strategy: 'existing_seam',
    status: 'active',
    observation: `Unified memory broker returned ${result.result_count || 0} ranked result(s) for the active lane query; top=${topLabel}; sources=${sourceText}.`,
    why_interesting: 'Mira can now treat memory as one ranked source/action arm across vector, graph, and episodic stores.',
    hypothesis: top
      ? `The broker result "${topLabel}" may change which internal route Mira should pick next.`
      : 'The broker is connected, but this query did not produce a strong ranked result yet.',
    suggested_question: top
      ? `Which current route changes if Mira uses unified recall result ${top.id || topLabel}?`
      : 'Which broker query should Mira practice next for the active lane?',
    possible_action: 'Use hm-memory-broker recall as ranked private context before choosing the next internal route; compare contributors and route only if it changes the decision.',
    route_hint: 'builder',
    sensitivity_hint: 'local_memory_metadata',
    memory_broker_query: result.query || query,
    memory_broker_result_count: result.result_count || 0,
    memory_broker_top_result: top,
    memory_broker_sources: compactMemoryBrokerSources(result.sources),
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
  const pressureBuckets = asArray(result.label_pressure_buckets).slice(0, 8);
  const snapshotGaps = result.snapshot_gaps || null;
  const suggestedQueries = asArray(result.suggested_next_snapshot_queries).slice(0, 5);
  const pressureQuestion = trimText(result.pressure_question)
    || (topLabel ? `What should Mira infer or ask from the ${topLabel} email pressure signal?` : 'Which email query should Mira snapshot next for a stronger signal?');
  const gapText = snapshotGaps?.thread_poor_snapshot
    ? ` Snapshot gap: missing sender_domain=${snapshotGaps.missing_sender_domain_count || 0}, subject=${snapshotGaps.missing_subject_count || 0}, timestamp=${snapshotGaps.missing_timestamp_count || 0}.`
    : '';
  return {
    source: 'email',
    scope: 'local_email',
    adapter_id: 'email_curiosity',
    integration_strategy: 'native_adapter',
    status: 'active',
    observation: `Email metadata snapshot read ${result.label_count || 0} label(s), ${result.unread_total || 0} unread message(s), and ${result.recent_message_count || 0} hashed recent message ref(s); top labels: ${topLabelText}.${gapText}`,
    why_interesting: 'Mira can now notice inbox pressure and mailbox shape without opening message bodies or mutating mail.',
    hypothesis: snapshotGaps?.thread_poor_snapshot
      ? 'The mailbox signal is label-heavy but thread-poor, so Mira needs a tighter metadata snapshot before treating unread count as an obligation.'
      : topLabel
        ? `${topLabel} may be the strongest current email pressure signal.`
      : 'The email source is connected, but the latest snapshot did not show a strong label signal.',
    suggested_question: pressureQuestion,
    possible_action: suggestedQueries[0]?.query
      ? `Refresh metadata only for ${suggestedQueries[0].query}; keep body reads, sends, archives, deletes, and label changes out of this adapter.`
      : 'Use compact email metadata as one curiosity signal; keep body reads, sends, archives, deletes, and label changes out of this adapter.',
    route_hint: 'mira_lab',
    sensitivity_hint: 'email_metadata_only',
    email_label_count: result.label_count || 0,
    email_unread_total: result.unread_total || 0,
    email_recent_message_count: result.recent_message_count || 0,
    email_top_labels: topLabels,
    email_label_pressure_buckets: pressureBuckets,
    email_snapshot_gaps: snapshotGaps,
    email_suggested_next_snapshot_queries: suggestedQueries,
    email_pressure_question: pressureQuestion,
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
  const topArtifact = compactWebResearchTopArtifact(asArray(result.results)[0]);
  const topArtifactLabel = topArtifact?.title || topArtifact?.path || null;
  return {
    source: 'web_research',
    scope: 'websites_and_research_trails',
    adapter_id: 'web_research_curiosity',
    integration_strategy: 'native_adapter',
    status: 'active',
    observation: `Web research artifacts read ${result.result_count || 0} compact item(s); buckets=${Object.entries(result.buckets || {}).map(([key, value]) => `${key}:${value}`).join(', ') || 'none'}; top artifact: ${topArtifactLabel || 'none'}; top domains: ${domainText}.`,
    why_interesting: 'Mira can now inspect prior research trails and saved web context before asking James to reconstruct what he read.',
    hypothesis: topArtifactLabel
      ? `${topArtifactLabel} may be the strongest saved research artifact, even when a repeated domain is louder in the aggregate.`
      : topDomain
      ? `${topDomain} may be the strongest saved research trail.`
      : 'The web research source is connected, but the local artifacts did not expose a strong domain pattern.',
    suggested_question: topArtifactLabel
      ? `What should Mira infer or ask from the saved research artifact "${topArtifactLabel}"?`
      : topDomain
      ? `What should Mira infer or ask from the saved ${topDomain} research trail?`
      : 'Which saved research artifact should Mira inspect more deeply next?',
    possible_action: topArtifact?.path
      ? `Use compact metadata from ${topArtifact.path} before treating domain counts as the lead; keep live network crawling and raw query strings out of this adapter.`
      : 'Use compact local web/research artifact metadata as a curiosity signal; keep live network crawling and raw query strings out of this adapter.',
    route_hint: 'mira_lab',
    sensitivity_hint: 'local_web_research_metadata',
    web_result_count: result.result_count || 0,
    web_top_domains: topDomains,
    web_top_artifact: topArtifact,
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
  const latestFollowup = compactVisualAssetFollowup(result.latest_asset_followup || latest);
  const latestLabel = latestFollowup?.path || latest?.path || null;
  const latestQuestion = latestFollowup?.suggested_question
    || (latestLabel ? `What should Mira infer or ask from latest visual asset ${latestLabel}?` : 'Which visual asset folder should Mira check next?');
  const latestAction = latestFollowup?.possible_action
    || 'Use compact visual metadata as a curiosity signal; defer OCR or image-model reads to a separate explicit visual-understanding step.';
  return {
    source: 'images_screenshots_assets',
    scope: 'local_visual_context',
    adapter_id: 'visual_asset_curiosity',
    integration_strategy: 'native_adapter',
    status: 'active',
    observation: `Visual asset inventory read ${result.result_count || 0} image file(s); buckets=${Object.entries(result.buckets || {}).map(([key, value]) => `${key}:${value}`).join(', ') || 'none'}; latest=${latestLabel || 'none'}.`,
    why_interesting: 'Mira can now notice fresh screenshots and generated assets before James has to explain what is on screen.',
    hypothesis: latestLabel
      ? `${latestLabel} may be the freshest visual context worth inspecting.`
      : 'The visual source is connected, but no specific latest asset stood out.',
    suggested_question: latestQuestion,
    possible_action: latestAction,
    route_hint: 'mira_lab',
    sensitivity_hint: 'local_visual_asset_metadata',
    visual_asset_count: result.result_count || 0,
    visual_asset_buckets: result.buckets || {},
    visual_latest_asset_followup: latestFollowup,
    no_mutation_performed: true,
  };
}

function activeAutomationSchedulerCuriosityAdapter(context = {}) {
  const reader = typeof context.schedulerCuriosityReader === 'function'
    ? context.schedulerCuriosityReader
    : readMiraAutomationSchedulerCuriosity;
  const result = reader({
    schedulerStatePaths: context.schedulerStatePaths,
    limit: context.schedulerLimit || 24,
  }, {
    projectRoot: context.projectRoot,
    schedulerStatePaths: context.schedulerStatePaths,
    limit: context.schedulerLimit || 24,
    nowMs: context.nowMs,
  });
  if (!result || result.ok !== true) {
    return {
      source: 'automation_scheduler',
      scope: 'local_automation_and_scheduler',
      adapter_id: 'automation_scheduler_curiosity',
      integration_strategy: 'existing_seam',
      status: 'unavailable_in_this_runtime',
      observation: `Scheduler state read was attempted but is unavailable: ${trimText(result?.reason || result?.error || 'unknown')}.`,
      why_interesting: 'Mira needs to see the local automation surface before turning curiosity into recurring inspection.',
      hypothesis: 'The scheduler seam may exist, but its state file needs repair or a different read path before Mira can trust it.',
      suggested_question: 'Which scheduler state path or IPC list seam should Mira inspect next?',
      possible_action: 'Repair the read-only scheduler metadata path before creating, running, or updating any schedule.',
      route_hint: 'builder',
      sensitivity_hint: 'local_scheduler_metadata',
      adapter_error: trimText(result?.reason || result?.error || 'scheduler_state_unavailable'),
      no_mutation_performed: true,
    };
  }
  const count = Number(result.schedule_count || 0);
  const activeCount = Number(result.active_count || 0);
  const dueSoonCount = Number(result.due_soon_count || 0);
  const overdueCount = Number(result.overdue_count || 0);
  const nextName = result.next_schedule?.name || null;
  const schedulerCounts = {
    scheduler_schedule_count: count,
    scheduler_active_count: activeCount,
    scheduler_due_soon_count: dueSoonCount,
    scheduler_overdue_count: overdueCount,
  };
  return {
    source: 'automation_scheduler',
    scope: 'local_automation_and_scheduler',
    adapter_id: 'automation_scheduler_curiosity',
    integration_strategy: 'existing_seam',
    status: 'active',
    observation: `Scheduler metadata read ${count} schedule(s); active=${activeCount}; due_soon=${dueSoonCount}; overdue=${overdueCount}; state=${result.state_found ? 'found' : 'missing_but_readable'}.`,
    why_interesting: 'Mira can now inspect automation cadence before asking James to hand-run recurring curiosity work.',
    hypothesis: nextName
      ? `${nextName} is the next visible automation event worth comparing against current curiosity routes.`
      : 'No scheduled automation currently stands out, so Mira needs a reviewed recurring curiosity routine rather than another manual scout.',
    suggested_question: nextName
      ? `Should Mira compare the next scheduled automation ${nextName} with the current direct-route frontier?`
      : 'What quiet-interval curiosity burst should Mira propose for the scheduler first?',
    possible_action: 'Use compact scheduler metadata to design a reviewed recurring curiosity burst; do not create, update, delete, or run schedules from scout output.',
    route_hint: 'builder',
    sensitivity_hint: 'local_scheduler_metadata',
    scheduler_schedule_count: count,
    scheduler_active_count: activeCount,
    scheduler_due_soon_count: dueSoonCount,
    scheduler_overdue_count: overdueCount,
    scheduler_type_counts: result.type_counts || {},
    scheduler_followthrough_design: count === 0 && activeCount === 0 && dueSoonCount === 0 && overdueCount === 0
      ? schedulerReviewedCuriosityBurstPlan(schedulerCounts)
      : null,
    no_mutation_performed: true,
  };
}

function activeWorkContinuationCuriosityAdapter(context = {}) {
  const reader = typeof context.workContinuationCuriosityReader === 'function'
    ? context.workContinuationCuriosityReader
    : readMiraWorkContinuationCuriosity;
  const result = reader({
    queuePath: context.workContinuationQueuePath,
    wakeTrigger: context.workContinuationWakeTrigger || 'post-wake',
    staleAfterMs: context.workContinuationStaleAfterMs,
  }, {
    projectRoot: context.projectRoot,
    queuePath: context.workContinuationQueuePath,
    wakeTrigger: context.workContinuationWakeTrigger || 'post-wake',
    staleAfterMs: context.workContinuationStaleAfterMs,
    nowMs: context.nowMs,
  });
  if (!result || result.ok !== true) {
    return {
      source: 'work_continuation',
      scope: 'background_work_and_routing',
      adapter_id: 'work_continuation_curiosity',
      integration_strategy: 'existing_seam',
      status: 'unavailable_in_this_runtime',
      observation: `Owned-work continuation read was attempted but is unavailable: ${trimText(result?.reason || result?.error || 'unknown')}.`,
      why_interesting: 'Mira needs to see pending owned work before deciding whether to start a fresh lane or resume a stalled one.',
      hypothesis: 'The continuation seam may exist, but the queue path or summary broker needs repair before Mira can trust it.',
      suggested_question: 'Which owned-work queue or continuation broker path should Mira inspect next?',
      possible_action: 'Repair the read-only work-continuation metadata path before dispatching or mutating queue state.',
      route_hint: 'builder',
      sensitivity_hint: 'local_owned_work_metadata',
      adapter_error: trimText(result?.reason || result?.error || 'work_continuation_unavailable'),
      no_mutation_performed: true,
    };
  }
  const totals = result.totals || {};
  const next = result.next_action || null;
  return {
    source: 'work_continuation',
    scope: 'background_work_and_routing',
    adapter_id: 'work_continuation_curiosity',
    integration_strategy: 'existing_seam',
    status: 'active',
    observation: `Owned-work continuation read carried=${totals.carried_count || 0}; stale=${totals.stale_count || 0}; blocked=${totals.blocked_count || 0}; approval_required=${totals.approval_required_count || 0}; next=${next?.agent || 'none'}/${next?.task_id || 'none'}.`,
    why_interesting: 'Mira can now notice unfinished internal work and choose resume-vs-new-route instead of losing threads between bursts.',
    hypothesis: next?.task_id
      ? `${next.agent}/${next.task_id} is the next dispatch-ready owned-work continuation to compare against fresh curiosity routes.`
      : 'No dispatch-ready owned work is due, so the next route can advance to new runtime growth without dropping a queued task.',
    suggested_question: next?.task_id
      ? `Should Mira resume ${next.agent}/${next.task_id} before starting the next new capability lane?`
      : 'Which fresh runtime lane should Mira choose now that no owned-work continuation is due?',
    possible_action: 'Use compact owned-work metadata to decide whether to resume existing work; do not dispatch, continue, block, or mutate queue state from scout output.',
    route_hint: next?.agent || 'builder',
    sensitivity_hint: 'local_owned_work_metadata',
    work_continuation_totals: totals,
    work_carried_count: totals.carried_count || 0,
    work_stale_count: totals.stale_count || 0,
    work_approval_required_count: totals.approval_required_count || 0,
    work_due_count: result.due_count || 0,
    work_held_count: result.held_count || 0,
    work_next_agent: next?.agent || null,
    work_next_task_id: next?.task_id || null,
    no_mutation_performed: true,
  };
}

function activeMiraRuntimeCuriosityAdapter(context = {}) {
  const reader = typeof context.miraRuntimeCuriosityReader === 'function'
    ? context.miraRuntimeCuriosityReader
    : readMiraRuntimeCuriosity;
  const result = reader({
    projectRoot: context.projectRoot,
    nowMs: context.nowMs,
  }, {
    projectRoot: context.projectRoot,
    nowMs: context.nowMs,
  });
  if (!result || result.ok !== true) {
    return {
      source: 'mira_runtime',
      scope: 'mira_internal_growth_runtime',
      adapter_id: 'mira_runtime_curiosity',
      integration_strategy: 'native_adapter',
      status: 'unavailable_in_this_runtime',
      observation: `Mira runtime read was attempted but is unavailable: ${trimText(result?.reason || result?.error || 'unknown')}.`,
      why_interesting: 'Mira needs to inspect her own growth/autonomy/intent/perception modules before deciding what to evolve next.',
      hypothesis: 'The runtime reader may need a missing local knowledge artifact or module repair before this lane can be trusted.',
      suggested_question: 'Which Mira runtime module needs repair before she can trust this lane?',
      possible_action: 'Repair the read-only Mira runtime health adapter before proposing runtime mutations.',
      route_hint: 'builder',
      sensitivity_hint: 'local_mira_runtime_metadata',
      adapter_error: trimText(result?.reason || result?.error || 'mira_runtime_unavailable'),
      no_mutation_performed: true,
    };
  }
  const blockedModules = asArray(result.blocked_modules)
    .map((entry) => trimText(entry?.module || entry))
    .filter(Boolean);
  return {
    source: 'mira_runtime',
    scope: 'mira_internal_growth_runtime',
    adapter_id: 'mira_runtime_curiosity',
    integration_strategy: 'native_adapter',
    status: 'active',
    observation: `Mira runtime read ${result.module_count || 0} module(s); active_signals=${result.active_signal_count || 0}; blocked=${blockedModules.length}; healthy=${result.healthy_runtime === true}.`,
    why_interesting: 'Mira can now inspect which parts of her own growth runtime are actually clean before asking for more autonomy.',
    hypothesis: blockedModules.length > 0
      ? `${blockedModules.join(', ')} need repair before Mira should treat runtime self-evolution as fully healthy.`
      : 'The runtime health surface is clean enough to choose the next capability frontier.',
    suggested_question: blockedModules.length > 0
      ? `Which runtime gap should Mira repair first: ${blockedModules.join(', ')}?`
      : 'Which next capability should Mira select after her runtime health check?',
    possible_action: 'Use compact runtime health to route targeted repairs or advance to the next source/action frontier; do not apply runtime mutations from scout output.',
    route_hint: blockedModules.length > 0 ? 'builder' : 'mira_lab',
    sensitivity_hint: 'local_mira_runtime_metadata',
    runtime_healthy: result.healthy_runtime === true,
    runtime_module_count: result.module_count || 0,
    runtime_active_signal_count: result.active_signal_count || 0,
    runtime_blocked_count: blockedModules.length,
    runtime_active_signals: result.active_signals || [],
    runtime_blocked_modules: blockedModules,
    no_mutation_performed: true,
  };
}

function activeCalendarMessageCuriosityAdapter(context = {}) {
  const reader = typeof context.calendarMessageCuriosityReader === 'function'
    ? context.calendarMessageCuriosityReader
    : readMiraCalendarMessageCuriosity;
  const result = reader({
    calendarMessageRoots: context.calendarMessageRoots,
    limit: context.calendarMessageLimit || 24,
  }, {
    projectRoot: context.projectRoot,
    calendarMessageRoots: context.calendarMessageRoots,
    limit: context.calendarMessageLimit || 24,
    maxBytes: context.calendarMessageMaxBytes,
  });
  if (!result || result.ok !== true) {
    return {
      source: 'calendar_messages',
      scope: 'calendar_and_message_context',
      adapter_id: 'calendar_message_curiosity',
      integration_strategy: 'existing_seam',
      status: 'unavailable_in_this_runtime',
      observation: `Calendar/message metadata read was attempted but is unavailable: ${trimText(result?.reason || result?.error || 'unknown')}.`,
      why_interesting: 'Calendars and messages can reveal obligations, rhythms, and repeated context James has not turned into a prompt yet.',
      hypothesis: 'Mira needs either a local artifact reader or a connector shape before she can trust calendar/message curiosity.',
      suggested_question: 'Which local calendar/message artifact or connector candidate should Mira inspect first?',
      possible_action: 'Repair the read-only calendar/message metadata path before any message send, calendar write, or connector body read.',
      route_hint: 'builder',
      sensitivity_hint: 'calendar_message_metadata_only',
      adapter_error: trimText(result?.reason || result?.error || 'calendar_message_unavailable'),
      no_mutation_performed: true,
    };
  }
  const calendarCount = Number(result.calendar_artifact_count || 0);
  const messageCount = Number(result.message_artifact_count || 0);
  const candidates = result.connector_candidates || [];
  const selectedConnector = result.selected_connector_candidate || null;
  const nativeCommsMetadata = result.native_comms_metadata || null;
  const firstCandidate = selectedConnector?.candidate || candidates[0]?.candidate || 'calendar/message connector';
  const nativeCommsRows = Number(nativeCommsMetadata?.row_count || 0);
  const selectedNativeComms = selectedConnector?.candidate === 'native_squidrun_comms';
  const hypothesis = selectedNativeComms
    ? 'Native SquidRun comms metadata is the first useful calendar/message seam because it exposes who is pressing whom, what is routed, and what is still unresolved without reading bodies or sending anything.'
    : (calendarCount > 0 || messageCount > 0)
      ? 'Local metadata is enough to ask a sharper calendar/message question before building a live connector.'
      : 'No local artifacts are present, so the next move is choosing the first connector seam without framing it as blocked.';
  const suggestedQuestion = selectedNativeComms
    ? 'Which recent native comms pressure should Mira turn into the next internal question before reaching for calendar or Gmail APIs?'
    : calendarCount > 0
      ? 'Which local calendar time window should Mira compare against current work routes?'
      : `Should Mira connect ${firstCandidate} first for calendar/message curiosity?`;
  const possibleAction = selectedNativeComms
    ? 'Use hm-comms compact metadata as the first read-only calendar/message seam; keep message text out of scout output and do not send messages or mutate calendars.'
    : 'Use compact metadata and connector candidates to pick the next read-only calendar/message seam; do not send messages, mutate calendars, or export bodies from scout output.';
  return {
    source: 'calendar_messages',
    scope: 'calendar_and_message_context',
    adapter_id: 'calendar_message_curiosity',
    integration_strategy: selectedNativeComms ? 'existing_seam' : 'mcp_candidate',
    status: 'active',
    observation: `Calendar/message metadata read ${calendarCount} calendar artifact(s), ${messageCount} message artifact(s), connector_candidates=${candidates.length}; selected=${firstCandidate}; hm_comms_rows=${nativeCommsRows}.`,
    why_interesting: 'Mira can now see local message pressure and calendar/message shape before asking James to hand-summarize obligations or threads.',
    hypothesis,
    suggested_question: suggestedQuestion,
    possible_action: possibleAction,
    route_hint: 'builder',
    sensitivity_hint: 'calendar_message_metadata_only',
    calendar_artifact_count: calendarCount,
    message_artifact_count: messageCount,
    calendar_first_start: result.calendar_first_start || null,
    calendar_last_start: result.calendar_last_start || null,
    connector_candidates: candidates,
    selected_connector_candidate: selectedConnector,
    native_comms_metadata: nativeCommsMetadata,
    no_mutation_performed: true,
  };
}

function buildParallelScoutFollowthroughPlan(context = {}) {
  const defaultSources = [
    'runtime_comms',
    'memory_broker',
    'environment_apps',
    'work_continuation',
    'browser_history',
    'email',
  ];
  const requested = asArray(context.parallelScoutSources || context.recommendedScoutSources || context.burstSources)
    .map(trimText)
    .filter((source) => (
      source
      && source !== 'cheap_parallel_scouts'
      && CURIOSITY_BURST_DEFAULT_SOURCES.includes(source)
    ));
  const candidateSources = Array.from(new Set(requested.length > 0 ? requested : defaultSources)).slice(0, 8);
  return {
    plan_kind: 'reviewed_parallel_curiosity_burst',
    cadence: 'quiet_interval',
    candidate_sources: candidateSources,
    max_sources: candidateSources.length,
    command_harness: `node ui/scripts/hm-mira-self-direction.js curiosity-burst --source ${candidateSources.join(',')} --route-interesting --no-dispatch`,
    followup_rule: 'Route the strongest internal follow-up only if the burst changes a decision; otherwise record a no-op outcome so Mira advances.',
    route_strongest_internal_followup: true,
    dispatch_performed: false,
    schedule_created: false,
    schedule_run_performed: false,
    external_send_performed: false,
  };
}

function cheapParallelScoutsCuriosityAdapter(context = {}) {
  const plan = buildParallelScoutFollowthroughPlan(context);
  const sourceText = plan.candidate_sources.join(', ');
  return {
    source: 'cheap_parallel_scouts',
    scope: 'parallel_curiosity_execution',
    adapter_id: 'parallel_scout_curiosity',
    integration_strategy: 'native_adapter',
    status: 'active',
    observation: `Curiosity burst has a reviewed read-only source mix ready: ${sourceText}.`,
    why_interesting: 'This gives Mira initiative during quiet intervals without waiting for one giant prompt or a single serial scout.',
    hypothesis: 'Cheap bursts surface routeable questions fastest when comms, unified memory, environment, work continuation, browser, and email signals are inspected together.',
    suggested_question: `Should Mira run the reviewed curiosity-burst source mix (${sourceText}) during the next quiet interval?`,
    possible_action: `Run ${plan.command_harness}; then route only the strongest changed-decision follow-up or record a no-op outcome.`,
    route_hint: 'builder',
    sensitivity_hint: 'local_runtime_planning',
    parallel_scout_plan: plan,
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
    environment_memory_counts: result.memory_counts || null,
    environment_memory_repair_state: result.memory_repair_state || null,
    environment_memory_review_only: result.memory_review_only === true,
    environment_memory_review_queue: result.memory_review_queue || null,
    environment_bridge_connection: bridgeConnection || null,
    no_mutation_performed: true,
  };
}

function defaultCuriosityAdapters() {
  return [
    gitStatusCuriosityAdapter,
    runtimeQueueCuriosityAdapter,
    recentCommsCuriosityAdapter,
    activeMemoryCuriosityAdapter,
    activeMemoryBrokerCuriosityAdapter,
    activeBrowserHistoryCuriosityAdapter,
    activeEmailCuriosityAdapter,
    activeWebResearchCuriosityAdapter,
    activeVisualAssetCuriosityAdapter,
    activeCalendarMessageCuriosityAdapter,
    activeEnvironmentCuriosityAdapter,
    activeAutomationSchedulerCuriosityAdapter,
    activeWorkContinuationCuriosityAdapter,
    activeMiraRuntimeCuriosityAdapter,
  ];
}

function buildAccelerationCuriosityItems(context) {
  const parallelScoutPlan = buildParallelScoutFollowthroughPlan(context);
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
      suggested_question: 'Which active or adapter-ready source/action arm should Mira connect next: unified memory broker, scheduler workflow, work continuation, environment state, or visual assets?',
      possible_action: 'Use the source/action substrate plan to pick and route the next concrete adapter, starting with memory broker or scheduled curiosity.',
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
      possible_action: `Run ${parallelScoutPlan.command_harness}; then route only the strongest changed-decision follow-up or record a no-op outcome.`,
      route_hint: 'builder',
      sensitivity_hint: 'local_runtime_planning',
      parallel_scout_plan: parallelScoutPlan,
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
    memoryBrokerCuriosityReader: options.memoryBrokerCuriosityReader,
    memoryBrokerCuriosityQuery: options.memoryBrokerCuriosityQuery,
    memoryBrokerLimit: options.memoryBrokerLimit,
    memoryBrokerProviderLimit: options.memoryBrokerProviderLimit,
    memoryBrokerTimeoutMs: options.memoryBrokerTimeoutMs,
    memoryBrokerStorePreflight: options.memoryBrokerStorePreflight,
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
    schedulerCuriosityReader: options.schedulerCuriosityReader,
    schedulerStatePaths: options.schedulerStatePaths,
    schedulerLimit: options.schedulerLimit,
    workContinuationCuriosityReader: options.workContinuationCuriosityReader,
    workContinuationQueuePath: options.workContinuationQueuePath,
    workContinuationWakeTrigger: options.workContinuationWakeTrigger,
    workContinuationStaleAfterMs: options.workContinuationStaleAfterMs,
    miraRuntimeCuriosityReader: options.miraRuntimeCuriosityReader,
    calendarMessageCuriosityReader: options.calendarMessageCuriosityReader,
    calendarMessageRoots: options.calendarMessageRoots,
    calendarMessageLimit: options.calendarMessageLimit,
    calendarMessageMaxBytes: options.calendarMessageMaxBytes,
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
  'memory_broker',
  'browser_history',
  'email',
  'web_research',
  'images_screenshots_assets',
  'calendar_messages',
  'environment_apps',
  'cheap_parallel_scouts',
  'automation_scheduler',
  'work_continuation',
  'mira_runtime',
]);

function normalizeCuriosityBurstSources(payload = {}, options = {}) {
  const raw = payload.sources || payload.source || options.sources || options.source || CURIOSITY_BURST_DEFAULT_SOURCES;
  const allowed = new Set(CURIOSITY_BURST_DEFAULT_SOURCES);
  const values = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((item) => trimText(item))
    .filter((item) => allowed.has(item));
  const unique = Array.from(new Set(values));
  const maxSources = Math.max(1, Math.min(14, Number(payload.maxSources || options.maxSources || 14) || 14));
  return (unique.length > 0 ? unique : [...CURIOSITY_BURST_DEFAULT_SOURCES]).slice(0, maxSources);
}

function curiosityBurstAdaptersForSource(source) {
  if (source === 'repo_files') return [gitStatusCuriosityAdapter];
  if (source === 'runtime_comms') return [runtimeQueueCuriosityAdapter, recentCommsCuriosityAdapter];
  if (source === 'memory') return [activeMemoryCuriosityAdapter];
  if (source === 'memory_broker') return [activeMemoryBrokerCuriosityAdapter];
  if (source === 'browser_history') return [activeBrowserHistoryCuriosityAdapter];
  if (source === 'email') return [activeEmailCuriosityAdapter];
  if (source === 'web_research') return [activeWebResearchCuriosityAdapter];
  if (source === 'images_screenshots_assets') return [activeVisualAssetCuriosityAdapter];
  if (source === 'calendar_messages') return [activeCalendarMessageCuriosityAdapter];
  if (source === 'environment_apps') return [activeEnvironmentCuriosityAdapter];
  if (source === 'cheap_parallel_scouts') return [cheapParallelScoutsCuriosityAdapter];
  if (source === 'automation_scheduler') return [activeAutomationSchedulerCuriosityAdapter];
  if (source === 'work_continuation') return [activeWorkContinuationCuriosityAdapter];
  if (source === 'mira_runtime') return [activeMiraRuntimeCuriosityAdapter];
  return [];
}

function curiosityBurstSemanticKeyForItem(item = {}) {
  const plan = ACTIVE_INITIATIVE_SOURCE_PLAN[trimText(item.source)] || null;
  if (!plan) return null;
  return activeInitiativeSemanticKey({
    initiative_kind: plan.initiative_kind,
    item,
  });
}

function normalizedCuriosityRouteText(value, max = 320) {
  return oneLine(value, max).toLowerCase();
}

function curiosityBurstTopResultIdForItem(item = {}) {
  const source = trimText(item.source);
  if (source === 'memory_broker') {
    const top = item.memory_broker_top_result || {};
    return trimText(top.id || top.ref || top.title || top.sourceKind || top.source) || null;
  }
  if (source === 'memory') {
    const top = item.memory_top_result || {};
    return trimText(top.nodeId || top.node_id || top.title || top.heading) || null;
  }
  return null;
}

function curiosityBurstRouteDedupeKey(route = {}) {
  const payload = {
    target_role: trimText(route.target_role),
    source: trimText(route.source),
    adapter_id: trimText(route.adapter_id),
    top_result_id: trimText(route.top_result_id),
    suggested_question: normalizedCuriosityRouteText(route.suggested_question),
    possible_action: normalizedCuriosityRouteText(route.possible_action),
  };
  return stableHash(payload);
}

function workContinuationHasActionableSignal(item = {}) {
  return Boolean(
    numberSignal(item.work_due_count) > 0
    || numberSignal(item.work_stale_count) > 0
    || numberSignal(item.work_carried_count) > 0
    || numberSignal(item.work_approval_required_count) > 0
    || numberSignal(item.work_held_count) > 0
    || trimText(item.work_next_task_id)
  );
}

function curiosityBurstRouteForItems(items = [], options = {}) {
  const priority = {
    automation_scheduler: 96,
    cheap_parallel_scouts: 88,
    memory_broker: 77,
    memory: 76,
    browser_history: 74,
    email: 73,
    web_research: 72,
    images_screenshots_assets: 71,
    calendar_messages: 70,
    environment_apps: 70,
    work_continuation: 69,
    mira_runtime: 68,
    runtime_comms: 64,
    repo_files: 42,
  };
  const generatedAt = trimText(options.generatedAt || options.generated_at) || new Date().toISOString();
  const projectRoot = trimText(options.projectRoot || options.project_root) || null;
  const outcomeCooldownMs = Math.max(0, Math.min(
    7 * 24 * 60 * 60 * 1000,
    Number(options.outcomeCooldownMs || options.outcome_cooldown_ms || 24 * 60 * 60 * 1000) || 0
  ));
  const recentOutcomes = projectRoot && outcomeCooldownMs > 0
    ? recentImplementedActiveInitiativeOutcomes(activeInitiativeOutcomesPath(projectRoot), generatedAt, outcomeCooldownMs)
    : new Map();
  const allCandidates = items
    .filter((item) => item && ['active', 'adapter_not_built_yet'].includes(item.status))
    .filter((item) => !(trimText(item.source) === 'work_continuation' && !workContinuationHasActionableSignal(item)))
    .filter((item) => trimText(item.suggested_question) && trimText(item.possible_action))
    .map((item, index) => {
      const semanticKey = curiosityBurstSemanticKeyForItem(item);
      const recentOutcome = semanticKey ? recentOutcomes.get(semanticKey) || null : null;
      return {
        item,
        semantic_key: semanticKey,
        recent_outcome: recentOutcome,
        score: (priority[item.source] || 20)
          + (item.status === 'adapter_not_built_yet' ? 8 : 2)
          + Math.min(4, index),
      };
    })
    .sort((left, right) => right.score - left.score);
  const suppressedCandidates = allCandidates.filter((candidate) => candidate.recent_outcome);
  const candidates = allCandidates.filter((candidate) => !candidate.recent_outcome);
  if (candidates.length === 0) {
    return {
      decision: 'no_route',
      target_role: null,
      reason: suppressedCandidates.length > 0
        ? 'burst_candidates_suppressed_by_recent_outcomes'
        : 'burst_found_no_actionable_internal_item',
      suppressed_candidate_count: suppressedCandidates.length,
      internal_only: true,
      external_send_performed: false,
    };
  }
  const selected = candidates[0].item;
  const targetRole = normalizeDirectRouteTarget(selected.route_hint || selected.routeHint) || 'architect';
  const topResultId = curiosityBurstTopResultIdForItem(selected);
  const routeBase = {
    target_role: targetRole,
    source: selected.source,
    adapter_id: selected.adapter_id,
    top_result_id: topResultId,
    suggested_question: selected.suggested_question,
    possible_action: selected.possible_action,
  };
  return {
    decision: 'route_selected',
    target_role: targetRole,
    source: selected.source,
    adapter_id: selected.adapter_id,
    top_result_id: topResultId,
    status: selected.status,
    suggested_question: selected.suggested_question,
    possible_action: selected.possible_action,
    reason: selected.source === 'automation_scheduler'
      ? 'scheduled curiosity is the next useful way to make bursts recur without James hand-running them'
      : 'burst selected the strongest internal follow-up from bounded read-only scout results',
    route_dedupe_key: curiosityBurstRouteDedupeKey(routeBase),
    apply_now: options.applyNow === true || options.apply_now === true,
    suppressed_candidate_count: suppressedCandidates.length,
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
    `apply_now=${route.apply_now === true ? 'true' : 'false'}`,
    'external_send_performed=false',
  ].join('\n');
}

function curiosityBurstRouteMessageHash(message) {
  const text = trimText(message);
  return text ? stableHash(text) : null;
}

function curiosityBurstRouteDedupeCooldownMs(payload = {}, options = {}) {
  return Math.max(0, Math.min(
    7 * 24 * 60 * 60 * 1000,
    Number(
      payload.routeDedupeCooldownMs
      || payload.route_dedupe_cooldown_ms
      || options.routeDedupeCooldownMs
      || options.route_dedupe_cooldown_ms
      || 24 * 60 * 60 * 1000
    ) || 0
  ));
}

function curiosityBurstRouteDedupEnabled(payload = {}, options = {}) {
  return payload.force !== true
    && options.force !== true
    && payload.dedupe !== false
    && options.dedupe !== false
    && curiosityBurstRouteDedupeCooldownMs(payload, options) > 0;
}

function curiosityBurstNoopRouteEligible(route = {}) {
  return route
    && route.decision === 'route_selected'
    && route.apply_now !== true
    && trimText(route.source) === 'memory_broker'
    && trimText(route.adapter_id) === 'unified_memory_broker_curiosity'
    && AGENT_ROLES.includes(trimText(route.target_role));
}

function loggedCuriosityBurstRouteHash(row = {}) {
  return trimText(row.route_message_hash || row.route_output?.route_message_hash)
    || curiosityBurstRouteMessageHash(row.route_message);
}

function recentMatchingCuriosityBurstNoopRoute(logPath, route, generatedAt, routeMessageHash, cooldownMs) {
  if (!logPath || !routeMessageHash) return null;
  const nowMs = parseTimestampMs(generatedAt) ?? Date.now();
  const rows = readJsonl(logPath).slice(-500).reverse();
  for (const row of rows) {
    if (!row || row.schema !== MIRA_CURIOSITY_BURST_SCHEMA) continue;
    const rowRoute = row.route_output || {};
    if (trimText(rowRoute.decision) !== 'route_selected') continue;
    if (rowRoute.apply_now === true || /(?:^|\n)apply_now=true(?:\n|$)/i.test(trimText(row.route_message))) continue;
    const rowMs = parseTimestampMs(row.generated_at);
    if (rowMs === null || nowMs - rowMs > cooldownMs) continue;
    if (trimText(rowRoute.target_role) !== trimText(route.target_role)) continue;
    if (trimText(rowRoute.source) !== trimText(route.source)) continue;
    if (trimText(rowRoute.adapter_id) !== trimText(route.adapter_id)) continue;
    const dispatchStatus = trimText(row.dispatch?.status);
    if (dispatchStatus !== 'sent') continue;
    const rowDedupeKey = trimText(rowRoute.route_dedupe_key);
    const routeDedupeKey = trimText(route.route_dedupe_key);
    if (rowDedupeKey && routeDedupeKey && rowDedupeKey !== routeDedupeKey) continue;
    if (loggedCuriosityBurstRouteHash(row) !== routeMessageHash) continue;
    return {
      burst_id: row.burst_id || null,
      generated_at: row.generated_at || null,
      target_role: rowRoute.target_role || null,
      source: rowRoute.source || null,
      adapter_id: rowRoute.adapter_id || null,
      top_result_id: rowRoute.top_result_id || null,
      route_message_hash: routeMessageHash,
      route_dedupe_key: route.route_dedupe_key || null,
      dispatch_status: dispatchStatus || null,
    };
  }
  return null;
}

function curiosityBurstAlreadyRoutedSuppression(burst = {}, payload = {}, options = {}) {
  const route = burst.route_output || {};
  if (!curiosityBurstNoopRouteEligible(route)) return null;
  if (!curiosityBurstRouteDedupEnabled(payload, options)) return null;
  const routeMessageHash = curiosityBurstRouteMessageHash(burst.route_message);
  const cooldownMs = curiosityBurstRouteDedupeCooldownMs(payload, options);
  const previousRoute = recentMatchingCuriosityBurstNoopRoute(
    burst.burst_log_path,
    route,
    burst.generated_at,
    routeMessageHash,
    cooldownMs,
  );
  if (!previousRoute) return null;
  return {
    reason: 'already_routed',
    route_message_hash: routeMessageHash,
    route_dedupe_key: route.route_dedupe_key || null,
    duplicate_cooldown_ms: cooldownMs,
    previous_route: previousRoute,
  };
}

async function runMiraCuriosityBurst(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const sources = normalizeCuriosityBurstSources(payload, options);
  const applyNow = payload.apply_now === true
    || payload.applyNow === true
    || options.apply_now === true
    || options.applyNow === true;
  const curiosityLogPath = curiosityItemsPath(projectRoot);
  const burstLogPath = curiosityBurstsPath(projectRoot);
  const context = {
    projectRoot,
    generatedAt,
    repoStatusText: options.repoStatusText,
    recentCommsText: options.recentCommsText,
    memoryCuriosityReader: options.memoryCuriosityReader,
    memoryCuriosityQuery: options.memoryCuriosityQuery,
    memoryBrokerCuriosityReader: options.memoryBrokerCuriosityReader,
    memoryBrokerCuriosityQuery: options.memoryBrokerCuriosityQuery,
    memoryBrokerLimit: options.memoryBrokerLimit,
    memoryBrokerProviderLimit: options.memoryBrokerProviderLimit,
    memoryBrokerTimeoutMs: options.memoryBrokerTimeoutMs,
    memoryBrokerStorePreflight: options.memoryBrokerStorePreflight,
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
    schedulerCuriosityReader: options.schedulerCuriosityReader,
    schedulerStatePaths: options.schedulerStatePaths,
    schedulerLimit: options.schedulerLimit,
    workContinuationCuriosityReader: options.workContinuationCuriosityReader,
    workContinuationQueuePath: options.workContinuationQueuePath,
    workContinuationWakeTrigger: options.workContinuationWakeTrigger,
    workContinuationStaleAfterMs: options.workContinuationStaleAfterMs,
    miraRuntimeCuriosityReader: options.miraRuntimeCuriosityReader,
    calendarMessageCuriosityReader: options.calendarMessageCuriosityReader,
    calendarMessageRoots: options.calendarMessageRoots,
    calendarMessageLimit: options.calendarMessageLimit,
    calendarMessageMaxBytes: options.calendarMessageMaxBytes,
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
    route_output: curiosityBurstRouteForItems(items, { projectRoot, generatedAt, applyNow }),
    route_message: null,
    route_message_hash: null,
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
  burst.route_message_hash = curiosityBurstRouteMessageHash(burst.route_message);
  if (burst.route_output?.decision === 'route_selected') {
    burst.route_output = {
      ...burst.route_output,
      route_message_hash: burst.route_message_hash,
    };
  }
  const routeInteresting = payload.routeInteresting || options.routeInteresting;
  const dispatchWanted = routeInteresting && payload.dispatch !== false && options.dispatch !== false;
  const alreadyRouted = dispatchWanted
    ? curiosityBurstAlreadyRoutedSuppression(burst, payload, options)
    : null;
  if (alreadyRouted) {
    burst.route_output = {
      ...burst.route_output,
      decision: 'already_routed',
      original_decision: 'route_selected',
      reason: 'unchanged_apply_now_false_memory_broker_route_already_routed',
      already_routed: true,
      suppression: alreadyRouted,
      route_message_hash: alreadyRouted.route_message_hash,
    };
    burst.dispatch = {
      status: 'not_sent',
      target: burst.route_output.target_role,
      internal_only: true,
      reason: 'already_routed',
      suppression: alreadyRouted,
    };
  }
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
  memory_broker: {
    priority: 90,
    active_priority: 55,
    target_role: 'builder',
    reason: 'unified memory broker turns fragmented recall stores into one ranked action source',
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
    active_priority: 34,
    target_role: 'builder',
    reason: 'scheduler curiosity turns quiet-interval intent into recurring inspection',
  },
  work_continuation: {
    priority: 64,
    active_priority: 33,
    target_role: 'builder',
    reason: 'work continuation curiosity needs a background routing seam',
  },
  mira_runtime: {
    priority: 62,
    active_priority: 35,
    target_role: 'builder',
    reason: 'Mira runtime growth loops need native adapter wiring',
  },
  calendar_messages: {
    priority: 60,
    active_priority: 32,
    target_role: 'builder',
    reason: 'calendar and message curiosity needs connector shape mapping after native sources are active',
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

const ACTIVE_INITIATIVE_SOURCE_PLAN = Object.freeze({
  mira_runtime: {
    priority: 116,
    target_role: 'builder',
    initiative_kind: 'runtime_gap_repair',
    reason: 'Mira runtime health is the highest leverage signal once the basic senses are active',
  },
  work_continuation: {
    priority: 112,
    target_role: 'builder',
    initiative_kind: 'resume_owned_work',
    reason: 'unfinished owned work should beat opening a fresh lane when it is due or stale',
  },
  environment_apps: {
    priority: 106,
    target_role: 'builder',
    initiative_kind: 'environment_drift_repair',
    reason: 'environment drift can poison later autonomy if Mira ignores it',
  },
  automation_scheduler: {
    priority: 96,
    target_role: 'builder',
    initiative_kind: 'scheduler_followthrough',
    reason: 'scheduled curiosity is the path from one-off initiative to repeated initiative',
  },
  implementation_outcomes: {
    priority: 86,
    target_role: 'builder',
    initiative_kind: 'fitness_loop_followthrough',
    reason: 'implemented outcomes are the fitness data Mira needs to compound useful behavior',
  },
  reflexion_lessons: {
    priority: 84,
    target_role: 'oracle',
    initiative_kind: 'lesson_reuse',
    reason: 'review lessons should shape the next route instead of sitting inert',
  },
  voyager_curriculum: {
    priority: 82,
    target_role: 'architect',
    initiative_kind: 'skill_practice',
    reason: 'successful loops should become reusable skills Mira can practice and promote',
  },
  memory_broker: {
    priority: 80,
    target_role: 'builder',
    initiative_kind: 'unified_memory_recall_practice',
    reason: 'unified memory recall should ground the next move across vector, graph, and episodic stores',
  },
  memory: {
    priority: 78,
    target_role: 'builder',
    initiative_kind: 'active_memory_use',
    reason: 'memory retrieval should ground the next move before James has to restate context',
  },
  calendar_messages: {
    priority: 72,
    target_role: 'builder',
    initiative_kind: 'calendar_message_connector_next',
    reason: 'calendar/message metadata can expose obligations and thread pressure',
  },
  email: {
    priority: 70,
    target_role: 'builder',
    initiative_kind: 'email_pressure_followup',
    reason: 'mailbox metadata can reveal attention pressure without reading message bodies',
  },
  browser_history: {
    priority: 68,
    target_role: 'oracle',
    initiative_kind: 'browser_trail_investigation',
    reason: 'browser trails can reveal current research context James did not spell out',
  },
  web_research: {
    priority: 66,
    target_role: 'oracle',
    initiative_kind: 'research_trail_investigation',
    reason: 'saved research trails can seed the next concrete investigation',
  },
  images_screenshots_assets: {
    priority: 64,
    target_role: 'builder',
    initiative_kind: 'visual_context_followup',
    reason: 'visual metadata can reveal UI or asset work that needs inspection',
  },
  code_mode_exploration: {
    priority: 58,
    target_role: 'builder',
    initiative_kind: 'read_only_code_exploitation',
    reason: 'code-mode is the fallback active sense for inspecting fresh runtime evidence',
  },
  source_action_substrate: {
    priority: 56,
    target_role: 'architect',
    initiative_kind: 'substrate_next_probe',
    reason: 'the source/action map should choose a concrete probe when no sharper live signal wins',
  },
  cheap_parallel_scouts: {
    priority: 54,
    target_role: 'builder',
    initiative_kind: 'parallel_scout_followup',
    reason: 'bounded scout bursts keep curiosity moving without a giant serial pass',
  },
  runtime_comms: {
    priority: 48,
    target_role: 'architect',
    initiative_kind: 'comms_pressure_followup',
    reason: 'recent comms can expose repeated friction or an unclosed route',
  },
  repo_files: {
    priority: 42,
    target_role: 'builder',
    initiative_kind: 'repo_state_followup',
    reason: 'repo state is weaker than runtime gaps but can still expose unfinished work',
  },
});

function numberSignal(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function curiosityStatusCounts(items = []) {
  return items.reduce((acc, item) => {
    const status = normalizeCuriosityStatus(item?.status);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {
    active: 0,
    adapter_not_built_yet: 0,
    unavailable_in_this_runtime: 0,
  });
}

function schedulerReviewedCuriosityBurstPlan(item = {}) {
  const candidateSources = [
    'runtime_comms',
    'memory_broker',
    'environment_apps',
    'work_continuation',
    'browser_history',
    'email',
  ];
  return {
    proposal_kind: 'reviewed_recurring_curiosity_burst',
    cadence: 'quiet_interval',
    review_owner: 'architect',
    review_required_before_schedule_creation: true,
    candidate_sources: candidateSources,
    command_harness: `node ui/scripts/hm-mira-self-direction.js curiosity-burst --source ${candidateSources.join(',')} --route-interesting --no-dispatch`,
    followup_code_mode_practice_step: 'Use hm-mira-self-direction code-mode separately when the reviewed burst output needs deeper local JSONL/source inspection.',
    trigger_basis: 'no_active_scheduler_entries',
    schedule_count: numberSignal(item.scheduler_schedule_count),
    active_count: numberSignal(item.scheduler_active_count),
    due_soon_count: numberSignal(item.scheduler_due_soon_count),
    overdue_count: numberSignal(item.scheduler_overdue_count),
    schedule_created: false,
    schedule_updated: false,
    schedule_deleted: false,
    schedule_run_performed: false,
  };
}

const MIRA_QUIET_CURIOSITY_SCHEDULE_ID = 'mira-quiet-curiosity-burst-v1';
const MIRA_QUIET_CURIOSITY_SCHEDULE_NAME = 'Mira quiet curiosity burst';
const MIRA_QUIET_CURIOSITY_DEFAULT_INTERVAL_MS = 45 * 60 * 1000;
const MIRA_QUIET_CURIOSITY_MIN_INTERVAL_MS = 15 * 60 * 1000;
const MIRA_QUIET_CURIOSITY_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIRA_QUIET_CURIOSITY_DEFAULT_SOURCES = Object.freeze([
  'runtime_comms',
  'memory_broker',
  'environment_apps',
  'work_continuation',
  'browser_history',
  'email',
]);

function quietCuriosityScheduleLogPath(projectRoot) {
  return path.join(projectRoot, '.squidrun', 'runtime', 'mira-quiet-curiosity-schedules.jsonl');
}

function normalizeQuietCuriositySources(payload = {}, options = {}) {
  const raw = payload.sources || payload.source || options.sources || options.source || MIRA_QUIET_CURIOSITY_DEFAULT_SOURCES;
  const allowed = new Set(CURIOSITY_BURST_DEFAULT_SOURCES);
  const blocked = new Set(['automation_scheduler', 'cheap_parallel_scouts']);
  const values = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((item) => trimText(item))
    .filter((source) => allowed.has(source) && !blocked.has(source));
  const unique = Array.from(new Set(values));
  return (unique.length > 0 ? unique : [...MIRA_QUIET_CURIOSITY_DEFAULT_SOURCES]).slice(0, 8);
}

function normalizeQuietCuriosityIntervalMs(payload = {}, options = {}) {
  const rawMinutes = payload.intervalMinutes ?? payload.interval_minutes ?? options.intervalMinutes ?? options.interval_minutes;
  const rawMs = payload.intervalMs ?? payload.interval_ms ?? options.intervalMs ?? options.interval_ms;
  const requested = Number.isFinite(Number(rawMs))
    ? Number(rawMs)
    : Number(rawMinutes) * 60 * 1000;
  const intervalMs = Number.isFinite(requested) && requested > 0
    ? requested
    : MIRA_QUIET_CURIOSITY_DEFAULT_INTERVAL_MS;
  return Math.max(MIRA_QUIET_CURIOSITY_MIN_INTERVAL_MS, Math.min(MIRA_QUIET_CURIOSITY_MAX_INTERVAL_MS, Math.round(intervalMs)));
}

function quietCuriositySchedulerStatePath(projectRoot, payload = {}, options = {}) {
  const raw = trimText(
    payload.schedulerStatePath
    || payload.scheduleStatePath
    || options.schedulerStatePath
    || options.scheduleStatePath
  );
  if (raw) return path.resolve(projectRoot, raw);
  const paths = typeof defaultSchedulerStatePaths === 'function'
    ? defaultSchedulerStatePaths(projectRoot)
    : [path.join(projectRoot, '.squidrun', 'runtime', 'schedules.json')];
  return paths[0];
}

function readSchedulerStateForQuietCuriosity(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      ok: true,
      existed: false,
      state: { schedules: [], lastUpdated: null },
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const state = parsed && typeof parsed === 'object' ? parsed : {};
    return {
      ok: true,
      existed: true,
      state: {
        ...state,
        schedules: Array.isArray(state.schedules) ? state.schedules : [],
      },
    };
  } catch (err) {
    return {
      ok: false,
      existed: true,
      reason: 'scheduler_state_parse_error',
      error: err?.message || String(err),
      state: null,
    };
  }
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function quietCuriosityCommandHarness(sources) {
  return `node ui/scripts/hm-mira-self-direction.js curiosity-burst --source ${sources.join(',')} --route-interesting --json`;
}

function quietCuriosityScheduleInput(sources) {
  const command = quietCuriosityCommandHarness(sources);
  return [
    'Run Mira quiet curiosity burst and route only the strongest changed internal follow-up.',
    `Command: ${command}`,
    'If the burst reports no actionable route, record a no-op implemented outcome so Mira advances.',
    'Do not send external messages, read email bodies, mutate labels/calendars/schedules, deploy, trade, or perform customer/auth actions.',
  ].join(' ');
}

function buildQuietCuriositySchedulePayload({ sources, intervalMs, generatedAt }) {
  const generatedMs = Date.parse(generatedAt);
  const startMs = Number.isFinite(generatedMs) ? generatedMs : Date.now();
  const nextRun = new Date(startMs + intervalMs).toISOString();
  const command = quietCuriosityCommandHarness(sources);
  return {
    id: MIRA_QUIET_CURIOSITY_SCHEDULE_ID,
    name: MIRA_QUIET_CURIOSITY_SCHEDULE_NAME,
    type: 'interval',
    input: quietCuriosityScheduleInput(sources),
    taskType: 'mira-curiosity-burst',
    active: true,
    runAt: null,
    intervalMs,
    cron: null,
    timeZone: null,
    eventName: null,
    chainAfter: null,
    chainRequiresSuccess: true,
    lastRunAt: null,
    lastStatus: null,
    nextRun,
    history: [],
    createdAt: generatedAt,
    updatedAt: generatedAt,
    metadata: {
      owner: 'mira',
      schedule_kind: 'quiet_curiosity_burst',
      schema: MIRA_QUIET_CURIOSITY_SCHEDULE_SCHEMA,
      sources,
      command_harness: command,
      followup_rule: 'Route the strongest internal follow-up only if the burst changes a decision; otherwise record a no-op outcome.',
      internal_only: true,
      external_send_performed: false,
      body_read_required: false,
      destructive_action_performed: false,
    },
  };
}

function isQuietCuriositySchedule(schedule = {}) {
  const metadata = schedule.metadata || {};
  return (
    trimText(schedule.id) === MIRA_QUIET_CURIOSITY_SCHEDULE_ID
    || trimText(schedule.name) === MIRA_QUIET_CURIOSITY_SCHEDULE_NAME
    || trimText(metadata.schedule_kind) === 'quiet_curiosity_burst'
  );
}

function quietScheduleNeedsUpdate(existing = {}, next = {}) {
  const existingSources = asArray(existing.metadata?.sources).map(trimText).filter(Boolean).join(',');
  const nextSources = asArray(next.metadata?.sources).map(trimText).filter(Boolean).join(',');
  return (
    existing.active === false
    || trimText(existing.type) !== trimText(next.type)
    || trimText(existing.taskType) !== trimText(next.taskType)
    || Number(existing.intervalMs) !== Number(next.intervalMs)
    || trimText(existing.input) !== trimText(next.input)
    || existingSources !== nextSources
  );
}

function compactQuietCuriositySchedule(schedule = {}) {
  return {
    id: trimText(schedule.id) || null,
    name: oneLine(schedule.name, 120) || null,
    type: trimText(schedule.type) || null,
    active: schedule.active !== false,
    interval_minutes: Number.isFinite(Number(schedule.intervalMs))
      ? Math.round((Number(schedule.intervalMs) / 60000) * 100) / 100
      : null,
    next_run: trimText(schedule.nextRun) || null,
    task_type: trimText(schedule.taskType) || null,
    sources: asArray(schedule.metadata?.sources).map(trimText).filter(Boolean),
    command_harness: oneLine(schedule.metadata?.command_harness, 260) || null,
  };
}

async function ensureMiraQuietCuriositySchedule(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const sources = normalizeQuietCuriositySources(payload, options);
  const intervalMs = normalizeQuietCuriosityIntervalMs(payload, options);
  const install = payload.install === true || options.install === true;
  const runNow = payload.runNow === true || payload.run_now === true || options.runNow === true || options.run_now === true;
  const dispatch = payload.dispatch !== false && options.dispatch !== false;
  const schedulerStatePath = quietCuriositySchedulerStatePath(projectRoot, payload, options);
  const logPath = quietCuriosityScheduleLogPath(projectRoot);
  const read = readSchedulerStateForQuietCuriosity(schedulerStatePath);
  if (!read.ok) {
    const blocked = {
      schema: MIRA_QUIET_CURIOSITY_SCHEDULE_SCHEMA,
      ok: false,
      decision: 'blocked',
      reason: read.reason,
      error: read.error,
      generated_at: generatedAt,
      scheduler_state_path: schedulerStatePath,
      internal_only: true,
      external_send_performed: false,
      consequence_controls: {
        internal_only: true,
        schedule_created: false,
        schedule_updated: false,
        schedule_run_performed: false,
        external_send_performed: false,
        destructive_action_performed: false,
      },
    };
    appendJsonl(logPath, blocked);
    return blocked;
  }

  const state = read.state;
  const nextSchedule = buildQuietCuriositySchedulePayload({ sources, intervalMs, generatedAt });
  const schedules = asArray(state.schedules);
  const existingIndex = schedules.findIndex(isQuietCuriositySchedule);
  const existing = existingIndex >= 0 ? schedules[existingIndex] : null;
  let scheduleCreated = false;
  let scheduleUpdated = false;
  let duplicateSuppressed = false;
  let activeSchedule = existing || nextSchedule;

  if (install) {
    if (existing) {
      if (quietScheduleNeedsUpdate(existing, nextSchedule)) {
        activeSchedule = {
          ...existing,
          ...nextSchedule,
          id: trimText(existing.id) || nextSchedule.id,
          createdAt: existing.createdAt || nextSchedule.createdAt,
          history: asArray(existing.history),
          updatedAt: generatedAt,
        };
        schedules[existingIndex] = activeSchedule;
        scheduleUpdated = true;
      } else {
        activeSchedule = existing;
        duplicateSuppressed = true;
      }
    } else {
      schedules.push(nextSchedule);
      activeSchedule = nextSchedule;
      scheduleCreated = true;
    }
    state.schedules = schedules;
    state.lastUpdated = generatedAt;
    writeJsonAtomic(schedulerStatePath, state);
  }

  let burstResult = null;
  if (runNow) {
    const runner = typeof options.curiosityBurstRunner === 'function'
      ? options.curiosityBurstRunner
      : runMiraCuriosityBurst;
    burstResult = await runner({
      sources,
      routeInteresting: true,
      dispatch,
    }, {
      ...options,
      projectRoot,
      generatedAt,
      dispatch,
      routeInteresting: true,
    });
  }

  const decision = !install
    ? 'schedule_ready_for_install'
    : scheduleCreated
      ? 'schedule_installed'
      : scheduleUpdated
        ? 'schedule_updated'
        : 'schedule_already_active';
  const result = {
    schema: MIRA_QUIET_CURIOSITY_SCHEDULE_SCHEMA,
    ok: true,
    decision,
    generated_at: generatedAt,
    scheduler_state_path: schedulerStatePath,
    state_existed: read.existed,
    schedule_created: scheduleCreated,
    schedule_updated: scheduleUpdated,
    duplicate_suppressed: duplicateSuppressed,
    schedule_run_performed: runNow,
    route_dispatch_performed: Boolean(runNow && dispatch && burstResult?.dispatch?.status === 'sent'),
    interval_minutes: Math.round((intervalMs / 60000) * 100) / 100,
    sources,
    command_harness: quietCuriosityCommandHarness(sources),
    schedule: compactQuietCuriositySchedule(activeSchedule),
    burst_result: burstResult ? {
      decision: burstResult.decision,
      burst_id: burstResult.burst_id || null,
      route_decision: burstResult.route_output?.decision || null,
      route_source: burstResult.route_output?.source || null,
      route_adapter_id: burstResult.route_output?.adapter_id || null,
      dispatch_status: burstResult.dispatch?.status || null,
    } : null,
    schedule_log_path: logPath,
    internal_only: true,
    external_send_performed: false,
    consequence_controls: {
      internal_only: true,
      schedule_created: scheduleCreated,
      schedule_updated: scheduleUpdated,
      schedule_deleted: false,
      schedule_run_performed: runNow,
      curiosity_burst_run_performed: runNow,
      external_send_performed: false,
      destructive_action_performed: false,
      deploy_trade_customer_auth_action_performed: false,
    },
  };
  appendJsonl(logPath, result);
  return result;
}

function activeInitiativeEvidenceForItem(item = {}) {
  const evidence = [
    `source=${trimText(item.source)}/${trimText(item.adapter_id || item.adapterId)}`,
    `status=${normalizeCuriosityStatus(item.status)}`,
  ];
  const observation = oneLine(item.observation, 180);
  if (observation) evidence.push(`observation=${observation}`);
  if (numberSignal(item.runtime_blocked_count) > 0) {
    evidence.push(`runtime_blocked_modules=${asArray(item.runtime_blocked_modules).map(trimText).filter(Boolean).join(',')}`);
  }
  if (
    numberSignal(item.work_due_count) > 0
    || numberSignal(item.work_stale_count) > 0
    || numberSignal(item.work_carried_count) > 0
    || numberSignal(item.work_approval_required_count) > 0
    || numberSignal(item.work_held_count) > 0
    || trimText(item.work_next_task_id)
  ) {
    evidence.push(
      `work_due=${numberSignal(item.work_due_count)} stale=${numberSignal(item.work_stale_count)} `
      + `carried=${numberSignal(item.work_carried_count)} approval=${numberSignal(item.work_approval_required_count)} `
      + `held=${numberSignal(item.work_held_count)} next=${trimText(item.work_next_agent) || 'none'}/${trimText(item.work_next_task_id) || 'none'}`
    );
  }
  if (trimText(item.environment_memory_sync_status) || trimText(item.environment_bridge_connection)) {
    evidence.push(`environment=memory:${trimText(item.environment_memory_sync_status) || 'unknown'} bridge:${trimText(item.environment_bridge_connection) || 'unknown'}`);
  }
  if (item.environment_memory_counts && Object.keys(item.environment_memory_counts).length > 0) {
    const counts = item.environment_memory_counts;
    evidence.push(`memory_counts=missing:${counts.missing ?? 'unknown'} orphans:${counts.orphans ?? 'unknown'} duplicates:${counts.duplicates ?? 'unknown'}`);
  }
  if (trimText(item.environment_memory_repair_state)) {
    evidence.push(`memory_repair_state=${trimText(item.environment_memory_repair_state)}`);
  }
  if (item.environment_memory_review_queue && Object.keys(item.environment_memory_review_queue).length > 0) {
    const queue = item.environment_memory_review_queue;
    evidence.push(`memory_review_queue=orphans:${queue.orphans ?? 'unknown'} actions:${queue.actions ?? 'unknown'} skips:${queue.skips ?? 'unknown'}`);
  }
  if (numberSignal(item.scheduler_due_soon_count) > 0 || numberSignal(item.scheduler_overdue_count) > 0) {
    evidence.push(`scheduler=due_soon:${numberSignal(item.scheduler_due_soon_count)} overdue:${numberSignal(item.scheduler_overdue_count)}`);
  }
  if (trimText(item.source) === 'automation_scheduler') {
    evidence.push(`scheduler_state=schedules:${numberSignal(item.scheduler_schedule_count)} active:${numberSignal(item.scheduler_active_count)} due_soon:${numberSignal(item.scheduler_due_soon_count)} overdue:${numberSignal(item.scheduler_overdue_count)}`);
    const design = compactSchedulerFollowthroughDesign(item.scheduler_followthrough_design || item.schedulerFollowthroughDesign);
    if (design) {
      evidence.push(`scheduler_design_sources=${design.candidate_sources.join(',')}`);
      if (design.command_harness) evidence.push(`scheduler_design_command=${design.command_harness}`);
    }
    if (
      numberSignal(item.scheduler_schedule_count) === 0
      && numberSignal(item.scheduler_active_count) === 0
      && numberSignal(item.scheduler_due_soon_count) === 0
      && numberSignal(item.scheduler_overdue_count) === 0
    ) {
      evidence.push('scheduler_review_plan=quiet_interval_curiosity_burst review=architect before_schedule_creation=true schedule_mutation=false');
    }
  }
  if (trimText(item.source) === 'cheap_parallel_scouts') {
    const plan = compactParallelScoutPlan(item.parallel_scout_plan || item.parallelScoutPlan);
    if (plan) {
      evidence.push(`parallel_scout_sources=${plan.candidate_sources.join(',')}`);
      if (plan.command_harness) evidence.push(`parallel_scout_command=${plan.command_harness}`);
      if (plan.followup_rule) evidence.push(`parallel_scout_followup_rule=${plan.followup_rule}`);
    }
  }
  if (numberSignal(item.email_unread_total) > 0) evidence.push(`email_unread=${numberSignal(item.email_unread_total)}`);
  if (numberSignal(item.memory_result_count) > 0) {
    const top = item.memory_top_result || {};
    const topId = trimText(top.nodeId || top.node_id || top.title || top.heading || 'unknown');
    const topTitle = oneLine(top.title || top.heading || top.category, 80);
    const sourcePath = trimText(top.sourcePath || top.source_path);
    evidence.push(`memory_results=${numberSignal(item.memory_result_count)} top=${topId}${topTitle ? ` title=${topTitle}` : ''}${sourcePath ? ` source=${sourcePath}` : ''}`);
    const excerpt = oneLine(top.contentExcerpt || top.content_excerpt, 160);
    if (excerpt) evidence.push(`memory_excerpt=${excerpt}`);
  }
  if (numberSignal(item.memory_broker_result_count) > 0) {
    const top = item.memory_broker_top_result || {};
    const topId = trimText(top.id || top.ref || top.title || 'unknown');
    const topTitle = oneLine(top.title || top.ref || top.sourceKind, 80);
    const sourceKind = trimText(top.sourceKind || top.source_kind);
    evidence.push(`memory_broker_results=${numberSignal(item.memory_broker_result_count)} top=${topId}${topTitle ? ` title=${topTitle}` : ''}${sourceKind ? ` source_kind=${sourceKind}` : ''}`);
    const excerpt = oneLine(top.excerpt, 160);
    if (excerpt) evidence.push(`memory_broker_excerpt=${excerpt}`);
    const sourceText = asArray(item.memory_broker_sources)
      .map((entry) => `${trimText(entry.source || entry.sourceKind)}:${numberSignal(entry.itemCount ?? entry.item_count)}`)
      .filter((entry) => entry && !entry.startsWith(':'))
      .slice(0, 5)
      .join(',');
    if (sourceText) evidence.push(`memory_broker_sources=${sourceText}`);
  }
  if (item.email_snapshot_gaps?.thread_poor_snapshot) {
    evidence.push(`email_snapshot_gaps=sender_domain:${numberSignal(item.email_snapshot_gaps.missing_sender_domain_count)} subject:${numberSignal(item.email_snapshot_gaps.missing_subject_count)} timestamp:${numberSignal(item.email_snapshot_gaps.missing_timestamp_count)}`);
  }
  if (numberSignal(item.calendar_artifact_count) > 0 || numberSignal(item.message_artifact_count) > 0) {
    evidence.push(`calendar_messages=calendar:${numberSignal(item.calendar_artifact_count)} messages:${numberSignal(item.message_artifact_count)}`);
  }
  if (item.calendar_message_selected_connector?.candidate) {
    evidence.push(`calendar_message_seam=${trimText(item.calendar_message_selected_connector.candidate)} hm_comms_rows=${numberSignal(item.calendar_message_comms_metadata?.row_count)}`);
  }
  if (numberSignal(item.browser_result_count) > 0) evidence.push(`browser_results=${numberSignal(item.browser_result_count)}`);
  if (numberSignal(item.web_result_count) > 0) {
    evidence.push(`web_research_results=${numberSignal(item.web_result_count)}`);
    const artifact = item.web_top_artifact || {};
    const artifactLabel = oneLine(artifact.title || artifact.path, 100);
    if (artifactLabel) {
      const bucket = trimText(artifact.source_bucket);
      const artifactPath = oneLine(artifact.path, 120);
      evidence.push(`web_top_artifact=${artifactLabel}${artifactPath ? ` path=${artifactPath}` : ''}${bucket ? ` bucket=${bucket}` : ''}`);
    }
    const excerpt = oneLine(artifact.excerpt, 160);
    if (excerpt) evidence.push(`web_excerpt=${excerpt}`);
  }
  if (numberSignal(item.visual_asset_count) > 0) evidence.push(`visual_assets=${numberSignal(item.visual_asset_count)}`);
  if (item.visual_latest_asset_followup?.path) {
    const visual = item.visual_latest_asset_followup;
    const dimensions = visual.width && visual.height ? ` ${visual.width}x${visual.height}` : '';
    const aspect = visual.aspect_hint ? ` aspect=${oneLine(visual.aspect_hint, 60)}` : '';
    evidence.push(`visual_latest_asset=${oneLine(visual.path, 120)}${dimensions}${aspect}`);
    if (visual.visual_understanding_step?.status) {
      const step = visual.visual_understanding_step;
      evidence.push(
        `visual_understanding_step=${oneLine(step.status, 80)} `
        + `image_ocr_performed=${step.image_ocr_performed === true} `
        + `image_model_performed=${step.image_model_performed === true} `
        + `file_write_performed=${step.file_write_performed === true} `
        + `external_send_performed=${step.external_send_performed === true}`
      );
    }
  }
  return evidence.filter(Boolean).slice(0, 10);
}

function activeInitiativeFingerprint(source) {
  const selected = source?.selected_item || source?.item || source || {};
  const work = source?.work_order || source || {};
  const kind = trimText(source?.initiative_kind || source?.initiativeKind);
  const itemSource = trimText(selected.source);
  const adapterId = trimText(selected.adapter_id || selected.adapterId);
  const title = oneLine(work.title || source?.title || selected.suggested_question || selected.suggestedQuestion, 120).toLowerCase();
  return [kind, itemSource, adapterId, title].filter(Boolean).join(':');
}

function activeInitiativeSemanticKey(source) {
  const selected = source?.selected_item || source?.item || source || {};
  const kind = trimText(source?.initiative_kind || source?.initiativeKind);
  const itemSource = trimText(selected.source || source?.source);
  const adapterId = trimText(selected.adapter_id || selected.adapterId || source?.adapter_id || source?.adapterId);
  return [kind, itemSource, adapterId].filter(Boolean).join(':');
}

function recentActiveInitiativeFingerprints(logPath, generatedAt, cooldownMs) {
  const nowMs = parseTimestampMs(generatedAt) ?? Date.now();
  const fingerprints = new Map();
  const rows = readJsonl(logPath).slice(-120);
  for (const row of rows) {
    if (!row || row.schema !== MIRA_ACTIVE_INITIATIVE_SCHEMA || row.decision !== 'routed') continue;
    const rowMs = parseTimestampMs(row.generated_at);
    if (rowMs === null || nowMs - rowMs > cooldownMs) continue;
    const dispatchStatus = trimText(row.dispatch?.status);
    if (dispatchStatus !== 'sent') continue;
    const fingerprint = activeInitiativeFingerprint(row);
    if (!fingerprint) continue;
    fingerprints.set(fingerprint, {
      initiative_id: row.initiative_id || null,
      generated_at: row.generated_at || null,
      target_role: row.target_role || null,
      initiative_kind: row.initiative_kind || null,
      source: row.selected_item?.source || null,
      adapter_id: row.selected_item?.adapter_id || null,
      title: row.work_order?.title || null,
      dispatch_status: dispatchStatus || null,
    });
  }
  return fingerprints;
}

function recentImplementedActiveInitiativeOutcomes(outcomePath, generatedAt, cooldownMs) {
  const nowMs = parseTimestampMs(generatedAt) ?? Date.now();
  const outcomes = new Map();
  const rows = readJsonl(outcomePath).slice(-240);
  for (const row of rows) {
    if (!row || row.schema !== MIRA_ACTIVE_INITIATIVE_OUTCOME_SCHEMA) continue;
    const status = normalizeActiveInitiativeOutcomeStatus(row.outcome_status);
    if (!['implemented', 'false_positive'].includes(status)) continue;
    const rowMs = parseTimestampMs(row.generated_at);
    if (rowMs === null || nowMs - rowMs > cooldownMs) continue;
    const semanticKey = activeInitiativeSemanticKey(row);
    if (!semanticKey) continue;
    outcomes.set(semanticKey, {
      outcome_id: row.outcome_id || null,
      initiative_id: row.initiative_id || null,
      generated_at: row.generated_at || null,
      outcome_status: status,
      target_role: row.target_role || null,
      initiative_kind: row.initiative_kind || null,
      source: row.source || null,
      adapter_id: row.adapter_id || null,
      evidence: asArray(row.evidence).slice(0, 6),
      note: row.note || null,
    });
  }
  return outcomes;
}

function activeInitiativeSuppressionForCandidate(candidate, recentInitiatives, recentOutcomes) {
  if (!candidate) return null;
  if (recentOutcomes.has(candidate.semantic_key)) {
    return {
      reason: 'recent_implemented_active_initiative_outcome',
      initiative: null,
      outcome: recentOutcomes.get(candidate.semantic_key) || null,
    };
  }
  if (recentInitiatives.has(candidate.fingerprint)) {
    return {
      reason: 'recent_duplicate_active_initiative',
      initiative: recentInitiatives.get(candidate.fingerprint) || null,
      outcome: null,
    };
  }
  return null;
}

function activeInitiativeCandidateForItem(item, index, total) {
  if (!item || typeof item !== 'object') return null;
  if (normalizeCuriosityStatus(item.status) !== 'active') return null;
  const source = trimText(item.source);
  const plan = ACTIVE_INITIATIVE_SOURCE_PLAN[source];
  if (!plan) return null;
  let score = plan.priority;
  let targetRole = normalizeDirectRouteTarget(plan.target_role) || 'builder';
  let initiativeKind = plan.initiative_kind;
  let reason = plan.reason;
  let title = oneLine(item.suggested_question || `Use ${source} for the next internal initiative.`, 160);
  let action = oneLine(item.possible_action || 'Route the next internal follow-up from this active signal.', 220);
  let reviewedRecurringBurstPlan = null;
  const modules = asArray(item.runtime_blocked_modules).map(trimText).filter(Boolean);

  if (source === 'runtime_comms') {
    if (trimText(item.adapter_id) === 'recent_comms' && item.recent_comms_actionable !== true) return null;
    if (trimText(item.adapter_id) === 'self_direction_queue' && numberSignal(item.self_direction_pending_count) <= 0) return null;
  } else if (source === 'mira_runtime') {
    const blocked = numberSignal(item.runtime_blocked_count);
    if (blocked > 0) {
      score += 36 + Math.min(12, blocked * 4);
      title = `Repair Mira runtime gaps: ${modules.join(', ') || `${blocked} blocked module(s)`}`;
      action = 'Have Builder inspect the runtime health reader and patch the smallest module/evidence gap that keeps Mira self-evolution unhealthy.';
    } else if (item.runtime_healthy === false) {
      score += 18;
      title = 'Repair Mira runtime health before the next autonomy expansion.';
    } else {
      score -= 44;
    }
  } else if (source === 'work_continuation') {
    if (workContinuationHasActionableSignal(item)) {
      const due = numberSignal(item.work_due_count);
      const stale = numberSignal(item.work_stale_count);
      const carried = numberSignal(item.work_carried_count);
      const approval = numberSignal(item.work_approval_required_count);
      const held = numberSignal(item.work_held_count);
      const nextTaskId = trimText(item.work_next_task_id);
      score += 28 + Math.min(12, due * 3 + stale + carried + approval * 2 + held);
      const nextAgent = normalizeDirectRouteTarget(item.work_next_agent) || null;
      if (nextAgent && AGENT_ROLES.includes(nextAgent)) targetRole = nextAgent;
      title = nextTaskId
        ? `Resume owned work ${trimText(item.work_next_agent) || 'agent'}/${nextTaskId}`
        : `Resolve owned-work due=${due} stale=${stale} carried=${carried} approval=${approval} held=${held}`;
      action = 'Route the next dispatch-ready continuation internally before opening a new capability lane.';
    } else {
      return null;
    }
  } else if (source === 'environment_apps') {
    const label = trimText(item.environment_overall_label).toUpperCase();
    const scoreValue = item.environment_overall_score;
    const memory = trimText(item.environment_memory_sync_status);
    const bridge = trimText(item.environment_bridge_connection);
    const memoryCounts = item.environment_memory_counts || {};
    const memoryRepairState = trimText(item.environment_memory_repair_state);
    const reviewQueue = item.environment_memory_review_queue || {};
    const memoryReviewOnly = item.environment_memory_review_only === true || memoryRepairState === 'review_queue_only';
    const memoryNeedsRepair = Boolean(memory && !memoryReviewOnly && !/^(ok|synced|clean|in_sync|synced\s+\(in sync\))$/i.test(memory));
    const bridgeNeedsRepair = Boolean(bridge && !/^(connected|disabled|not_required)$/i.test(bridge));
    const bridgePendingLiveDiscovery = /^pending_live_discovery$/i.test(bridge);
    if (item.environment_snapshot_stale === true) score += 16;
    if (label && label !== 'OK') score += 16;
    if (Number.isFinite(Number(scoreValue)) && Number(scoreValue) < 95) score += 8;
    if (memoryNeedsRepair) score += 18;
    if (memoryReviewOnly) score += 10;
    if (bridgeNeedsRepair) score += 12;
    if (score > plan.priority) {
      if (memoryReviewOnly && !bridgeNeedsRepair && label === 'OK') {
        initiativeKind = 'memory_review_queue_triage';
        targetRole = 'oracle';
        reason = 'memory drift is now a review/migration queue, not an automatic repair target';
        title = `Triage memory review queue: orphans=${reviewQueue.orphans ?? memoryCounts.orphans ?? 'unknown'} actions=${reviewQueue.actions ?? 'unknown'}`;
        action = 'Have Oracle inspect the memory review/migration queue and identify whether a mapping plan, skip confirmation, or no-op closure is the right next move.';
      } else if (memoryReviewOnly && bridgePendingLiveDiscovery && label === 'OK') {
        initiativeKind = 'bridge_live_discovery_refresh';
        reason = 'memory review-only residue is closed for automatic repair, leaving bridge live discovery as the environment signal';
        title = 'Refresh bridge live discovery signal: pending_live_discovery';
        action = 'Have Builder verify or refresh the bridge live-discovery signal without reopening the already manual memory orphan queue.';
      } else if (memoryNeedsRepair && !bridgeNeedsRepair && label === 'OK') {
        initiativeKind = 'memory_consistency_repair';
        reason = 'memory consistency drift is the live environment signal still requiring repair';
        title = `Repair memory consistency drift: missing=${memoryCounts.missing ?? 'unknown'} orphans=${memoryCounts.orphans ?? 'unknown'}`;
        action = 'Have Builder inspect the memory consistency drift and choose the smallest repair path for missing/orphaned knowledge coverage.';
      } else {
        title = `Repair environment drift: memory=${memory || 'unknown'} bridge=${bridge || 'unknown'}`;
        action = 'Have Builder refresh or repair the local health/memory/bridge signal that can mislead later routes.';
      }
    } else {
      score -= 24;
    }
  } else if (source === 'automation_scheduler') {
    const scheduleCount = numberSignal(item.scheduler_schedule_count);
    const activeCount = numberSignal(item.scheduler_active_count);
    const dueSoon = numberSignal(item.scheduler_due_soon_count);
    const overdue = numberSignal(item.scheduler_overdue_count);
    if (dueSoon > 0 || overdue > 0) {
      initiativeKind = 'quiet_curiosity_schedule_monitor';
      reason = 'an active curiosity schedule is now present, so the next scheduler work is proving the operational cadence instead of redesigning it';
      score += 18 + overdue * 4 + dueSoon * 2;
      title = `Verify quiet curiosity scheduler cadence: due_soon=${dueSoon} overdue=${overdue}`;
      action = 'Have Builder verify the active Mira quiet-curiosity schedule is picked up by the running scheduler and records its next automatic burst/history without creating duplicates, sending externally, or mutating calendars/email.';
    } else if (scheduleCount === 0 && activeCount === 0) {
      initiativeKind = 'quiet_curiosity_schedule_install';
      reason = 'an empty scheduler should become an actual reviewed quiet-curiosity cadence, not another inert design';
      score += 8;
      reviewedRecurringBurstPlan = compactSchedulerFollowthroughDesign(item.scheduler_followthrough_design)
        || schedulerReviewedCuriosityBurstPlan(item);
      title = 'Install reviewed quiet-interval curiosity burst for the empty scheduler.';
      action = 'Have Builder stage or install the reviewed recurring curiosity-burst design using runtime_comms, memory_broker, environment_apps, work_continuation, browser_history, and email metadata; keep schedule creation explicit and duplicate-protected.';
    } else {
      score -= 18;
    }
  } else if (source === 'cheap_parallel_scouts') {
    const plan = compactParallelScoutPlan(item.parallel_scout_plan || item.parallelScoutPlan)
      || buildParallelScoutFollowthroughPlan();
    if (plan && plan.candidate_sources.length > 0) {
      score += 10 + Math.min(8, plan.candidate_sources.length);
      title = `Run reviewed curiosity-burst mix: ${plan.candidate_sources.join(', ')}.`;
      action = `${plan.command_harness}; ${plan.followup_rule || 'route the strongest internal follow-up if it changes a decision.'}`;
    } else {
      score -= 18;
    }
  } else if (source === 'memory_broker') {
    const brokerResults = numberSignal(item.memory_broker_result_count);
    const top = item.memory_broker_top_result || {};
    const topId = trimText(top.id || top.ref || top.title);
    const topLabel = oneLine(top.title || top.ref || top.sourceKind || topId, 96);
    if (brokerResults > 0 && topId) {
      score += 20 + Math.min(10, brokerResults);
      title = `Practice unified recall broker on ${topLabel || topId}.`;
      action = 'Use hm-memory-broker recall output as ranked context before routing the next Mira improvement; compare vector, graph, and episodic contributors and record whether it changed the decision.';
    } else {
      score -= 22;
    }
  } else if (source === 'memory') {
    const memoryResults = numberSignal(item.memory_result_count);
    const top = item.memory_top_result || {};
    const topId = trimText(top.nodeId || top.node_id || top.title || top.heading);
    const topLabel = oneLine(top.title || top.heading || top.category || topId, 96);
    if (memoryResults > 0 && topId) {
      score += 18 + Math.min(8, memoryResults);
      title = `Use active memory result ${topId} before routing the next Mira improvement.`;
      action = `Compare compact memory evidence (${topLabel || topId}) against current curiosity/curriculum candidates and route only the decision it actually changes.`;
    } else {
      score -= 24;
    }
  } else if (source === 'email') {
    const unread = numberSignal(item.email_unread_total);
    if (unread > 0) {
      score += Math.min(18, Math.ceil(unread / 10));
      const gaps = item.email_snapshot_gaps || {};
      const query = asArray(item.email_suggested_next_snapshot_queries)[0]?.query;
      title = gaps.thread_poor_snapshot
        ? `Sharpen email pressure metadata: unread=${unread} gaps=sender_domain/subject/timestamp`
        : `Inspect email pressure metadata: unread=${unread}`;
      action = query
        ? `Use metadata-only email snapshot query "${query}" to pick a thread-pressure question without reading bodies, sending mail, or mutating labels.`
        : 'Use mailbox metadata to pick a thread-pressure question without reading bodies or sending mail.';
    }
  } else if (source === 'calendar_messages') {
    const artifacts = numberSignal(item.calendar_artifact_count) + numberSignal(item.message_artifact_count);
    const connectors = asArray(item.calendar_message_connector_candidates).length;
    const selectedSeam = trimText(item.calendar_message_selected_connector?.candidate);
    const hmCommsRows = numberSignal(item.calendar_message_comms_metadata?.row_count);
    if (artifacts > 0 || connectors > 0) {
      score += Math.min(18, artifacts * 2 + connectors * 3 + Math.min(6, hmCommsRows));
      if (selectedSeam === 'native_squidrun_comms') {
        title = `Use native SquidRun comms as the calendar/message seam from ${artifacts} artifact(s) and ${hmCommsRows} recent row(s).`;
        action = 'Have Builder wire compact hm-comms sender/target/status/timestamp metadata into the calendar/message curiosity path without exporting bodies, sending messages, or mutating calendars.';
      } else {
        title = `Choose the next calendar/message seam from ${artifacts} artifact(s) and ${connectors} connector candidate(s).`;
      }
    }
  } else if (source === 'browser_history') {
    score += Math.min(10, numberSignal(item.browser_result_count));
  } else if (source === 'web_research') {
    score += Math.min(10, numberSignal(item.web_result_count));
    const artifact = item.web_top_artifact || {};
    const artifactLabel = oneLine(artifact.title || artifact.path, 100);
    if (artifactLabel) {
      const artifactPath = oneLine(artifact.path, 120);
      const excerpt = oneLine(artifact.excerpt, 150);
      score += 8;
      title = `Investigate saved research artifact: ${artifactLabel}`;
      action = `Use compact artifact metadata${artifactPath ? ` from ${artifactPath}` : ''}${excerpt ? `: ${excerpt}` : ''}; keep this read-only and do not perform live network fetches or expose raw query strings.`;
    }
  } else if (source === 'images_screenshots_assets') {
    score += Math.min(10, numberSignal(item.visual_asset_count));
    const followup = item.visual_latest_asset_followup || {};
    const followupPath = oneLine(followup.path, 120);
    const followupQuestion = oneLine(followup.suggested_question, 160);
    const followupAction = oneLine(followup.possible_action, 220);
    if (followupPath || followupQuestion || followupAction) {
      score += 8;
      title = followupQuestion || `Inspect latest visual asset metadata: ${followupPath}`;
      action = followupAction || 'Use compact visual metadata first; route a separate visual-understanding step only if the decision depends on visible content.';
    }
  }

  const recencyWeight = Math.min(6, Math.max(0, index - Math.max(0, total - 6)));
  return {
    item,
    target_role: targetRole,
    initiative_kind: initiativeKind,
    title,
    action,
    success_metric: 'The target agent reports a concrete patch, proof, or rejected-with-evidence outcome that can be recorded back into Mira outcomes.',
    score: score + recencyWeight,
    reason,
    evidence: activeInitiativeEvidenceForItem(item),
    reviewed_recurring_burst_plan: reviewedRecurringBurstPlan,
    fingerprint: activeInitiativeFingerprint({
      initiative_kind: initiativeKind,
      item,
      title,
    }),
    semantic_key: activeInitiativeSemanticKey({
      initiative_kind: initiativeKind,
      item,
    }),
  };
}

function buildActiveInitiativeMessage(initiative) {
  if (!initiative || initiative.decision !== 'routed') return '';
  const selected = initiative.selected_item || {};
  const work = initiative.work_order || {};
  return [
    '(MIRA ACTIVE INITIATIVE): I used the active curiosity signals to pick the next internal job.',
    `target=${initiative.target_role}`,
    `initiative=${initiative.initiative_kind}`,
    `source=${selected.source}/${selected.adapter_id}`,
    `job=${work.title}`,
    `action=${work.action}`,
    `success_metric=${work.success_metric}`,
    `evidence=${(initiative.evidence || []).join(' | ')}`,
    `initiative_log=${initiative.active_initiative_log_path}`,
    'apply_now=false',
    'external_send_performed=false',
  ].join('\n');
}

async function selectMiraActiveInitiative(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const logPath = activeInitiativesPath(projectRoot);
  if (payload.runScout || options.runScout) {
    runMiraCuriosityScout({ generatedAt }, { ...options, projectRoot, generatedAt });
  }
  const allItems = readJsonl(curiosityItemsPath(projectRoot))
    .filter((item) => item && item.schema === MIRA_CURIOSITY_ITEM_SCHEMA);
  const windowSize = Math.max(24, Math.min(1000, Number(payload.itemLimit || payload.item_limit || options.itemLimit || 360) || 360));
  const cooldownMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(payload.cooldownMs || payload.cooldown_ms || options.cooldownMs || 45 * 60 * 1000) || 0));
  const outcomeCooldownMs = Math.max(cooldownMs, Math.min(7 * 24 * 60 * 60 * 1000, Number(payload.outcomeCooldownMs || payload.outcome_cooldown_ms || options.outcomeCooldownMs || 24 * 60 * 60 * 1000) || 0));
  const suppressDuplicates = payload.force !== true
    && options.force !== true
    && payload.dedupe !== false
    && options.dedupe !== false
    && cooldownMs > 0;
  const recentInitiatives = suppressDuplicates
    ? recentActiveInitiativeFingerprints(logPath, generatedAt, cooldownMs)
    : new Map();
  const recentOutcomes = suppressDuplicates
    ? recentImplementedActiveInitiativeOutcomes(activeInitiativeOutcomesPath(projectRoot), generatedAt, outcomeCooldownMs)
    : new Map();
  const recentItems = latestCuriosityItemsByAdapter(allItems.slice(-windowSize));
  const statusCounts = curiosityStatusCounts(recentItems);
  const allCandidates = recentItems
    .map((item, index) => activeInitiativeCandidateForItem(item, index, recentItems.length))
    .filter(Boolean)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return trimText(right.item.generated_at).localeCompare(trimText(left.item.generated_at));
    });
  const suppressedCandidates = allCandidates
    .filter((candidate) => activeInitiativeSuppressionForCandidate(candidate, recentInitiatives, recentOutcomes));
  const candidates = allCandidates
    .filter((candidate) => !activeInitiativeSuppressionForCandidate(candidate, recentInitiatives, recentOutcomes));

  if (candidates.length === 0) {
    if (suppressedCandidates.length > 1) {
      const topSuppressed = suppressedCandidates[0];
      const suppression = activeInitiativeSuppressionForCandidate(topSuppressed, recentInitiatives, recentOutcomes) || {};
      const noInitiative = {
        schema: MIRA_ACTIVE_INITIATIVE_SCHEMA,
        ok: true,
        decision: 'no_initiative',
        generated_at: generatedAt,
        initiative_id: `mira-active-initiative:${stableHash({
          generatedAt,
          reason: 'all_candidates_recently_closed',
          suppressed: suppressedCandidates.map((candidate) => candidate.semantic_key || candidate.fingerprint).slice(0, 12),
        }).slice(0, 16)}`,
        reason: 'all_candidates_recently_closed',
        active_initiative_log_path: logPath,
        curiosity_log_path: curiosityItemsPath(projectRoot),
        curiosity_items_seen: allItems.length,
        latest_adapter_count: recentItems.length,
        current_state: statusCounts,
        duplicate_cooldown_ms: cooldownMs,
        outcome_cooldown_ms: outcomeCooldownMs,
        suppressed_candidate_count: suppressedCandidates.length,
        top_suppressed_candidate: topSuppressed ? {
          reason: suppression.reason || null,
          fingerprint: topSuppressed.fingerprint || null,
          semantic_key: topSuppressed.semantic_key || null,
          target_role: topSuppressed.target_role || null,
          initiative_kind: topSuppressed.initiative_kind || null,
          source: topSuppressed.item?.source || null,
          adapter_id: topSuppressed.item?.adapter_id || null,
          recent_matching_initiative: suppression.initiative || null,
          recent_matching_outcome: suppression.outcome || null,
        } : null,
        target_role: null,
        selected_item: null,
        dispatch: {
          status: 'not_sent',
          reason: 'all_candidates_recently_closed',
        },
        applied: false,
        internal_only: true,
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
      appendJsonl(logPath, noInitiative);
      return noInitiative;
    }
    if (suppressedCandidates.length > 0) {
      const suppressed = suppressedCandidates[0];
      const suppression = activeInitiativeSuppressionForCandidate(suppressed, recentInitiatives, recentOutcomes) || {};
      const recent = suppression.initiative || null;
      const recentOutcome = suppression.outcome || null;
      const reason = suppression.reason || 'recent_duplicate_active_initiative';
      const dispatchReason = reason === 'recent_duplicate_active_initiative'
        ? 'duplicate_recent_active_initiative'
        : reason;
      const held = {
        schema: MIRA_ACTIVE_INITIATIVE_SCHEMA,
        ok: true,
        decision: 'duplicate_suppressed',
        generated_at: generatedAt,
        initiative_id: `mira-active-initiative:${stableHash({
          generatedAt,
          reason,
          fingerprint: suppressed.fingerprint,
          semanticKey: suppressed.semantic_key,
        }).slice(0, 16)}`,
        reason,
        active_initiative_log_path: logPath,
        curiosity_log_path: curiosityItemsPath(projectRoot),
        curiosity_items_seen: allItems.length,
        latest_adapter_count: recentItems.length,
        current_state: statusCounts,
        duplicate_cooldown_ms: cooldownMs,
        outcome_cooldown_ms: outcomeCooldownMs,
        suppressed_fingerprint: suppressed.fingerprint,
        suppressed_semantic_key: suppressed.semantic_key,
        recent_matching_initiative: recent,
        recent_matching_outcome: recentOutcome,
        target_role: suppressed.target_role,
        selected_item: {
          item_id: suppressed.item.item_id,
          source: suppressed.item.source,
          adapter_id: suppressed.item.adapter_id,
          status: suppressed.item.status,
        },
        dispatch: {
          status: 'not_sent',
          reason: dispatchReason,
          target: suppressed.target_role,
        },
        applied: false,
        internal_only: true,
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
      appendJsonl(logPath, held);
      return held;
    }
    const noInitiative = {
      schema: MIRA_ACTIVE_INITIATIVE_SCHEMA,
      ok: true,
      decision: 'no_initiative',
      generated_at: generatedAt,
      initiative_id: `mira-active-initiative:${stableHash({ generatedAt, reason: 'no_active_curiosity_items' }).slice(0, 16)}`,
      reason: 'no_active_curiosity_items',
      active_initiative_log_path: logPath,
      curiosity_log_path: curiosityItemsPath(projectRoot),
      curiosity_items_seen: allItems.length,
      latest_adapter_count: recentItems.length,
      current_state: statusCounts,
      target_role: null,
      selected_item: null,
      dispatch: {
        status: 'not_sent',
        reason: 'no_initiative',
      },
      applied: false,
      internal_only: true,
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
    appendJsonl(logPath, noInitiative);
    return noInitiative;
  }

  const selected = candidates[0];
  const item = selected.item;
  const initiative = {
    schema: MIRA_ACTIVE_INITIATIVE_SCHEMA,
    ok: true,
    decision: 'routed',
    generated_at: generatedAt,
    initiative_id: `mira-active-initiative:${stableHash({
      generatedAt,
      item_id: item.item_id,
      initiative_kind: selected.initiative_kind,
      target_role: selected.target_role,
    }).slice(0, 16)}`,
    selected_by: 'mira',
    lane: 'active_sense_exploitation',
    phase: statusCounts.adapter_not_built_yet === 0
      ? 'all_basic_senses_active'
      : 'active_signal_wins_despite_remaining_foundation_gap',
    reason: selected.reason,
    target_role: selected.target_role,
    initiative_kind: selected.initiative_kind,
    fingerprint: selected.fingerprint,
    score: selected.score,
    candidate_count: candidates.length,
    suppressed_candidate_count: suppressedCandidates.length,
    duplicate_cooldown_ms: cooldownMs,
    active_initiative_log_path: logPath,
    curiosity_log_path: curiosityItemsPath(projectRoot),
    curiosity_items_seen: allItems.length,
    latest_adapter_count: recentItems.length,
    current_state: statusCounts,
    selected_item: {
      item_id: item.item_id,
      source: item.source,
      adapter_id: item.adapter_id,
      status: item.status,
      suggested_question: item.suggested_question,
      possible_action: item.possible_action,
      sensitivity_hint: item.sensitivity_hint,
    },
    work_order: {
      title: selected.title,
      action: selected.action,
      success_metric: selected.success_metric,
      reviewed_recurring_burst_plan: selected.reviewed_recurring_burst_plan || undefined,
    },
    evidence: selected.evidence,
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
  initiative.route_message = buildActiveInitiativeMessage(initiative);

  const dispatchWanted = payload.dispatch !== false && options.dispatch !== false;
  if (dispatchWanted && typeof options.sendAgentMessage === 'function' && AGENT_ROLES.includes(selected.target_role)) {
    const dispatchResult = await options.sendAgentMessage(selected.target_role, initiative.route_message);
    initiative.dispatch = {
      status: 'sent',
      target: selected.target_role,
      internal_only: true,
      result: dispatchResult || null,
    };
  } else if (dispatchWanted && !AGENT_ROLES.includes(selected.target_role)) {
    initiative.dispatch = {
      status: 'not_sent',
      target: selected.target_role,
      internal_only: true,
      reason: 'target_is_internal_lab_not_hm_role',
    };
  }

  appendJsonl(logPath, initiative);
  return initiative;
}

function normalizeActiveInitiativeOutcomeStatus(value) {
  const status = trimText(value).toLowerCase().replace(/[-\s]+/g, '_');
  return MIRA_ACTIVE_INITIATIVE_OUTCOME_STATUSES.includes(status) ? status : null;
}

function recordMiraActiveInitiativeOutcome(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const initiativePath = activeInitiativesPath(projectRoot);
  const outcomePath = activeInitiativeOutcomesPath(projectRoot);
  const initiativeId = trimText(payload.initiativeId || payload.initiative_id);
  const outcomeStatus = normalizeActiveInitiativeOutcomeStatus(payload.status || payload.outcome || payload.outcome_status);
  if (!initiativeId || !outcomeStatus) {
    return {
      schema: MIRA_ACTIVE_INITIATIVE_OUTCOME_SCHEMA,
      ok: false,
      decision: 'blocked',
      reason: !initiativeId ? 'missing_initiative_id' : 'unsupported_outcome_status',
      outcome_path: outcomePath,
    };
  }
  const initiatives = readJsonl(initiativePath);
  const initiative = initiatives.find((entry) => entry && entry.initiative_id === initiativeId);
  if (!initiative) {
    return {
      schema: MIRA_ACTIVE_INITIATIVE_OUTCOME_SCHEMA,
      ok: false,
      decision: 'blocked',
      reason: 'initiative_not_found',
      outcome_path: outcomePath,
    };
  }
  const selected = initiative.selected_item || {};
  const evidence = asArray(payload.evidence || payload.evidence_refs || payload.evidenceRefs)
    .map((item) => trimText(item))
    .filter(Boolean)
    .slice(0, 10);
  const note = trimText(payload.note || payload.outcome_note || payload.review_note) || null;
  const recordedBy = normalizeRequesterPane(payload.recordedBy || payload.recorded_by || 'architect') || 'architect';
  const entry = {
    schema: MIRA_ACTIVE_INITIATIVE_OUTCOME_SCHEMA,
    outcome_id: `mira-active-initiative-outcome:${stableHash({
      generatedAt,
      initiativeId,
      outcomeStatus,
      evidence,
      note,
    }).slice(0, 16)}`,
    generated_at: generatedAt,
    initiative_id: initiativeId,
    outcome_status: outcomeStatus,
    recorded_by: recordedBy,
    target_role: initiative.target_role || null,
    initiative_kind: initiative.initiative_kind || null,
    fingerprint: initiative.fingerprint || activeInitiativeFingerprint(initiative),
    source: selected.source || null,
    adapter_id: selected.adapter_id || null,
    work_order: initiative.work_order || null,
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
    schema: MIRA_ACTIVE_INITIATIVE_OUTCOME_SCHEMA,
    ok: true,
    decision: 'outcome_recorded',
    outcome_id: entry.outcome_id,
    initiative_id: initiativeId,
    outcome_status: outcomeStatus,
    outcome: entry,
    outcome_path: outcomePath,
    applied: false,
    no_mutation_performed: true,
    consequence_controls: entry.consequence_controls,
  };
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
    readTextTail(relativePath) {
      const resolved = assertAllowed(relativePath);
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) throw new Error('read_target_not_file');
      const bytes = Math.min(stat.size, maxReadBytes);
      const start = Math.max(0, stat.size - bytes);
      const handle = fs.openSync(resolved, 'r');
      try {
        const buffer = Buffer.alloc(bytes);
        const read = fs.readSync(handle, buffer, 0, bytes, start);
        return buffer.slice(0, read).toString('utf8');
      } finally {
        fs.closeSync(handle);
      }
    },
    readJsonl(relativePath, limit = 50) {
      const text = this.readTextTail(relativePath);
      const lines = text.split(/\r?\n/);
      const startsMidLine = text && !/^\s*[{[]/.test(lines[0] || '');
      return lines
        .map((line, index) => ({ line: line.trim(), line_number: startsMidLine ? null : index + 1 }))
        .filter((entry, index) => !(startsMidLine && index === 0))
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

function compactReflexionLessonsForTypedReply(reflexionLessons = []) {
  const rawLessons = Array.isArray(reflexionLessons)
    ? reflexionLessons
    : (Array.isArray(reflexionLessons.lessons) ? reflexionLessons.lessons : []);
  const compact = [];
  for (const lesson of rawLessons) {
    if (!lesson || typeof lesson !== 'object') continue;
    const category = trimText(lesson.category || lesson.outcome_status || lesson.outcomeStatus).toLowerCase();
    const rejected = lesson.rejected === true
      || lesson.false_positive === true
      || category.includes('rejected')
      || category.includes('false_positive')
      || category.includes('failed')
      || category.includes('not_implemented')
      || category.includes('needs_followup');
    const implemented = lesson.implemented === true
      || lesson.outcome_status === 'implemented'
      || category.includes('successful_implementation')
      || category === 'implemented'
      || category.endsWith('_implemented');
    if (rejected || !implemented) continue;
    const lessonText = oneLine(lesson.desired_change || lesson.lesson || lesson.summary, 220);
    const nextBehavior = oneLine(lesson.next_behavior || lesson.nextBehavior || lesson.practice_next, 220);
    if (!lessonText && !nextBehavior) continue;
    compact.push({
      proposal_id: oneLine(lesson.proposal_id || lesson.proposalId, 96) || null,
      category: category || 'implemented',
      lesson: lessonText,
      next_behavior: nextBehavior,
    });
    if (compact.length >= 3) break;
  }
  return compact;
}

function buildTypedReplyReflexionLessonContext(payload = {}, options = {}) {
  const explicit = payload.reflexionLessons
    || payload.reflexion_lessons
    || options.reflexionLessons
    || options.reflexion_lessons;
  if (explicit !== undefined && explicit !== null) {
    return compactReflexionLessonsForTypedReply(explicit);
  }
  try {
    const reflexion = extractMiraReflexionLessons({
      generatedAt: options.generatedAt,
    }, {
      projectRoot: options.projectRoot,
      generatedAt: options.generatedAt,
    });
    return compactReflexionLessonsForTypedReply(reflexion.lessons || []);
  } catch (_err) {
    return [];
  }
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
  const reflexionLessonsForEngine = buildTypedReplyReflexionLessonContext(payload, {
    ...options,
    projectRoot,
    generatedAt,
  });
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
  if (reflexionLessonsForEngine.length > 0) {
    enginePayload.reflexionLessons = reflexionLessonsForEngine;
  }
  let surfaceResult;
  let surfaceError = null;
  try {
    surfaceResult = await buildMiraLocalTextUiSurface(enginePayload, {
      projectRoot,
      env: options.env,
      modelAttachment: options.modelAttachment,
      fetchImpl: options.fetchImpl,
      contractBundle: options.contractBundle,
      sendAgentMessage: options.sendAgentMessage,
      runLocalCheck: options.runLocalCheck,
      stageProposal: options.stageProposal,
      stageProposalPreview: options.stageProposalPreview,
      allowDurableCapabilityWrites: options.allowDurableCapabilityWrites === true,
      commsMetadataReader: options.commsMetadataReader,
      memoryBrokerRecall: options.memoryBrokerRecall,
      readMemory: options.readMemory,
      memoryDbPath: options.memoryDbPath,
      evidenceLedgerDbPath: options.evidenceLedgerDbPath,
      internalMessageTarget: options.internalMessageTarget,
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
    skill_id: `mira-skill:${stableHash({
      sourceKind,
      skillName,
      key: raw.source_key || raw.proposal_id || raw.initiative_id || raw.outcome_id || raw.route_id || raw.burst_id,
    }).slice(0, 16)}`,
    skill_name: skillName,
    source_kind: sourceKind,
    source_key: trimText(raw.source_key || raw.proposal_id || raw.initiative_id || raw.outcome_id || raw.route_id || raw.burst_id || skillName) || skillName,
    status: trimText(raw.status || 'ready_to_practice') || 'ready_to_practice',
    proposal_id: trimText(raw.proposal_id) || null,
    initiative_id: trimText(raw.initiative_id) || null,
    outcome_id: trimText(raw.outcome_id) || null,
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

function curriculumSourceAdapterKey(source, adapterId) {
  const sourceText = trimText(source);
  const adapterText = canonicalCuriosityAdapterId({ source: sourceText, adapter_id: adapterId });
  if (!sourceText || !adapterText) return null;
  return `${sourceText}:${adapterText}`;
}

function mergeCurriculumCandidate(map, raw) {
  const candidate = buildCurriculumCandidate(raw);
  const key = `${candidate.source_kind}:${candidate.source || ''}:${candidate.adapter_id || ''}:${candidate.skill_name}`;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, candidate);
    return candidate;
  }
  existing.times_observed += candidate.times_observed;
  existing.evidence = curriculumEvidenceList(existing.evidence, candidate.evidence);
  existing.next_behavior = existing.next_behavior || candidate.next_behavior;
  existing.practice_trigger = existing.practice_trigger || candidate.practice_trigger;
  return existing;
}

function mergeStalePatternIntoActiveOutcome(activeCandidate, raw = {}) {
  if (!activeCandidate) return false;
  activeCandidate.times_observed += Math.max(1, Number(raw.times_observed || 1) || 1);
  activeCandidate.evidence = curriculumEvidenceList(activeCandidate.evidence, raw.evidence, raw.route_id, raw.burst_id, raw.item_id);
  return true;
}

const NEGATIVE_ACTIVE_INITIATIVE_OUTCOME_STATUSES = new Set(['false_positive', 'not_implemented', 'needs_followup']);

function activeInitiativeOutcomeCurriculumKeys(outcome = {}, initiativesById = new Map()) {
  const initiativeId = trimText(outcome.initiative_id);
  const initiative = initiativesById.get(initiativeId) || {};
  const selected = initiative.selected_item || {};
  const source = trimText(outcome.source || selected.source);
  const adapterId = trimText(outcome.adapter_id || selected.adapter_id || selected.adapterId);
  const initiativeKind = trimText(outcome.initiative_kind || initiative.initiative_kind);
  return {
    initiative_id: initiativeId || null,
    semantic_key: activeInitiativeSemanticKey({
      initiative_kind: initiativeKind,
      source,
      adapter_id: adapterId,
    }),
    source_adapter_key: curriculumSourceAdapterKey(source, adapterId),
  };
}

function activeInitiativeOutcomeEntry(outcome = {}, initiativesById = new Map()) {
  const status = normalizeActiveInitiativeOutcomeStatus(outcome.outcome_status || outcome.status);
  if (!status) return null;
  return {
    outcome,
    status,
    outcome_id: trimText(outcome.outcome_id),
    generated_at: trimText(outcome.generated_at),
    generated_ms: parseTimestampMs(outcome.generated_at),
    keys: activeInitiativeOutcomeCurriculumKeys(outcome, initiativesById),
  };
}

function isSameOrLaterActiveInitiativeOutcome(entry, outcome = {}) {
  if (!entry || !outcome) return false;
  const outcomeId = trimText(outcome.outcome_id);
  if (entry.outcome_id && outcomeId && entry.outcome_id === outcomeId) return false;
  const outcomeMs = parseTimestampMs(outcome.generated_at);
  if (entry.generated_ms !== null && outcomeMs !== null) return entry.generated_ms >= outcomeMs;
  const outcomeGeneratedAt = trimText(outcome.generated_at);
  if (entry.generated_at && outcomeGeneratedAt) return entry.generated_at >= outcomeGeneratedAt;
  return true;
}

function newerActiveInitiativeOutcomeEntry(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.generated_ms !== null && right.generated_ms !== null) {
    if (right.generated_ms !== left.generated_ms) return right.generated_ms > left.generated_ms ? right : left;
  } else if (left.generated_at && right.generated_at && right.generated_at !== left.generated_at) {
    return right.generated_at > left.generated_at ? right : left;
  }
  return (right.outcome_id || '').localeCompare(left.outcome_id || '') > 0 ? right : left;
}

function buildActiveInitiativeOutcomeCurriculumIndex(outcomes = [], initiativesById = new Map()) {
  const latestByInitiative = new Map();
  const latestBySemantic = new Map();
  const latestBySourceAdapter = new Map();
  for (const outcome of outcomes) {
    if (!outcome || outcome.schema !== MIRA_ACTIVE_INITIATIVE_OUTCOME_SCHEMA) continue;
    const entry = activeInitiativeOutcomeEntry(outcome, initiativesById);
    if (!entry) continue;
    if (entry.keys.initiative_id) {
      latestByInitiative.set(
        entry.keys.initiative_id,
        newerActiveInitiativeOutcomeEntry(latestByInitiative.get(entry.keys.initiative_id), entry),
      );
    }
    if (entry.keys.semantic_key) {
      latestBySemantic.set(
        entry.keys.semantic_key,
        newerActiveInitiativeOutcomeEntry(latestBySemantic.get(entry.keys.semantic_key), entry),
      );
    }
    if (entry.keys.source_adapter_key) {
      latestBySourceAdapter.set(
        entry.keys.source_adapter_key,
        newerActiveInitiativeOutcomeEntry(latestBySourceAdapter.get(entry.keys.source_adapter_key), entry),
      );
    }
  }
  const negativeSourceAdapterKeys = new Set();
  for (const [key, entry] of latestBySourceAdapter.entries()) {
    if (NEGATIVE_ACTIVE_INITIATIVE_OUTCOME_STATUSES.has(entry.status)) negativeSourceAdapterKeys.add(key);
  }
  return {
    negativeSourceAdapterKeys,
    suppressesImplementedOutcome(outcome = {}) {
      const keys = activeInitiativeOutcomeCurriculumKeys(outcome, initiativesById);
      const latestEntries = [
        keys.initiative_id ? latestByInitiative.get(keys.initiative_id) : null,
        keys.semantic_key ? latestBySemantic.get(keys.semantic_key) : null,
      ].filter(Boolean);
      return latestEntries.some((entry) => (
        NEGATIVE_ACTIVE_INITIATIVE_OUTCOME_STATUSES.has(entry.status)
        && isSameOrLaterActiveInitiativeOutcome(entry, outcome)
      ));
    },
  };
}

function codeModeRunEvidence(run = {}) {
  const evidence = [
    trimText(run.run_id),
    Number.isFinite(Number(run.elapsed_ms)) ? `elapsed_ms=${Number(run.elapsed_ms)}` : null,
  ];
  const resultKeys = run.result && typeof run.result === 'object' && !Array.isArray(run.result)
    ? Object.keys(run.result).slice(0, 8)
    : [];
  if (resultKeys.length > 0) evidence.push(`result_keys=${resultKeys.join(',')}`);
  return evidence.filter(Boolean);
}

function buildCodeModePracticeCurriculumCandidate(runs = []) {
  const successfulRuns = runs.filter((run) => (
    run
    && run.schema === MIRA_READ_ONLY_CODE_MODE_SCHEMA
    && run.ok === true
    && run.decision === 'completed'
  ));
  if (successfulRuns.length === 0) return null;
  const recentRuns = successfulRuns.slice(-6);
  const evidence = curriculumEvidenceList(recentRuns.flatMap(codeModeRunEvidence));
  return {
    source_kind: 'practiced_code_mode_run',
    source_key: 'code_mode_exploration:read_only_execute_script_curiosity',
    source: 'code_mode_exploration',
    adapter_id: 'read_only_execute_script_curiosity',
    target_role: 'mira_lab',
    skill_name: 'code mode exploration read only execute script curiosity',
    status: 'practiced',
    times_observed: successfulRuns.length,
    lesson: 'Read-only code-mode is implemented and has successful inspection runs over allowed local runtime/source evidence.',
    next_behavior: 'Use code-mode to inspect allowed local runtime, JSONL, logs, or source before routing the next improvement.',
    practice_trigger: 'When Mira needs fresh local evidence before a route, review, or work order.',
    graduation_metric: 'Keep practicing if inspections produce useful route evidence without writes, network, or destructive action.',
    evidence,
  };
}

function extractMiraCurriculumSkills(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = projectRootFromOptions(options, payload);
  const logPath = curriculumSkillsPath(projectRoot);
  const proposals = readJsonl(selfDirectionQueuePath(projectRoot));
  const reviews = readJsonl(selfDirectionReviewAuditPath(projectRoot));
  const outcomes = readJsonl(selfDirectionOutcomePath(projectRoot));
  const activeInitiatives = readJsonl(activeInitiativesPath(projectRoot));
  const activeInitiativeOutcomes = readJsonl(activeInitiativeOutcomesPath(projectRoot));
  const routes = readJsonl(miraDirectRoutesPath(projectRoot));
  const bursts = readJsonl(curiosityBurstsPath(projectRoot));
  const codeModeRuns = readJsonl(readOnlyCodeModeRunsPath(projectRoot));
  const reflexion = extractMiraReflexionLessons({ generatedAt }, { projectRoot, generatedAt });
  const groupedReviews = reviewsByProposalId(reviews);
  const groupedOutcomes = outcomesByProposalId(outcomes);
  const initiativesById = new Map(activeInitiatives
    .filter((entry) => entry && entry.schema === MIRA_ACTIVE_INITIATIVE_SCHEMA && trimText(entry.initiative_id))
    .map((entry) => [trimText(entry.initiative_id), entry]));
  const candidates = new Map();
  const activeOutcomeBySourceAdapter = new Map();
  const activeOutcomeCurriculumIndex = buildActiveInitiativeOutcomeCurriculumIndex(activeInitiativeOutcomes, initiativesById);

  const codeModePractice = buildCodeModePracticeCurriculumCandidate(codeModeRuns);
  if (codeModePractice) {
    const candidate = mergeCurriculumCandidate(candidates, codeModePractice);
    const sourceAdapterKey = curriculumSourceAdapterKey(codeModePractice.source, codeModePractice.adapter_id);
    if (sourceAdapterKey && candidate) {
      activeOutcomeBySourceAdapter.set(sourceAdapterKey, candidate);
    }
  }

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

  for (const outcome of activeInitiativeOutcomes) {
    if (!outcome || outcome.schema !== MIRA_ACTIVE_INITIATIVE_OUTCOME_SCHEMA) continue;
    if (outcome.outcome_status !== 'implemented') continue;
    if (activeOutcomeCurriculumIndex.suppressesImplementedOutcome(outcome)) continue;
    const initiativeId = trimText(outcome.initiative_id);
    const initiative = initiativesById.get(initiativeId) || {};
    const selected = initiative.selected_item || {};
    const work = outcome.work_order || initiative.work_order || {};
    const source = trimText(outcome.source || selected.source);
    const adapterId = trimText(outcome.adapter_id || selected.adapter_id || selected.adapterId);
    const candidate = mergeCurriculumCandidate(candidates, {
      source_kind: 'active_initiative_outcome',
      source_key: initiativeId,
      initiative_id: initiativeId,
      outcome_id: outcome.outcome_id,
      source,
      adapter_id: adapterId,
      target_role: outcome.target_role || initiative.target_role,
      skill_name: work.title || `${outcome.initiative_kind || initiative.initiative_kind || 'active'} initiative outcome`,
      lesson: outcome.note || `Active initiative ${initiativeId} was implemented.`,
      next_behavior: `Prefer this active-signal route when ${source || 'the same source'} produces a similar high-score signal.`,
      practice_trigger: `When ${source || 'an active source'}/${adapterId || 'adapter'} produces a similar work order.`,
      graduation_metric: 'Promote after two implemented active initiatives with no duplicate spam or rollback outcome.',
      evidence: curriculumEvidenceList(outcome.evidence, outcome.outcome_id, initiativeId),
    });
    const sourceAdapterKey = curriculumSourceAdapterKey(source, adapterId);
    if (sourceAdapterKey && candidate) {
      activeOutcomeBySourceAdapter.set(sourceAdapterKey, candidate);
    }
  }

  for (const route of routes) {
    if (route?.decision !== 'routed') continue;
    const item = route.selected_item || {};
    const sourceAdapterKey = curriculumSourceAdapterKey(item.source, item.adapter_id);
    if (sourceAdapterKey && activeOutcomeCurriculumIndex.negativeSourceAdapterKeys.has(sourceAdapterKey)) continue;
    const activeCandidate = sourceAdapterKey ? activeOutcomeBySourceAdapter.get(sourceAdapterKey) : null;
    if (mergeStalePatternIntoActiveOutcome(activeCandidate, {
      route_id: route.route_id,
      item_id: item.item_id,
      evidence: [route.reason, item.possible_action, item.suggested_question],
    })) {
      continue;
    }
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
    const sourceAdapterKey = curriculumSourceAdapterKey(route.source, route.adapter_id);
    if (sourceAdapterKey && activeOutcomeCurriculumIndex.negativeSourceAdapterKeys.has(sourceAdapterKey)) continue;
    const activeCandidate = sourceAdapterKey ? activeOutcomeBySourceAdapter.get(sourceAdapterKey) : null;
    if (mergeStalePatternIntoActiveOutcome(activeCandidate, {
      burst_id: burst.burst_id,
      evidence: [route.source, route.adapter_id, route.reason, route.possible_action, route.suggested_question],
    })) {
      continue;
    }
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
  MIRA_ACTIVE_INITIATIVE_SCHEMA,
  MIRA_ACTIVE_INITIATIVE_OUTCOME_SCHEMA,
  MIRA_ACTIVE_INITIATIVE_OUTCOME_STATUSES,
  MIRA_DIRECT_ROUTE_SCHEMA,
  MIRA_READ_ONLY_CODE_MODE_SCHEMA,
  MIRA_QUIET_CURIOSITY_SCHEDULE_SCHEMA,
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
  ensureMiraQuietCuriositySchedule,
  generateMiraSelfDirectionProposal,
  listMiraSelfDirectionProposals,
  recordMiraActiveInitiativeOutcome,
  recordMiraSelfDirectionOutcome,
  reviewMiraSelfDirectionProposal,
  runMiraCuriosityBurst,
  runMiraCuriosityScout,
  runMiraReadOnlyCodeMode,
  scanMiraLabConfidenceSource,
  selectMiraActiveInitiative,
  selectMiraDirectRoute,
  readMiraMemoryBrokerCuriosity,
  writeMiraEmailCuriositySnapshot,
  buildMiraLabTurn,
  exportMiraLabTranscript,
  curiosityBurstsPath,
  quietCuriosityScheduleLogPath,
  curriculumSkillsPath,
  replyAuditPath,
  activeInitiativesPath,
  activeInitiativeOutcomesPath,
  curiosityItemsPath,
  miraDirectRoutesPath,
  readOnlyCodeModeRunsPath,
  selfDirectionOutcomePath,
  selfDirectionReviewAuditPath,
  selfDirectionQueuePath,
  transcriptPath,
  validateSafeFallbackOrNull,
};
