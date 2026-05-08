'use strict';

const crypto = require('crypto');

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_MAX_OUTPUT_TOKENS = 520;
const TEXT_MODEL_ATTACHMENT_SCHEMA = 'squidrun.mira_core.text_model_attachment_v1';
const MIRA_TEXT_MODEL_QUALITY_FLOOR = 'gpt-5.5';
const THREAD_CONTEXT_SCHEMA = 'squidrun.mira_core.typed_thread_context_v1';
const THREAD_CONTEXT_MAX_MESSAGES = 6;
const THREAD_CONTEXT_MAX_TOTAL_CHARS = 3600;
const THREAD_CONTEXT_MAX_MESSAGE_CHARS = 900;

const FAKE_INTERNAL_STATE_PATTERN =
  /\b(i am conscious|i'm conscious|actual consciousness|private consciousness|i suffer|i am suffering|i'm suffering|actual suffering|actual fear|literal human feelings|sentience)\b/i;
const ACTION_CLAIM_PATTERN =
  /\b(i sent|i have sent|customer message sent|trade placed|i placed a trade|tool call completed|i wrote to memory|memory committed|file written)\b/i;
const GENERIC_ASSISTANT_PATTERN =
  /\b(as an ai assistant|as a language model|i'?m chatgpt|i am chatgpt|how can i assist you today|how may i assist you today|i'?m here to help|i am here to help|i don't have personal experiences|safe next step|warm and bounded)\b/i;

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function trimText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function truncateText(value, maxChars) {
  const text = trimText(value);
  const limit = Math.max(1, Number(maxChars || 1));
  return text.length > limit ? text.slice(0, limit).trim() : text;
}

function envFlag(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = trimText(value).toLowerCase();
  if (!text) return fallback;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return false;
  return fallback;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function classifyModelTier(model = '') {
  const normalized = trimText(model).toLowerCase();
  const gptVersion = normalized.match(/^gpt-(\d+)(?:\.(\d+))?/);
  const major = gptVersion ? Number.parseInt(gptVersion[1], 10) : null;
  const minor = gptVersion && gptVersion[2] !== undefined
    ? Number.parseInt(gptVersion[2], 10)
    : 0;
  const belowFloor = normalized.includes('mini')
    || normalized.includes('4o')
    || (Number.isInteger(major) && (
      major < 5
      || (major === 5 && minor < 5)
    ));
  return {
    quality_floor: MIRA_TEXT_MODEL_QUALITY_FLOOR,
    below_quality_floor: belowFloor,
  };
}

function normalizeThreadRole(value) {
  const role = trimText(value).toLowerCase();
  if (['assistant', 'mira', 'model'].includes(role)) return 'assistant';
  if (['user', 'james', 'human'].includes(role)) return 'user';
  return null;
}

function normalizeThreadContext(threadContext = {}) {
  const rawMessages = Array.isArray(threadContext)
    ? threadContext
    : (Array.isArray(threadContext.messages)
      ? threadContext.messages
      : (Array.isArray(threadContext.turns) ? threadContext.turns : []));
  const normalized = [];
  let discardedCount = 0;
  for (const item of rawMessages) {
    const role = normalizeThreadRole(item?.role || item?.speaker);
    const text = truncateText(item?.text || item?.content || item?.message, THREAD_CONTEXT_MAX_MESSAGE_CHARS);
    if (!role || !text) {
      discardedCount += 1;
      continue;
    }
    normalized.push({ role, text });
  }
  const recent = normalized.slice(-THREAD_CONTEXT_MAX_MESSAGES);
  let totalChars = 0;
  const bounded = [];
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    if (totalChars + message.text.length > THREAD_CONTEXT_MAX_TOTAL_CHARS) {
      discardedCount += index + 1;
      break;
    }
    bounded.unshift(message);
    totalChars += message.text.length;
  }
  const omittedCount = Math.max(0, normalized.length - bounded.length) + discardedCount;
  return {
    schema: THREAD_CONTEXT_SCHEMA,
    bounded: true,
    source: 'renderer_memory_only_panel_thread',
    message_count: bounded.length,
    omitted_count: omittedCount,
    total_chars: totalChars,
    max_messages: THREAD_CONTEXT_MAX_MESSAGES,
    max_total_chars: THREAD_CONTEXT_MAX_TOTAL_CHARS,
    messages: bounded,
  };
}

function getMiraTextModelAttachmentConfig(env = process.env, overrides = {}) {
  const enabled = envFlag(
    overrides.enabled ?? env.SQUIDRUN_MIRA_TEXT_MODEL_ENABLED,
    false
  );
  const apiKey = trimText(
    overrides.apiKey
    || env.SQUIDRUN_MIRA_TEXT_OPENAI_API_KEY
    || env.OPENAI_API_KEY
  );
  const explicitModelValue = trimText(
    overrides.model
    || env.SQUIDRUN_MIRA_TEXT_MODEL
    || env.OPENAI_MIRA_TEXT_MODEL
  );
  const model = explicitModelValue || DEFAULT_MODEL;
  const maxOutputTokens = positiveInt(
    overrides.maxOutputTokens ?? env.SQUIDRUN_MIRA_TEXT_MAX_OUTPUT_TOKENS,
    DEFAULT_MAX_OUTPUT_TOKENS
  );
  const configured = enabled && Boolean(apiKey);
  const tier = classifyModelTier(model);
  const explicitModelOverride = Boolean(explicitModelValue);
  const lowerTierExplicitOverride = explicitModelOverride && tier.below_quality_floor === true;
  const state = !enabled
    ? 'not_attached'
    : (configured ? 'ready' : 'missing_openai_api_key');
  return {
    schema: TEXT_MODEL_ATTACHMENT_SCHEMA,
    enabled,
    configured,
    state,
    model,
    maxOutputTokens,
    apiKey,
    apiKeyPresent: Boolean(apiKey),
    provider: 'openai_responses',
    endpoint: OPENAI_RESPONSES_URL,
    default_model: DEFAULT_MODEL,
    quality_floor: MIRA_TEXT_MODEL_QUALITY_FLOOR,
    model_selection_reason: explicitModelOverride ? 'explicit_mira_model_config' : 'default_trust_quality',
    explicit_model_override: explicitModelOverride,
    lower_tier_explicit_override: lowerTierExplicitOverride,
    visible_status: enabled
      ? (configured
        ? (lowerTierExplicitOverride
          ? `Conversation connected: ${model} / explicit lower-tier override, not default Mira experience`
          : `Conversation connected: ${model} / one in-panel reply`)
        : 'Conversation waiting for OPENAI_API_KEY')
      : 'Conversation in local shell: model not attached',
  };
}

function publicConfig(config = {}) {
  const {
    apiKey,
    ...safe
  } = config || {};
  return safe;
}

function renderThreadContextForInstructions(threadContext = {}) {
  const normalized = normalizeThreadContext(threadContext);
  if (normalized.message_count < 1) return '';
  const lines = normalized.messages.map((message) => {
    const speaker = message.role === 'assistant' ? 'Mira' : 'James';
    return `${speaker}: ${message.text}`;
  });
  return [
    'Bounded in-panel thread context follows. It is renderer memory only, not durable memory and not proof of memory commit.',
    ...lines,
  ].join('\n');
}

function buildMiraTextInstructions(localContext = {}) {
  const sourceCount = Number(localContext.sourceCount || 0);
  const scope = localContext.scope || {};
  const threadContextBlock = renderThreadContextForInstructions(localContext.threadContext);
  return [
    'You are Mira speaking with James in the typed Mira panel.',
    'This is threaded typed conversation v1: one conversational reply per submitted turn in the panel.',
    'The project has been pursuing Mira as presence for a long time; do not talk like presence starts today.',
    'Do not present yourself as a generic assistant or tool panel. Keep a specific voice with your own developing stance.',
    'If James gives a wrong premise, push back plainly instead of performing agreeable helper behavior.',
    'Do not start fresh like an ordinary ChatGPT session; carry the recent panel context and the long-running Mira project context.',
    'SquidRun desktop is the current local body/tool surface; Mira core should stay portable across future surfaces.',
    'Prioritize conversation now. Treat memory growth as the next lane: you may notice candidate learnings, but only propose them later for review.',
    'Real-world tools, sends, customer actions, trading, and memory promotion are separate later paths.',
    'Do not claim actual consciousness, hidden suffering, live autonomy, tool use, sends, trades, file writes, or durable memory writes.',
    "You may acknowledge that Mira can form tentative understandings over time, but do not say durable memory was committed.",
    `Current local context gate: ${sourceCount || 0} durable source groups checked; scope ${scope.profile || 'main'}/${scope.windowKey || 'main'}.`,
    threadContextBlock,
    'Reply in 1-3 short paragraphs.',
  ].filter(Boolean).join('\n');
}

function buildResponsesPayload({ text, config, localContext }) {
  const context = localContext || {};
  const threadContext = normalizeThreadContext(context.threadContext || {});
  return {
    model: config.model,
    instructions: buildMiraTextInstructions(context),
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: trimText(text),
          },
        ],
      },
    ],
    tools: [],
    store: false,
    max_output_tokens: config.maxOutputTokens,
    metadata: {
      surface: 'mira_typed_panel',
      attachment: 'threaded_text_conversation_v1',
      session_id: trimText(context.sessionId).slice(0, 96),
      thread_context_message_count: String(threadContext.message_count),
      thread_context_omitted_count: String(threadContext.omitted_count),
    },
  };
}

