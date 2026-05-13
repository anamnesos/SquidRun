'use strict';

const MIRA_LIVE_PROMPT_REPLY_CHANNEL = 'mira:lab-prompt-reply';
const DEFAULT_MIRA_LIVE_SESSION_ID = 'app-session-mira-live';
const USER_SPEAKER_ROLE = 'james';

function trimText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function normalizeMiraLiveSessionId(value) {
  const text = trimText(value);
  if (!text) return DEFAULT_MIRA_LIVE_SESSION_ID;
  const sessionMatch = text.match(/\bsession\s+(\d+)\b/i);
  if (sessionMatch && sessionMatch[1]) return `app-session-${sessionMatch[1]}`;
  if (/^app-session(?:[-:_A-Za-z0-9]+)?$/i.test(text)) return text;
  return DEFAULT_MIRA_LIVE_SESSION_ID;
}

function buildMiraLivePromptPayload(input = {}) {
  const prompt = trimText(input.prompt || input.message || input.text);
  const sessionId = normalizeMiraLiveSessionId(input.sessionId || input.session_id);
  return {
    sessionId,
    prompt,
    speakerRole: USER_SPEAKER_ROLE,
    requesterPane: null,
    source: 'main-command-bar-mira-live',
  };
}

function pickMiraLiveReplyText(result = {}) {
  const hint = result && typeof result === 'object' ? result.visible_render_hint || {} : {};
  if (
    ['clean_reply', 'annotated_reply', 'replayed_reply'].includes(hint.kind)
    && trimText(hint.text)
  ) {
    return trimText(hint.text);
  }
  const replyText = trimText(result?.reply?.text);
  return replyText || null;
}

function classifyMiraLiveResult(result = {}) {
  if (!result || typeof result !== 'object') {
    return {
      ok: false,
      state: 'unavailable',
      replyText: null,
      message: 'Mira is unavailable. Open Mira Lab for diagnostics.',
    };
  }

  const replyText = pickMiraLiveReplyText(result);
  if (replyText) {
    return {
      ok: true,
      state: result.decision === 'fail' ? 'annotated' : 'ready',
      replyText,
      message: replyText,
    };
  }

  if (result.decision === 'blocked') {
    return {
      ok: false,
      state: 'held',
      replyText: null,
      message: 'Mira held that reply. Open Mira Lab for diagnostics.',
    };
  }

  return {
    ok: false,
    state: 'unavailable',
    replyText: null,
    message: 'Mira is unavailable. Open Mira Lab for diagnostics.',
  };
}

async function sendMiraLivePrompt(input = {}, deps = {}) {
  const invoke = deps.invoke;
  if (typeof invoke !== 'function') {
    return {
      ok: false,
      state: 'unavailable',
      reason: 'invoke_unavailable',
      message: 'Mira is unavailable. Open Mira Lab for diagnostics.',
    };
  }

  const payload = buildMiraLivePromptPayload(input);
  if (!payload.prompt) {
    return {
      ok: false,
      state: 'empty',
      reason: 'empty_prompt',
      message: '',
    };
  }

  try {
    const result = await invoke(MIRA_LIVE_PROMPT_REPLY_CHANNEL, payload);
    return {
      ...classifyMiraLiveResult(result),
      payload,
      result,
    };
  } catch (err) {
    return {
      ok: false,
      state: 'unavailable',
      reason: 'invoke_failed',
      error: err?.message || String(err),
      message: 'Mira is unavailable. Open Mira Lab for diagnostics.',
      payload,
    };
  }
}

module.exports = {
  DEFAULT_MIRA_LIVE_SESSION_ID,
  MIRA_LIVE_PROMPT_REPLY_CHANNEL,
  USER_SPEAKER_ROLE,
  buildMiraLivePromptPayload,
  classifyMiraLiveResult,
  normalizeMiraLiveSessionId,
  pickMiraLiveReplyText,
  sendMiraLivePrompt,
};
