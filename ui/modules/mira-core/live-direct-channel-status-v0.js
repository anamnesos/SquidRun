'use strict';

const path = require('path');

const {
  buildMiraProgressReport,
} = require('./mira-progress-v0');
const {
  buildMiraLiveWhatNowAnswerV0,
  countJamesActionLines,
} = require('./live-what-now-answer-v0');
const {
  normalizeChatId,
} = require('../../scripts/hm-telegram');

const SCHEMA = 'squidrun.mira_core.live_direct_channel_status_v0';
const VERSION = 1;
const MAX_SUMMARY_CHARS = 260;
const TELEGRAM_LONG_MESSAGE_MAX_CHARS = 4000;

const DIRECT_CHANNEL_STATUS_PATTERNS = Object.freeze([
  /^(?:mira[,:\s-]*)?status\s*\??$/i,
  /^(?:mira[,:\s-]*)?what\s+now\s*\??$/i,
  /^(?:mira[,:\s-]*)?what(?:'|')?s\s+next\s*\??$/i,
  /^(?:ok(?:ay)?[,:\s-]*)?continue\s*\.?$/i,
  /\bmira\b[\s\S]{0,80}\b(?:status|what\s+now|continue)\b/i,
]);

function trimText(value, limit = MAX_SUMMARY_CHARS) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function isMiraDirectChannelStatusPrompt(text = '') {
  const normalized = trimText(text, 500);
  if (!normalized) return false;
  return DIRECT_CHANNEL_STATUS_PATTERNS.some((pattern) => pattern.test(normalized));
}

function splitTelegramStatusPreview(message, maxChars = TELEGRAM_LONG_MESSAGE_MAX_CHARS) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return [];
  const limit = Number.isFinite(Number(maxChars))
    ? Math.max(1, Math.floor(Number(maxChars)))
    : TELEGRAM_LONG_MESSAGE_MAX_CHARS;
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitIndex = remaining.lastIndexOf('\n\n', limit);
    if (splitIndex < Math.floor(limit * 0.5)) splitIndex = remaining.lastIndexOf('\n', limit);
    if (splitIndex < Math.floor(limit * 0.5)) splitIndex = limit;
    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function normalizeProgress(report = {}) {
  const head = report.source_refs?.head || {};
  const proof = report.source_refs?.progress_proof_inputs || {};
  return {
    percent: Number.isFinite(Number(report.computed_total_percent))
      ? Number(report.computed_total_percent)
      : null,
    status: trimText(report.status, 40) || 'UNKNOWN',
    head_short_sha: trimText(head.short_sha, 40) || null,
    proof_source_ref: trimText(proof.source_ref, 160) || null,
    proof_status: trimText(proof.status, 40) || null,
    warnings: Array.isArray(report.warnings)
      ? report.warnings.map((item) => trimText(item, 120)).filter(Boolean)
      : [],
  };
}

function normalizeRoute(input = {}, options = {}) {
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const route = input.inboundRoute || input.route || options.inboundRoute || options.route || {};
  const chatId = normalizeChatId(route.chatId || metadata.chatId || input.chatId);
  const windowKey = trimText(route.windowKey || metadata.windowKey || input.windowKey, 80) || 'main';
  const profile = trimText(route.profile || metadata.profile || input.profile, 80) || windowKey;
  const channel = trimText(metadata.channel || input.channel || options.channel, 40) || 'telegram';
  return {
    ok: route.ok !== false,
    channel,
    chatId,
    windowKey,
    profile,
    reason: trimText(route.reason || metadata.routeReason || input.routeReason, 120) || null,
    source: trimText(route.source || metadata.routingSource || input.routingSource, 120) || null,
    currentOwner: 'squidrun-telegram-guard-stack',
    miraOwnsTelegram: false,
    routeOwnerChange: false,
    liveRouteChanged: false,
  };
}

function firstSentence(value = '', fallback = 'No active current lane') {
  const text = trimText(value, MAX_SUMMARY_CHARS);
  if (!text) return fallback;
  const match = text.match(/^(.+?[.!?])(?:\s+|$)/);
  return trimText(match ? match[1] : text, MAX_SUMMARY_CHARS).replace(/[.!?]+$/, '');
}

function fallbackRecentChange(progress = {}) {
  if (!progress.head_short_sha) return null;
  return {
    source_ref: `HEAD:${progress.head_short_sha}`,
    summary: `latest committed checkpoint is HEAD ${progress.head_short_sha}`,
  };
}

function formatRecentChanges(changes = [], progress = {}) {
  const effectiveChanges = changes.length > 0
    ? changes
    : [fallbackRecentChange(progress)].filter(Boolean);
  if (effectiveChanges.length === 0) return 'Recent changes: no recent completed checkpoint found in current evidence.';
  return `Recent changes: ${effectiveChanges.map((item) => (
    item.source_ref ? `${item.summary} (${item.source_ref})` : item.summary
  )).join('; ')}.`;
}