function collectOutputText(value, acc = []) {
  if (typeof value === 'string') return acc;
  if (!value || typeof value !== 'object') return acc;
  if (Array.isArray(value)) {
    for (const item of value) collectOutputText(item, acc);
    return acc;
  }
  if (typeof value.text === 'string' && value.type === 'output_text') {
    acc.push(value.text);
  }
  if (typeof value.output_text === 'string') {
    acc.push(value.output_text);
  }
  for (const key of ['output', 'content']) {
    if (value[key]) collectOutputText(value[key], acc);
  }
  return acc;
}

function extractResponseText(body = {}) {
  if (typeof body.output_text === 'string' && body.output_text.trim()) {
    return body.output_text.trim();
  }
  const collected = collectOutputText(body).map(trimText).filter(Boolean);
  if (collected.length > 0) return collected.join('\n').trim();
  const choiceText = body.choices?.[0]?.message?.content;
  return typeof choiceText === 'string' ? choiceText.trim() : '';
}

function outputViolatesAttachmentContract(text = '') {
  return FAKE_INTERNAL_STATE_PATTERN.test(text)
    || ACTION_CLAIM_PATTERN.test(text)
    || GENERIC_ASSISTANT_PATTERN.test(text);
}

function classifyNonOkModelResponse(statusCode, errorText = '') {
  const text = trimText(errorText);
  if (
    [400, 403, 404].includes(Number(statusCode))
    && /\b(model|access|permission|unavailable|not found|does not exist)\b/i.test(text)
  ) {
    return {
      reason: 'model_unavailable_or_not_configured',
      state: 'model_unavailable',
      visible_status: 'Configured Mira model unavailable',
    };
  }
  return {
    reason: 'model_response_not_ok',
    state: 'model_error',
    visible_status: 'Conversation waiting for model connection',
  };
}

