'use strict';

const { stripAnsi } = require('../ansi');
const {
  getTrustQuoteArmPaneIds,
  getTrustQuoteDayToDayArmSpecs,
} = require('../trustquote-arm-specs');

const PANE_FAILURE_ALERT_SETTING = 'paneFailureAlertsEnabled';
const PANE_FAILURE_BUFFER_MAX = 8192;
const CORE_PANE_IDS = Object.freeze(['1', '2', '3']);
const CORE_PANE_LABELS = new Map([
  ['1', 'Mira (pane 1)'],
  ['2', 'Builder (pane 2)'],
  ['3', 'Oracle (pane 3)'],
]);
const MONITORED_PANE_IDS = new Set([
  ...CORE_PANE_IDS,
  ...getTrustQuoteArmPaneIds(),
]);
const WORKROOM_LABELS = new Map(
  getTrustQuoteDayToDayArmSpecs().map((spec) => [String(spec.paneId), String(spec.label)])
);
const WORKROOM_COMMANDS = new Map(
  getTrustQuoteDayToDayArmSpecs().map((spec) => [String(spec.paneId), String(spec.command || '')])
);

// Exact refusal strings from installed CLI builds. Generic 429/rate-limit text is intentionally excluded.
const LIMIT_SIGNAL_PATTERNS = Object.freeze([
  Object.freeze({
    cliFamily: 'claude',
    signature: 'claude_named_limit',
    pattern: /you(?:'|\u2019)ve hit your (?:fable 5|weekly|session|opus|sonnet) limit(?:\s|\u00b7|[.!])*(?:resets?|reset\s+at)\b/i,
  }),
  Object.freeze({
    cliFamily: 'claude',
    signature: 'claude_admin_usage_limit',
    pattern: /you(?:'|\u2019)ve hit your usage limit(?:\s|\u00b7|[.!])*contact your admin to increase it\b/i,
  }),
  Object.freeze({
    cliFamily: 'claude',
    signature: 'claude_usage_exhausted',
    pattern: /(?:you(?:'|\u2019)re out of (?:usage credits|extra usage)|your org is out of usage(?:\s|\u00b7|[.!])*(?:add funds to continue|contact your admin)|your usage allocation has been disabled by your admin|your group(?:'|\u2019)s usage limit is set to \$0|fable 5 requires usage credits)/i,
  }),
  Object.freeze({
    cliFamily: 'codex',
    signature: 'codex_usage_limit',
    pattern: /you(?:'|\u2019)ve (?:hit|reached) your usage limit\b/i,
  }),
  Object.freeze({
    cliFamily: 'codex',
    signature: 'codex_workspace_credits',
    pattern: /(?:you(?:'|\u2019)ve reached your workspace credit limit|your workspace is out of credits\.\s+(?:add credits to continue(?: using codex)?\.|ask your workspace owner to (?:add more\.|refill in order to continue\.))|usage limit reached|quota exceeded\. check your plan and billing details\.)/i,
  }),
  Object.freeze({
    cliFamily: 'codex',
    signature: 'codex_workspace_spend_cap',
    pattern: /you hit your spend cap set (?:in your workspace\.\s+increase your spend cap|by the owner of your workspace\.\s+ask an owner to increase your spend cap) to continue\./i,
  }),
  Object.freeze({
    cliFamily: 'gemini',
    signature: 'gemini_usage_limit',
    pattern: /usage limit reached for [A-Za-z0-9._:-]+\./i,
  }),
]);

function normalizeCliFamily(value) {
  const candidates = value && typeof value === 'object'
    ? [value.label, value.provider, value.command, value.cli]
    : [value];
  const text = candidates.map((candidate) => String(candidate || '').toLowerCase()).join(' ');
  if (text.includes('claude') || text.includes('anthropic')) return 'claude';
  if (text.includes('codex') || text.includes('openai')) return 'codex';
  if (text.includes('gemini') || text.includes('google')) return 'gemini';
  return null;
}

function resolvePaneFailureCliHint(rawPaneId, ctx = {}, cliIdentity = null) {
  const paneId = String(rawPaneId || '').trim();
  const configured = ctx.currentSettings?.paneCommands?.[paneId];
  if (typeof configured === 'string' && configured.trim()) return configured;
  const workroomCommand = WORKROOM_COMMANDS.get(paneId);
  if (workroomCommand) return workroomCommand;
  const cached = ctx.paneCliIdentity?.get?.(paneId);
  if (cached) return cached;
  return cliIdentity?.getPaneCommandForIdentity?.(paneId) || null;
}

function normalizePaneOutput(value) {
  return stripAnsi(value)
    .replace(/\r/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ');
}

function detectPaneLimitSignal(value, cliHint = null) {
  const text = normalizePaneOutput(value);
  const cliFamily = normalizeCliFamily(cliHint);
  if (!text.trim()) return null;
  if (!cliFamily) return null;
  for (const signal of LIMIT_SIGNAL_PATTERNS) {
    if (signal.cliFamily !== cliFamily) continue;
    if (signal.pattern.test(text)) {
      return {
        eventName: 'usage_limit_refusal',
        cliFamily,
        signature: signal.signature,
      };
    }
  }
  return null;
}

function isMonitoredPaneId(value, metadata = null) {
  if (metadata?.backgroundAgent === true) return false;
  if (metadata?.workRoomRouteOwner === true) return true;
  return MONITORED_PANE_IDS.has(String(value || '').trim());
}

function isStalePtyGeneration(metadata = null, currentTerminal = null) {
  if (!metadata || !currentTerminal) return false;
  const eventPid = Number(metadata.pid);
  const currentPid = Number(currentTerminal.pid);
  if (Number.isFinite(eventPid) && Number.isFinite(currentPid) && eventPid !== currentPid) {
    return true;
  }
  const eventCreatedAt = String(metadata.createdAt || '').trim();
  const currentCreatedAt = String(currentTerminal.createdAt || '').trim();
  return Boolean(eventCreatedAt && currentCreatedAt && eventCreatedAt !== currentCreatedAt);
}

function paneDisplayName(value) {
  const paneId = String(value || '').trim();
  if (CORE_PANE_LABELS.has(paneId)) return CORE_PANE_LABELS.get(paneId);
  const label = WORKROOM_LABELS.get(paneId);
  return label ? `${label} workroom pane` : `Pane ${paneId}`;
}

function eventMessage(event = {}) {
  const label = paneDisplayName(event.paneId);
  if (event.eventName === 'usage_limit_refusal') {
    return `${label} hit its usage limit - replies will silently stop until a fresh session or the limit resets.`;
  }
  const code = event.exitCode === null || event.exitCode === undefined
    ? 'unknown'
    : String(event.exitCode);
  return `${label} exited (code ${code}) - replies will silently stop until the pane is restarted.`;
}

function safeIdPart(value, fallback = 'unknown') {
  const text = String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '-');
  return text || fallback;
}

function createPaneFailureMonitor(deps = {}) {
  const getSettings = typeof deps.getSettings === 'function' ? deps.getSettings : () => ({});
  const getSessionId = typeof deps.getSessionId === 'function' ? deps.getSessionId : () => null;
  const getCliHint = typeof deps.getCliHint === 'function' ? deps.getCliHint : () => null;
  const appendJournal = typeof deps.appendJournal === 'function' ? deps.appendJournal : null;
  const sendTelegram = typeof deps.sendTelegram === 'function' ? deps.sendTelegram : null;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const logger = deps.log && typeof deps.log === 'object' ? deps.log : {};
  const activeEventsByPane = new Map();
  const outputBuffersByPane = new Map();
  let sequence = 0;

  function alertsEnabled() {
    return getSettings()?.[PANE_FAILURE_ALERT_SETTING] !== false;
  }

  function isEventActive(paneId, eventName) {
    return activeEventsByPane.get(paneId)?.has(eventName) === true;
  }

  function activateEvent(paneId, eventName) {
    const active = activeEventsByPane.get(paneId) || new Set();
    active.add(eventName);
    activeEventsByPane.set(paneId, active);
  }

  async function notify(event = {}) {
    const paneId = String(event.paneId || '').trim();
    const eventName = String(event.eventName || '').trim();
    if (!alertsEnabled() || !isMonitoredPaneId(paneId, event.metadata) || !eventName) {
      return { ok: true, ignored: true, reason: 'disabled_or_unmonitored' };
    }
    if (isEventActive(paneId, eventName)) {
      return { ok: true, ignored: true, reason: 'event_state_already_active' };
    }

    activateEvent(paneId, eventName);
    const timestampMs = Number(now()) || Date.now();
    sequence += 1;
    const message = eventMessage({ ...event, paneId, eventName });
    const sessionId = getSessionId() || null;
    const systemMessageId = [
      'pane-failure',
      safeIdPart(eventName),
      safeIdPart(paneId),
      timestampMs,
      sequence,
    ].join('-');
    const metadata = {
      source: 'pane-failure-monitor',
      paneFailureAlert: true,
      eventName,
      paneId,
      cliFamily: event.cliFamily || null,
      signature: event.signature || null,
      exitCode: event.exitCode ?? null,
      scope: 'main',
      windowKey: 'main',
      todayVisible: true,
      workRoomPane: event.metadata?.workRoomRouteOwner === true,
    };

    let journalResult = { ok: false, reason: 'journal_writer_unavailable' };
    if (appendJournal) {
      try {
        journalResult = await appendJournal({
          messageId: systemMessageId,
          sessionId,
          channel: 'system',
          direction: 'outbound',
          senderRole: 'system',
          targetRole: 'system',
          sentAtMs: timestampMs,
          rawBody: message,
          status: 'recorded',
          attempt: 1,
          metadata,
        });
      } catch (error) {
        journalResult = { ok: false, reason: error.message };
      }
    }
    if (journalResult?.ok !== true) {
      logger.warn?.('PaneFailure', `System journal write failed for pane ${paneId}: ${journalResult?.reason || 'unknown'}`);
    }

    let telegramResult = { ok: false, reason: 'telegram_sender_unavailable' };
    if (sendTelegram) {
      try {
        telegramResult = await sendTelegram(message, process.env, {
          messageId: `${systemMessageId}-telegram`,
          senderRole: 'system',
          targetRole: 'user',
          sessionId,
          metadata: {
            ...metadata,
            systemMessageId,
            todayVisible: false,
          },
        });
      } catch (error) {
        telegramResult = { ok: false, reason: error.message };
      }
    }
    if (telegramResult?.ok !== true) {
      logger.warn?.('PaneFailure', `Telegram alert failed for pane ${paneId}: ${telegramResult?.reason || telegramResult?.error || 'unknown'}`);
    }

    return {
      ok: journalResult?.ok === true && telegramResult?.ok === true,
      ignored: false,
      paneId,
      eventName,
      message,
      systemMessageId,
      journalResult,
      telegramResult,
    };
  }

  function handlePtyData(rawPaneId, data, terminalMetadata = null, cliHint = null) {
    const paneId = String(rawPaneId || '').trim();
    const cliFamily = normalizeCliFamily(cliHint || getCliHint(paneId));
    if (!alertsEnabled() || !isMonitoredPaneId(paneId, terminalMetadata) || !cliFamily) {
      outputBuffersByPane.delete(paneId);
      return Promise.resolve({ ok: true, ignored: true });
    }
    if (isEventActive(paneId, 'usage_limit_refusal')) {
      return Promise.resolve({ ok: true, ignored: true });
    }
    const nextBuffer = `${outputBuffersByPane.get(paneId) || ''}${String(data || '')}`
      .slice(-PANE_FAILURE_BUFFER_MAX);
    outputBuffersByPane.set(paneId, nextBuffer);
    const signal = detectPaneLimitSignal(nextBuffer, cliFamily);
    if (!signal) return Promise.resolve({ ok: true, ignored: true });
    outputBuffersByPane.delete(paneId);
    return notify({ paneId, ...signal, metadata: terminalMetadata });
  }

  function handlePtyExit(rawPaneId, exitCode, metadata = null, currentTerminal = null) {
    const paneId = String(rawPaneId || '').trim();
    outputBuffersByPane.delete(paneId);
    if (isStalePtyGeneration(metadata, currentTerminal)) {
      return Promise.resolve({ ok: true, ignored: true, reason: 'stale_pty_generation' });
    }
    return notify({
      paneId,
      eventName: 'process_exit',
      exitCode,
      metadata,
    });
  }

  function handlePtySpawn(rawPaneId) {
    const paneId = String(rawPaneId || '').trim();
    const clearedEvents = activeEventsByPane.get(paneId)?.size || 0;
    activeEventsByPane.delete(paneId);
    outputBuffersByPane.delete(paneId);
    return {
      ok: true,
      paneId,
      recovered: clearedEvents > 0,
      clearedEvents,
    };
  }

  return {
    handlePtyData,
    handlePtyExit,
    handlePtySpawn,
    notify,
    isEventActive,
  };
}

module.exports = {
  CORE_PANE_IDS,
  LIMIT_SIGNAL_PATTERNS,
  MONITORED_PANE_IDS,
  PANE_FAILURE_ALERT_SETTING,
  PANE_FAILURE_BUFFER_MAX,
  createPaneFailureMonitor,
  detectPaneLimitSignal,
  eventMessage,
  isMonitoredPaneId,
  isStalePtyGeneration,
  normalizePaneOutput,
  normalizeCliFamily,
  paneDisplayName,
  resolvePaneFailureCliHint,
};