function buildAnswerText({
  currentLane,
  recentChanges,
  progress,
  route,
  sourceStatus,
}) {
  const activeLane = currentLane && typeof currentLane === 'object' ? currentLane : null;
  const laneLine = activeLane
    ? `Current lane: ${firstSentence(activeLane.objective)} (${activeLane.status || 'active'}; source ${activeLane.source_ref || 'unknown'}).`
    : `Current lane: none active (source ${sourceStatus.authority_source || 'no_active_lane'}).`;
  const progressHead = progress.head_short_sha ? ` at HEAD ${progress.head_short_sha}` : '';
  const proofSource = progress.proof_source_ref
    ? `; proof ${progress.proof_status || 'unknown'} from ${progress.proof_source_ref}`
    : '';
  const nextMove = activeLane
    ? `Next move: Builder handles ${activeLane.source_ref || 'the active lane'} and Oracle reviews before commit; no voice, always-on mic, A4, external action, or Telegram owner flip is authorized.`
    : 'Next move: no Builder task is active until James or Architect opens the next checkpoint; no voice, always-on mic, A4, external action, or Telegram owner flip is authorized.';

  return [
    `Direct channel: Telegram is reachable through ${route.currentOwner}; Mira is answering through the existing guarded route, not a route-owner switch.`,
    `Current state: official progress ${progress.percent ?? 'unknown'}% ${progress.status}${progressHead}${proofSource}.`,
    laneLine,
    formatRecentChanges(recentChanges, progress),
    'Authority: live SquidRun current-lane/comms/progress evidence decides this answer; parked, prototype, archive, New Mira direct-channel scaffolds, voice, and phase chains are excluded from next-move authority.',
    nextMove,
    'JAMES ACTION: NONE',
  ].join('\n');
}

function buildBlockedResult(decision, reason, route, extra = {}) {
  return {
    schema: SCHEMA,
    version: VERSION,
    ok: false,
    decision,
    reason,
    read_only: true,
    route,
    no_effects: {
      telegram_send_function_call: false,
      internal_handoff_send_count: 0,
      hm_send_count: 0,
      runtime_post_count: 0,
      model_call_count: 0,
      network_count: 0,
      write_count: 0,
      route_owner_change_count: 0,
      external_action_count: 0,
    },
    ...extra,
  };
}

function buildMiraDirectChannelStatusAnswerV0(input = {}, options = {}) {
  const promptText = input.promptText || input.text || input.body || '';
  const projectRoot = path.resolve(String(options.projectRoot || input.projectRoot || process.cwd()));
  const route = normalizeRoute(input, options);
  const nowMs = Number.isFinite(Number(options.nowMs || input.nowMs))
    ? Number(options.nowMs || input.nowMs)
    : Date.now();

  if (!isMiraDirectChannelStatusPrompt(promptText)) {
    return buildBlockedResult('not_direct_channel_status_prompt', 'prompt is not a direct-channel status prompt', route);
  }
  if (route.ok !== true || route.windowKey !== 'main' || route.profile !== 'main') {
    return buildBlockedResult('blocked_non_main_or_unowned_direct_channel_route', 'direct-channel status answers require the main owned Telegram route', route, {
      scope: {
        windowKey: route.windowKey,
        profile: route.profile,
      },
    });
  }

  const progressReport = options.progressReport || input.progressReport || buildMiraProgressReport({
    projectRoot,
    progressProofPath: options.progressProofPath,
    head: options.head,
    worktreeState: options.worktreeState,
    nowMs,
  });
  const progress = normalizeProgress(progressReport);
  const whatNow = buildMiraLiveWhatNowAnswerV0({
    promptText: 'what now?',
    metadata: {
      sessionId: input.metadata?.sessionId || input.metadata?.session_id || options.sessionId || null,
    },
  }, {
    projectRoot,
    nowMs,
    currentLaneSnapshot: options.currentLaneSnapshot,
    commsRows: options.commsRows,
    commsReader: options.commsReader,
    evidenceLedgerDbPath: options.evidenceLedgerDbPath,
    commsLimit: options.commsLimit,
    sessionId: options.sessionId,
  });
  const currentLane = whatNow.current_lane || null;
  const recentChanges = Array.isArray(whatNow.recent_changes) ? whatNow.recent_changes : [];
  const sourceStatus = whatNow.source_status || {};
  const answerText = buildAnswerText({
    currentLane,
    recentChanges,
    progress,
    route,
    sourceStatus,
  });
  const chunks = splitTelegramStatusPreview(answerText);

  return {
    schema: SCHEMA,
    version: VERSION,
    ok: true,
    decision: currentLane ? 'answered_direct_channel_status_from_live_evidence' : 'answered_direct_channel_status_no_active_lane',
    read_only: true,
    generated_at: new Date(nowMs).toISOString(),
    answer_text: answerText,
    james_action_line_count: countJamesActionLines(answerText),
    route,
    current_lane: currentLane,
    recent_changes: recentChanges,
    progress,
    source_status: {
      authority_source: sourceStatus.authority_source || 'no_active_lane',
      current_lane_json: sourceStatus.current_lane_json || null,
      live_comms_journal: sourceStatus.live_comms_journal || null,
      progress: {
        head_short_sha: progress.head_short_sha,
        proof_source_ref: progress.proof_source_ref,
        proof_status: progress.proof_status,
        warnings: progress.warnings,
      },
    },
    parked_archive_exclusions: [
      'parked/prototype/archive scaffolds excluded from direct-channel authority',
      'New Mira direct-channel readiness is dry-run only until a separate bot/chat and owner switch are reviewed',
      'voice/always-on mic/A4/external action excluded',
    ],
    egress_integrity: {
      telegram_chunk_count: chunks.length,
      would_chunk: chunks.length > 1,
      would_truncate_silently: false,
      internal_pane_labels_present: /\[(?:AGENT MSG|CURRENT PROJECT)\]|\((?:ARCHITECT|BUILDER|ORACLE)\s+#\d+\):/i.test(answerText),
    },
    no_effects: {
      telegram_send_function_call: false,
      internal_handoff_send_count: 0,
      hm_send_count: 0,
      runtime_post_count: 0,
      model_call_count: 0,
      network_count: 0,
      write_count: 0,
      route_owner_change_count: 0,
      external_action_count: 0,
    },
  };
}

module.exports = {
  SCHEMA,
  VERSION,
  buildMiraDirectChannelStatusAnswerV0,
  countJamesActionLines,
  isMiraDirectChannelStatusPrompt,
  splitTelegramStatusPreview,
};