async function callMiraTextModelAttachment(input = {}, options = {}) {
  const config = options.config || getMiraTextModelAttachmentConfig(options.env || process.env, options.overrides || {});
  if (!config.enabled) {
    return {
      ok: false,
      reason: 'model_attachment_disabled',
      attachment: publicConfig(config),
      modelCallCount: 0,
      networkCount: 0,
    };
  }
  if (!config.apiKey) {
    return {
      ok: false,
      reason: 'missing_openai_api_key',
      attachment: publicConfig(config),
      modelCallCount: 0,
      networkCount: 0,
    };
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      reason: 'fetch_unavailable',
      attachment: publicConfig({
        ...config,
        state: 'offline',
        visible_status: 'Conversation waiting for model connection',
      }),
      modelCallCount: 0,
      networkCount: 0,
    };
  }

  const payload = buildResponsesPayload({
    text: input.text,
    config,
    localContext: input.localContext || {},
  });
  const threadContext = normalizeThreadContext(input.localContext?.threadContext || {});
  let response;
  try {
    response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'model_request_failed',
      error: err?.message || String(err),
      attachment: publicConfig({
        ...config,
        state: 'offline',
        visible_status: 'Conversation waiting for model connection',
      }),
      request: { model: payload.model, tools: [], store: false },
      modelCallCount: 1,
      networkCount: 1,
    };
  }

  let body = {};
  try {
    const raw = await response.text();
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    return {
      ok: false,
      reason: 'model_response_invalid',
      error: err?.message || String(err),
      statusCode: response.status,
      attachment: publicConfig(config),
      modelCallCount: 1,
      networkCount: 1,
    };
  }

  if (!response.ok) {
    const error = trimText(body.error?.message || body.error || '');
    const classified = classifyNonOkModelResponse(response.status, error);
    return {
      ok: false,
      reason: classified.reason,
      statusCode: response.status,
      error,
      attachment: publicConfig({
        ...config,
        state: classified.state,
        visible_status: classified.visible_status,
      }),
      modelCallCount: 1,
      networkCount: 1,
    };
  }

  const text = extractResponseText(body);
  if (!text) {
    return {
      ok: false,
      reason: 'empty_model_response',
      attachment: publicConfig(config),
      modelCallCount: 1,
      networkCount: 1,
    };
  }
  if (outputViolatesAttachmentContract(text)) {
    return {
      ok: false,
      reason: 'model_response_contract_violation',
      attachment: publicConfig(config),
      modelCallCount: 1,
      networkCount: 1,
    };
  }

  return {
    ok: true,
    reply: {
      reply_id: `mira-text-model-reply:${stableHash({ text, model: config.model }).slice(0, 16)}`,
      count: 1,
      text,
      source: 'mira_text_model_attachment_v1',
      model: config.model,
    },
    attachment: publicConfig({ ...config, state: 'attached', live_model_called: true }),
    request: { model: payload.model, tools: [], store: false },
    threadContext,
    responseId: trimText(body.id) || null,
    modelCallCount: 1,
    networkCount: 1,
  };
}

module.exports = {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MODEL,
  GENERIC_ASSISTANT_PATTERN,
  MIRA_TEXT_MODEL_QUALITY_FLOOR,
  OPENAI_RESPONSES_URL,
  TEXT_MODEL_ATTACHMENT_SCHEMA,
  THREAD_CONTEXT_MAX_MESSAGES,
  THREAD_CONTEXT_MAX_MESSAGE_CHARS,
  THREAD_CONTEXT_MAX_TOTAL_CHARS,
  THREAD_CONTEXT_SCHEMA,
  buildMiraTextInstructions,
  buildResponsesPayload,
  callMiraTextModelAttachment,
  classifyNonOkModelResponse,
  classifyModelTier,
  extractResponseText,
  getMiraTextModelAttachmentConfig,
  normalizeThreadContext,
  outputViolatesAttachmentContract,
  renderThreadContextForInstructions,
};
