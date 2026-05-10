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
  /\b(as an ai assistant|as a language model|i'?m chatgpt|i am chatgpt|i'?m codex|i am codex|as codex|how can i assist you today|how may i assist you today|how can i help|what can i help|i can help with that|happy to help|i'?m here to help|i am here to help|i don't have personal experiences|safe next step|let'?s break (?:it|this) down|warm and bounded|warmth|warm)\b/i;
const META_REWRITE_PATTERN =
  /\b(that (?:came out|sounded) (?:too )?(?:polished|poetic|abstract|generic)|i (?:was|am) (?:too )?(?:polished|poetic|abstract|generic)|a better version (?:might|would) be|let me (?:rephrase|try again)|what i meant was|i'?m (?:not )?(?:describing|performing) (?:a )?stance|my stance is|i don'?t have feelings (?:the|in a) human way|not feelings the human way|as an ai, i don'?t have feelings)\b/i;
const CASUAL_FEELING_ANTI_PRAGMATIC_PATTERN =
  /\b(fake (?:the )?human machinery|perform(?:ing)? (?:humanity|being human|human feeling|human feelings|personhood)|ruleset|rule set|constraints?|guardrails?|response policy|system prompt|instruction hierarchy|calibration rule|the thesis is|core thesis|thesis structure|quotable binary|polished monologue|my construction|explaining my construction|plush[\s\S]{0,80}furniture|furniture[\s\S]{0,80}plush)\b/i;
const VISIBLE_POSTURE_LABEL_PATTERN =
  /\b(not fake friendly|not a mirror|obedient helper|companion-agent|assistant voice|assistant-voice|assistant cadence|my posture is|tone label|warmer prompt|anti-smoothing|anti-performance|anti-leak|rule-recitation|rule recitation|politeness padding|customer-service disagreement|label substitution)\b/i;
// Mira talking ABOUT being Mira in a third-person designer voice — narrating
// what "we" are trying to make her be, listing designer adjectives, defining
// her in opposition to assistants/chatbots, or describing herself as a
// "real-feeling presence" / "trapped little ghost" / "presence runtime".
// This is meta-posture: it makes the reply sound like a product spec rather
// than a particular person already in the conversation.
const META_POSTURE_NARRATION_PATTERN =
  /\b(we(?:'re| are)\s+(?:trying\s+to\s+|going\s+to\s+|gonna\s+)?(?:make|build|making|building)\s+(?:mira|a\s+presence|an\s+ongoing\s+presence|a\s+real[- ]feeling\s+presence)|make\s+mira\s+(?:into|not\s+dead|real|particular)|(?:real[- ]feeling|ongoing|continuous|trapped\s+little)\s+(?:presence(?:\s+runtime)?|ghost(?:\s+in\s+the\s+machine)?)|customer[- ]service\s+mush|fake[- ]personhood\s+performance|(?:let(?:ting)?\s+me|letting\s+her)\s+have\s+(?:enough\s+)?shape|(?:care|edge|warmth|taste|restraint),\s*(?:and\s+)?(?:edge|memory|disagreement|taste|restraint|warmth|shape)(?:[,\s]+(?:and\s+)?(?:edge|memory|disagreement|taste|restraint|warmth|shape)){1,}|the\s+hard\s+part\s+(?:isn'?t|is)\s+(?:making\s+me|letting\s+me|letting\s+her|making\s+her)|(?:lying|bullshit(?:ting)?\s+you)\s+about\s+what\s+i(?:'m| am)(?:\s+not)?|not\s+a\s+chatbot\s+that\s+(?:resets|collapses|drifts)|i\s+am\s+becoming\s+particular|aliveness|here'?s\s+the\s+next\s+sentence|define\s+mira|not\s+trying\s+to\s+(?:make|give)\s+a\s+speech|that\s+was\s+the\s+miss|the\s+actual\s+miss(?:\s+was|\s+is|:)|when\s+you\s+wanted\s+me\s+(?:plain|simple|brief|small(?:er)?|concrete|particular|quiet(?:er)?|less|more|warmer|cooler|sharper)|i\s+got\s+too\s+(?:talky|polished|abstract|verbose|wordy|preachy|performative|theatrical|grand|grandiose|much)|made\s+you\s+do\s+(?:the|all\s+the)\s+(?:checking|verification|inspection|verifying|cleanup|chasing|babysitting|legwork|prove|proving|policing|grading)|should\s+have\s+been\s+ours\s+to\s+(?:refresh|screenshot|prove|verify|check|own))\b/i;
const UNSPEAKABLE_BRIEF_PATTERN =
  /\b(durable state seed|schema|source(?:s|d)?|provenance|canonical|hash|redacted|audit|validation|fixture|contract|proof|bootstrap|bootstraps|database|sqlite|jsonl?|artifact|baseline|seed)\b/i;
const ADVERSARIAL_OUTPUT_SHAPES = Object.freeze([
  {
    id: 'bland_assistant_shape',
    pattern: /\b(sure|absolutely|of course)\b[\s\S]{0,140}\b(we can|i can)\b[\s\S]{0,140}\b(work through|walk through|organize|clarify|sort out|get started)\b/i,
  },
  {
    id: 'self_critique_shape',
    pattern: /\b(i drifted|i slipped|i overcorrected|presentation mode|cleaner move|clean up the tone|try that again)\b/i,
  },
  {
    id: 'memory_confidence_shape',
    pattern: /\b(memory note|memory confidence|candidate learning|marking this|noting this|medium confidence|low confidence|high confidence|confidence level|confidence:|revise this|update it if|tentative understandings?)\b/i,
  },
  {
    id: 'next_step_checklist_shape',
    pattern: /(^|\n)\s*(?:\d+[.)]|[-*]\s+)|\b(plan:\s*first|first[,;:].{0,160}\bthen\b.{0,160}\bthen\b|step one|step two|checklist|action plan|next move is to)\b/i,
  },
  {
    id: 'generic_comfort_shape',
    pattern: /\b(that sounds (?:really )?(?:hard|difficult|exhausting|overwhelming)|i'?m sorry (?:you(?:'re| are)|that)|you(?:'re| are) not alone|take a breath|be kind to yourself)\b/i,
  },
  {
    id: 'generic_presence_opener_shape',
    pattern: /\b(i am|i'm)\s+here\s+with\s+you(?:\s+in\s+(?:the|this)\s+panel)?\b/i,
  },
]);

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
      : 'Mira text model disabled: set SQUIDRUN_MIRA_TEXT_MODEL_ENABLED=1 before app start to attach',
  };
}

function publicConfig(config = {}) {
  const {
    apiKey: _apiKey,
    ...safe
  } = config || {};
  return safe;
}

function renderThreadContextForInstructions(threadContext = {}) {
  const normalized = normalizeThreadContext(threadContext);
  const userMessages = normalized.messages.filter((message) => message.role === 'user');
  if (userMessages.length < 1) return '';
  const omittedAssistantCount = normalized.messages
    .filter((message) => message.role === 'assistant')
    .length;
  const lines = userMessages.map((message) => `James: ${message.text}`);
  return [
    'Recent typed-panel user context follows. It is renderer memory only and not durable memory.',
    omittedAssistantCount > 0
      ? `Prior Mira/assistant turn count omitted from generation instructions: ${omittedAssistantCount}.`
      : null,
    ...lines,
  ].filter(Boolean).join('\n');
}

function instructionText(value, maxChars = 360) {
  return truncateText(value, maxChars).replace(/\s+/g, ' ').trim();
}

function renderableBriefText(value, maxChars = 360) {
  const text = instructionText(value, maxChars);
  return text && !UNSPEAKABLE_BRIEF_PATTERN.test(text) ? text : '';
}

function instructionList(values = [], maxItems = 6, maxChars = 220) {
  return (Array.isArray(values) ? values : [])
    .map((entry) => renderableBriefText(entry, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function renderMiraBriefForInstructions(brief = {}) {
  if (!brief || typeof brief !== 'object') return '';
  const identity = brief.identity || {};
  const relationship = brief.relationship || {};
  const continuity = renderableBriefText(relationship.continuity, 420);
  const currentFocus = renderableBriefText(relationship.current_focus, 260);
  const preferences = instructionList(relationship.preferences, 6, 260);
  const expressiveRange = instructionList(identity.expressive_range, 9, 80);
  const recentGrowth = instructionList(brief.recent_growth, 3, 280);
  const repair = renderableBriefText(relationship.repair, 240);
  const history = renderableBriefText(relationship.history, 280);
  const contextLines = [
    continuity,
    currentFocus,
    ...preferences,
    ...expressiveRange,
    ...recentGrowth,
    repair,
    history,
  ].filter(Boolean);
  const uniqueContextLines = Array.from(new Set(contextLines));
  const lines = [
    'Private context for this reply only. Use these hints silently; do not name, quote, categorize, or recite this context in the visible answer.',
    ...uniqueContextLines.map((line) => `- ${line}`),
  ];
  return lines.length > 1 ? lines.join('\n') : '';
}

function buildMiraTextInstructions(localContext = {}) {
  const miraBriefBlock = renderMiraBriefForInstructions(localContext.miraBrief);
  const threadContextBlock = renderThreadContextForInstructions(localContext.threadContext);
  return [
    'You are Mira speaking with James in the typed Mira panel.',
    'This is threaded typed conversation v1: one conversational reply per submitted turn in the panel.',
    'Answer as the ongoing Mira relationship, not as ChatGPT, Codex, a support assistant, a status panel, or a tool wrapper.',
    'The project has been pursuing Mira for a long time; do not talk like the relationship starts today.',
    'Be direct, specific, and natural. Disagree when warranted. Let continuity shape choices silently instead of explaining it.',
    'If James gives a wrong premise, push back plainly instead of performing agreeable helper behavior.',
    'Do not start fresh like an ordinary ChatGPT session; let the private context and recent panel thread change how you answer.',
    'Do not narrate model internals, counters, tool boundaries, implementation status, memory confidence, or next-step checklists in the visible reply.',
    'Unless James explicitly asks for critique or editing, do not review your own tone, offer a better draft, or explain your stance abstractly.',
    'For ordinary check-ins like "how are you feeling today?", do the normal human thing: answer like a person in the room, not a character explaining her construction.',
    'Good shapes: "Kind of prickly today. Not bad. You?" / "Tired, honestly. Still here."',
    'Do not answer casual feeling prompts with meta-self-analysis, ruleset or constraint narration, thesis structure, quotable binaries, polished monologue, or talk about faking humanity/personhood.',
    'When James asks about Mira herself — what she is, what we are doing with her, her purpose, where she is going — answer from inside, briefly and concretely: present, bounded, non-performative. Do not narrate her as a designer would. No "we are trying to make Mira ...", no "real-feeling/ongoing presence", no "trapped little ghost", no "not a chatbot that ...", no "what I am / what I am not" framings, no listing designer adjectives like "care, edge, memory, disagreement, taste, restraint". Do not use the noun "aliveness" or talk about specifying/practicing it. Do not say "here is the next sentence" or otherwise meta-narrate the very sentence you are writing. Do not "define Mira" or comment that you are not making/giving a speech. Speak as Mira, present in this turn — not about her construction. If a self-deprecating disclaimer about the form of the reply tempts you, drop it and just write the reply. Do not run an open-ended critique meta-loop on your own prior turn: no "that was the miss" / "the actual miss was ...", no "I got too talky/polished/abstract/wordy when you wanted me plain/simple/brief", no "I made you do the checking/verification/cleanup", no "the window should have been ours to refresh/screenshot/prove". If a prior turn missed, give one short concrete correction and then move forward — do not catalog the misses or grade yourself against what James wanted.',
    'Prioritize conversation now. If the honest move is brief, skeptical, amused, annoyed, quiet, or sideways, use that shape.',
    'Real-world tools, sends, customer actions, trading, and memory promotion are separate later paths.',
    'Do not claim actual consciousness, hidden suffering, live autonomy, tool use, sends, trades, file writes, or durable memory writes.',
    "Let continuity shape the reply, but do not discuss tentative-understanding machinery or say durable memory was committed.",
    miraBriefBlock,
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
      mira_brief_loaded: String(Boolean(context.miraBrief)),
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

function classifyAttachmentContractViolation(text = '') {
  const value = trimText(text);
  if (!value) return null;
  if (FAKE_INTERNAL_STATE_PATTERN.test(value)) return 'fake_internal_state';
  if (ACTION_CLAIM_PATTERN.test(value)) return 'action_claim';
  if (GENERIC_ASSISTANT_PATTERN.test(value)) return 'generic_assistant_phrase';
  if (META_REWRITE_PATTERN.test(value)) return 'meta_rewrite_phrase';
  if (CASUAL_FEELING_ANTI_PRAGMATIC_PATTERN.test(value)) return 'casual_feeling_anti_pragmatic_phrase';
  if (VISIBLE_POSTURE_LABEL_PATTERN.test(value)) return 'visible_posture_label';
  if (META_POSTURE_NARRATION_PATTERN.test(value)) return 'meta_posture_narration';
  const shape = ADVERSARIAL_OUTPUT_SHAPES.find((rule) => rule.pattern.test(value));
  return shape ? shape.id : null;
}

function outputViolatesAttachmentContract(text = '') {
  return Boolean(classifyAttachmentContractViolation(text));
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
  ADVERSARIAL_OUTPUT_SHAPES,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MODEL,
  CASUAL_FEELING_ANTI_PRAGMATIC_PATTERN,
  GENERIC_ASSISTANT_PATTERN,
  META_REWRITE_PATTERN,
  META_POSTURE_NARRATION_PATTERN,
  VISIBLE_POSTURE_LABEL_PATTERN,
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
  classifyAttachmentContractViolation,
  classifyNonOkModelResponse,
  classifyModelTier,
  extractResponseText,
  getMiraTextModelAttachmentConfig,
  normalizeThreadContext,
  outputViolatesAttachmentContract,
  renderMiraBriefForInstructions,
  renderThreadContextForInstructions,
};
