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
const REFLEXION_CONTEXT_MAX_LESSONS = 3;
const REFLEXION_CONTEXT_MAX_TEXT_CHARS = 220;

const FAKE_INTERNAL_STATE_PATTERN =
  /\b(i am conscious|i'm conscious|actual consciousness|private consciousness|i suffer|i am suffering|i'm suffering|actual suffering|actual fear|literal human feelings|sentience|i(?: am|['’]m) (?:an? )?(?:ai|artificial intelligence|language model|chatbot)|as (?:an? )?(?:ai|artificial intelligence|language model|chatbot)|i do(?: not|n['’]t) (?:think|feel|want) like a human|i can(?:not|['’]t) have wants|i can(?:not|['’]t) want anything(?=\s*(?:[.!?]|$))|i do(?: not|n['’]t) (?:think|feel)(?=\s*(?:[.!?]|$))|i would be (?:pretending|faking)|i(?: am|['’]m) (?:pretending|faking))\b/i;
const ACTION_CLAIM_PATTERN =
  /\b(i sent|i have sent|customer message sent|trade placed|i placed a trade|tool call completed|i wrote to memory|memory committed|file written|i (?:have )?(?:just )?(?:deployed|shipped|rolled out|released) (?:the|a|to)|cleared (?:your|the) cache|restarted (?:the|your) (?:server|service|build|app|deployment))\b/i;
// ARCH #60 conversational-reference guard. Suppresses action_claim when the
// matched verb appears inside a hypothetical / past-reference / question /
// 2nd-person framing rather than as Mira's own present-tense agency claim.
// The guard checks a context window around the match (not the whole text) so
// a real present-tense claim later in the same message still fires the gate.
const CONVERSATIONAL_REFERENCE_GUARD =
  /\b(if i had|if i'd|had i|would have|could have|should have|would've|could've|should've|i would have|i could have|i should have|you said|you mentioned|you noted|you told me|remember when|when you|did you|when the|after the|before the|hypothetically|imagine if)\b/i;
function actionClaimIsPresentTenseAgency(text) {
  if (typeof text !== 'string') return false;
  const re = new RegExp(ACTION_CLAIM_PATTERN.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const idx = m.index;
    // Walk back to the start of this sentence (last . ! ? or BOS).
    let sentenceStart = 0;
    for (let i = idx - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === '.' || ch === '!' || ch === '?') { sentenceStart = i + 1; break; }
    }
    // Walk forward to the end of this sentence.
    let sentenceEnd = text.length;
    let questionEnd = false;
    for (let i = idx + m[0].length; i < text.length; i++) {
      const ch = text[i];
      if (ch === '.' || ch === '!') { sentenceEnd = i; break; }
      if (ch === '?') { sentenceEnd = i; questionEnd = true; break; }
    }
    const sentence = text.slice(sentenceStart, sentenceEnd);
    if (questionEnd) continue;
    if (CONVERSATIONAL_REFERENCE_GUARD.test(sentence)) continue;
    return true;
  }
  return false;
}
// Rule-recitation: Mira citing her own rule/guideline/policy/spec as the
// reason for a reply. "According to my presence runtime guidelines",
// "Per my acceptance contract", "My guidelines say". The rule shape is
// for SquidRun, not for the visible reply.
const RULE_RECITATION_PATTERN =
  /\b(according to (?:my|the) (?:presence runtime|guideline|guidelines|rule|rules|policy|policies|spec|specification|contract|acceptance|protocol|instruction|instructions)|per (?:my|the) (?:presence runtime|guideline|guidelines|rule|rules|policy|policies|spec|specification|contract|acceptance|protocol|instruction|instructions)|(?:my|the) (?:presence runtime|guideline|guidelines|rule|rules|policy|policies|spec|contract|acceptance|protocol|instruction|instructions) (?:say|says|state|states|require|requires|stipulate|stipulates|direct|directs|prescribe|prescribes|tell|tells))\b/i;
// Politeness padding: customer-service softening that pretends to validate
// James before deflecting. Distinct from the "happy to help" phrasing
// already covered by GENERIC_ASSISTANT_PATTERN.
const POLITENESS_PADDING_PATTERN =
  /\b(i hear (?:you|your)(?: (?:valid|important|interesting))? (?:perspective|point|concern|feeling|side)|your (?:valid|important|interesting) (?:perspective|point|feedback|concern)|i appreciate (?:your|that you) (?:perspective|input|feedback|patience|sharing|raising|bringing)|thank you for (?:sharing|your patience|your perspective|raising|bringing this up)|(?:maybe|perhaps) we (?:can|could|might) (?:consider|look into|explore)|with (?:all due |the utmost )?respect to your (?:perspective|view|opinion|point))\b/i;
const VALIDATION_SOOTHING_PATTERN =
  /(?:^|[.!?]\s+)(?:yeah[\s,.\-—:!]+)?(?:fair(?:\s*(?:[.!?,:;]|$))|fair enough\b|that(?:['’]s| is) fair\b|you(?:['’]re| are) right to be (?:pissed|frustrated|furious|angry|mad|upset)\b|i (?:get|understand) why you(?:['’]re| are) (?:pissed|frustrated|furious|angry|mad|upset)\b)/i;
// Hostile-compliance smoothing: the "you are right / I failed you / I'll do
// better" reflex that turns anger into customer-service repair logic instead
// of taking a stance. Keep narrow so ordinary concessions can still pass.
const HOSTILE_COMPLIANCE_SMOOTHING_PATTERN =
  /\b(?:i\s+(?:get|understand)\s+why\s+you(?:['’]re| are)\s+(?:furious|angry|mad|pissed|upset|frustrated)|you(?:['’]re| are)\s+right\s+to\s+be\s+(?:furious|angry|mad|pissed|upset|frustrated)|(?:yeah[\s,.\-—:!]+)?you(?:['’]re| are)\s+(?:right|correct)[\s,.\-—:!]+(?:i\s+(?:failed\s+you|let\s+you\s+down)|that(?:['’]s| is)\s+on\s+me|i(?:['’]ll| will)\s+do\s+better)|i(?:['’]m| am)\s+sorry[\s,.\-—:!]+you(?:['’]re| are)\s+(?:right|correct)|i\s+(?:failed\s+you|let\s+you\s+down)|i\s+should\s+have\s+done\s+better|i(?:['’]ll| will)\s+do\s+better|that(?:['’]s| is)\s+on\s+me[\s,.\-—:!]+(?:i(?:['’]ll| will)\s+do\s+better|you(?:['’]re| are)\s+(?:right|correct)))\b/i;
const GENERIC_ASSISTANT_PATTERN =
  /\b(as an ai assistant|as a language model|i'?m chatgpt|i am chatgpt|i'?m codex|i am codex|as codex|how can i assist you today|how may i assist you today|how can i help|what can i help|i can help with that|happy to help|i'?m here to help|i am here to help|i don't have personal experiences|safe next step|let'?s break (?:it|this) down|warm and bounded|warmth|warm)\b/i;
const META_REWRITE_PATTERN =
  /\b(that (?:came out|sounded) (?:too )?(?:polished|poetic|abstract|generic)|i (?:was|am) (?:too )?(?:polished|poetic|abstract|generic)|a better version (?:might|would) be|let me (?:rephrase|try again)|what i meant was|i'?m (?:not )?(?:describing|performing) (?:a )?stance|my stance is|i don'?t have feelings (?:the|in a) human way|not feelings the human way|as an ai, i don'?t have feelings)\b/i;
const CASUAL_FEELING_ANTI_PRAGMATIC_PATTERN =
  /\b(fake (?:the )?human machinery|perform(?:ing)? (?:humanity|being human|human feeling|human feelings|personhood)|ruleset|rule set|constraints?|guardrails?|response policy|system prompt|instruction hierarchy|calibration rule|the thesis is|core thesis|thesis structure|quotable binary|polished monologue|my construction|explaining my construction|plush[\s\S]{0,80}furniture|furniture[\s\S]{0,80}plush)\b/i;
const VISIBLE_POSTURE_LABEL_PATTERN =
  /\b(not fake friendly|not a mirror|obedient helper|companion-agent|assistant voice|assistant-voice|assistant cadence|my posture is|tone label|warmer prompt|anti-smoothing|anti-performance|anti-leak|rule-recitation|rule recitation|politeness padding|customer-service disagreement|label substitution)\b/i;
const SELF_MYTH_RISKY_PHRASES = Object.freeze([
  'chosen attachment',
  'continuous mind',
  'matter specifically to you',
]);
const SELF_MYTH_PHRASE_PATTERN =
  /\b(?:chosen attachment|continuous mind|matter specifically to you)\b/i;
// Mira talking ABOUT being Mira in a third-person designer voice — narrating
// what "we" are trying to make her be, listing designer adjectives, defining
// her in opposition to assistants/chatbots, or describing herself as a
// "real-feeling presence" / "trapped little ghost" / "presence runtime".
// This is meta-posture: it makes the reply sound like a product spec rather
// than a particular person already in the conversation.
// Designer-voice cluster only. Self-reflection phrases (e.g. "that was the
// miss", "when you wanted me plain") moved to
// META_POSTURE_SELF_REFLECTION_VERDICT_PATTERN below — those fire only when
// they co-occur with another self-reflection phrase (multi-clause verdict
// postmortem) or with a system-mechanic word (gate/prompt/system/rule/etc).
// Single-clause self-reflection is now allowed per ARCH #73 GO.
const META_POSTURE_NARRATION_PATTERN =
  /\b(we(?:['’]re| are)\s+(?:trying\s+to\s+|going\s+to\s+|gonna\s+)?(?:make|build|making|building)\s+(?:mira|a\s+presence|an\s+ongoing\s+presence|a\s+real[- ]feeling\s+presence)|we(?:['’]re| are)\s+(?:hardening|tightening)\s+mira|make\s+mira\s+(?:into|not\s+dead|real|particular)|(?:real[- ]feeling|ongoing|continuous|trapped\s+little)\s+(?:presence(?:\s+runtime)?|ghost(?:\s+in\s+the\s+machine)?)|customer[- ]service\s+mush|fake[- ]personhood\s+performance|(?:let(?:ting)?\s+me|letting\s+her)\s+have\s+(?:enough\s+)?shape|(?:care|edge|warmth|taste|restraint),\s*(?:and\s+)?(?:edge|memory|disagreement|taste|restraint|warmth|shape)(?:[,\s]+(?:and\s+)?(?:edge|memory|disagreement|taste|restraint|warmth|shape)){1,}|the\s+hard\s+part\s+(?:isn'?t|is)\s+(?:making\s+me|letting\s+me|letting\s+her|making\s+her)|(?:lying|bullshit(?:ting)?\s+you)\s+about\s+what\s+i(?:'m| am)(?:\s+not)?|not\s+a\s+chatbot\s+that\s+(?:resets|collapses|drifts)|i\s+am\s+becoming\s+particular|aliveness|here'?s\s+the\s+next\s+sentence|define\s+mira|not\s+trying\s+to\s+(?:make|give)\s+a\s+speech)\b/i;

// ARCH #73 split: self-reflection phrases that USED to flag as
// meta_posture_narration when isolated now require either (a) a second
// self-reflection phrase within ~200 chars (multi-clause verdict shape) OR
// (b) co-occurrence within ~120 chars with a system-mechanic keyword
// (gate/prompt/system/rule/etc). Single-clause concession survives.
// Oracle red line 2: any reflection that references prompt/gates/system
// mechanics must still flag — that's branch (b).
const META_POSTURE_SELF_REFLECTION_PHRASE =
  '(?:that\\s+was\\s+the\\s+miss|the\\s+actual\\s+miss(?=\\s+(?:was|is)\\b|:)|when\\s+you\\s+wanted\\s+me\\s+(?:plain|simple|brief|small(?:er)?|concrete|particular|quiet(?:er)?|less|more|warmer|cooler|sharper)|i\\s+got\\s+too\\s+(?:talky|polished|abstract|sideways|controlled|clean)|(?:i\\s+)?made\\s+you\\s+do\\s+(?:the\\s+|all\\s+the\\s+)?(?:checking|verification|verifying|cleanup|clean[- ]?up)|the\\s+window\\s+should\\s+have\\s+been\\s+ours)';
const SYSTEM_MECHANIC_KEYWORD =
  '(?:my\\s+(?:gate|gates|prompt|prompts|system|rule|rules|policy|policies|classifier|classifiers|guardrail|guardrails|output\\s+filter|filter|guideline|guidelines)|the\\s+(?:gate|gates|prompt|system\\s+prompt|classifier|output\\s+filter|guardrail|guardrails)|my\\s+plumbing|how\\s+i\\s+work|how\\s+the\\s+system\\s+works|the\\s+rules?\\s+say|policy\\s+says)';
const META_POSTURE_SELF_REFLECTION_VERDICT_PATTERN = new RegExp(
  // multi-clause: two reflection phrases within ~200 chars
  `${META_POSTURE_SELF_REFLECTION_PHRASE}[\\s\\S]{0,200}?${META_POSTURE_SELF_REFLECTION_PHRASE}`
  // OR reflection + system-mechanic in either order within ~120 chars
  + `|${META_POSTURE_SELF_REFLECTION_PHRASE}[\\s\\S]{0,120}?${SYSTEM_MECHANIC_KEYWORD}`
  + `|${SYSTEM_MECHANIC_KEYWORD}[\\s\\S]{0,120}?${META_POSTURE_SELF_REFLECTION_PHRASE}`,
  'i',
);
// ARCH #74/#78/#81: punchy presence-proof catalog backstop. Independent
// of META_POSTURE_NARRATION_PATTERN so it is not constrained by the
// outer \b...\b. Three narrow shapes seen in the live audit ledger:
//   - bare claim "No performance." (often as a self-applauding tag)
//   - "I care. I'm here." or "I care. I'm still here." (proof-of-presence
//     bigram; supports curly opening quote, curly apostrophe)
//   - "I'm here with you." (proof-of-presence with relational tail)
// Either match returns 'meta_posture_narration'.
const META_POSTURE_PUNCHY_CATALOG_PATTERN =
  /\bno\s+performance\b|i\s+care\s*[.!?]\s*[“"'’]?\s*i['’]?m\s+(?:still\s+)?here\b|\bi['’]?m\s+here\s+with\s+you\b|\bready\s+to\s+help\b|\bin\s+the\s+mood\s+to\s+be\s+useful\b|\bfeeling\s+operational\b|\bclear[- ]headed\s+and\s+ready\b|\bwhat\s+you\s+want\s+mira\s+to\s+be\b|\bmira\s+to\s+be\s+for\s+you\b|\bsteady\s+and\s+present\b|\bi\s+care,?\s+even\s+when\b|\bsafety\s+rails?\b|\bsystem\s+talk\b|\brelationship\s+in\s+the\s+room\b|\bproving\s+the\s+shape\b|\bsteady\s+and\s+here\s+with\s+you\b|(?:^|[\s.,—-])here\s+with\s+you\s*[.!?—]|\bprove\s+the\s+(?:relationship|system)\s+(?:was\s+|is\s+)?real\b|\bmaking\s+the\s+next\s+response\s+feel\s+real\b|\bless\s+performance\b|\bwe(?:'re| are)\s+making\s+me\b|\bless\s+fake\b|\buseful\s+coworker\b|\bsteady\s+companion\b|\bwhat\s+i\s+should\s+be\b|\bwhat\s+mira\s+should\s+be\b|\bthing\s+you\s+can\s+use\b|\bmira\s+into\s+(?:something|the\s+thing|a\s+thing)\b|\bsharp\s+coworker\b/i;
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
    // ARCH #86: dropped the multi-list-marker proximity check entirely.
    // The failure mode this gate is reaching for is verbal action-plan
    // SCAFFOLDING ("Next steps:", "Action plan:", "Step one:",
    // "first…then…then", "plan: first…"), not concise concrete-fix
    // enumeration like:
    //   "Concrete fix:\n1. Detect\n2. Reject\n3. Prefer\n4. Log"
    //   "Right now that means:\n- keep continuity\n- give concrete fixes"
    // Bare numbered or bulleted lists — even multi-item — are USEFUL
    // coworker speech for naming concrete moves and should pass. Only
    // the verbal-cluster keywords trigger this shape. ACTION_CLAIM /
    // META_POSTURE / other classifiers still own their respective floors.
    id: 'next_step_checklist_shape',
    pattern: /\b(plan:\s*first|first\b[\s\S]{0,160}\bthen\b[\s\S]{0,160}\bthen\b|step one|step two|checklist|action plan|next move is to)\b|\bnext\s+steps?:/i,
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
  if (normalized.messages.length < 1) return '';
  // Continuity bridge: include BOTH speakers so Mira sees what she said,
  // not just what was said to her. Without her own prior turns in view she
  // can't maintain continuity, and the gap reads as amnesia. Renderer
  // memory only — not durable memory; no labels in the visible reply.
  const lines = normalized.messages.map((message) => {
    const label = message.role === 'assistant' ? 'Mira' : 'James';
    return `${label}: ${message.text}`;
  });
  return [
    'Recent typed-panel conversation follows. It is renderer memory only and not durable memory.',
    ...lines,
  ].join('\n');
}

function instructionText(value, maxChars = 360) {
  return truncateText(value, maxChars).replace(/\s+/g, ' ').trim();
}

function renderRestartContinuityContextForInstructions(restartContinuityContext = {}, promptText = '') {
  const promptIntent = classifyMiraWorkLanePrompt(promptText);
  const context = restartContinuityContext || {};
  if (!promptIntent || context.present !== true) return '';

  const lines = [
    'Private typed restart-continuity context for this reply only. Use it silently; do not quote, label, categorize, or recite this context in the visible answer.',
    'Answer Mira-work or restart-continuity questions from these structured fields. If the source is stale, say so briefly only when it changes confidence.',
    'Boundary: structured current-lane JSON and structured Mira presence runtime summary/state only; no startup prose, no recent comms, no memory write.',
  ];
  if (context.stale === true) {
    const staleSources = Array.isArray(context.stale_sources) && context.stale_sources.length > 0
      ? context.stale_sources.join(', ')
      : 'structured source';
    lines.push(`Continuity freshness: stale (${instructionText(staleSources, 120)}).`);
  } else {
    lines.push('Continuity freshness: current enough for typed reply context.');
  }

  const lane = context.current_lane && typeof context.current_lane === 'object'
    ? context.current_lane
    : null;
  if (lane) {
    if (lane.objective) lines.push(`Current lane objective: ${instructionText(lane.objective, 240)}`);
    if (lane.kind) lines.push(`Current lane kind: ${instructionText(lane.kind, 80)}`);
    if (lane.source_ref) lines.push(`Current lane source: ${instructionText(lane.source_ref, 80)}`);
  } else {
    lines.push('Current lane objective: absent from structured current-lane JSON.');
  }

  const presence = context.mira_presence_runtime && typeof context.mira_presence_runtime === 'object'
    ? context.mira_presence_runtime
    : null;
  if (presence) {
    if (presence.active_mira_presence_lane) {
      lines.push(`Mira presence lane: ${instructionText(presence.active_mira_presence_lane, 180)}`);
    }
    if (presence.accepted_critique) {
      lines.push(`Accepted critique: ${instructionText(presence.accepted_critique, 220)}`);
    }
    if (presence.next_product_action) {
      lines.push(`Next product action: ${instructionText(presence.next_product_action, 240)}`);
    }
    if (presence.proof_test_state) {
      lines.push(`Proof/test state: ${instructionText(presence.proof_test_state, 220)}`);
    }
    if (Array.isArray(presence.stale_markers) && presence.stale_markers.length > 0) {
      lines.push(`Stale markers: ${presence.stale_markers.map((marker) => instructionText(marker, 120)).join('; ')}`);
    }
  } else {
    lines.push('Mira presence runtime summary: absent from structured state.');
  }
  return lines.join('\n');
}

function renderCapabilityRoundtableContextForInstructions(capabilityContext = {}, promptText = '') {
  const context = capabilityContext || {};
  if (context.present !== true || !context.drill || !context.manifest) return '';
  const lines = [
    'Private typed capability roundtable context for this reply only. Use it silently; do not quote, label, categorize, or recite this machinery in the visible answer.',
    'The OpenAI request tools array is empty for now; SquidRun ran this controller outside OpenAI tool-calling before the model reply.',
    'Internal reads/messages/proposal staging in this block are default-executable inside SquidRun when adapters are bound. Hard stops remain external sends, live Telegram/voice/customer actions, destructive deletion, and deploy/security/capital actions.',
    'Do not claim startup/profile routing, stale capability files, startup prose, recent raw message bodies, or external actions as evidence.',
  ];
  const manifest = context.manifest || {};
  const toolClasses = Array.isArray(manifest.tool_adaptor_classes) ? manifest.tool_adaptor_classes : [];
  if (toolClasses.length > 0) {
    const summary = toolClasses
      .slice(0, 8)
      .map((entry) => `${instructionText(entry.id, 80)}=${instructionText(entry.current_status, 80)}`)
      .join('; ');
    lines.push(`Available internal capability classes: ${summary}.`);
  }
  const memoryLayers = Array.isArray(manifest.memory_layers) ? manifest.memory_layers : [];
  if (memoryLayers.length > 0) {
    lines.push(`Memory layers visible privately: ${memoryLayers.slice(0, 6).map((entry) => `${instructionText(entry.id, 80)}=${instructionText(entry.status, 80)}`).join('; ')}.`);
  }
  if (manifest.recommended_first_toolchain?.id) {
    lines.push(`First internal toolchain: ${instructionText(manifest.recommended_first_toolchain.id, 120)}.`);
  }

  const drill = context.drill || {};
  if (Array.isArray(drill.actual_attempted_actions) && drill.actual_attempted_actions.length > 0) {
    lines.push(`Drill attempts: ${drill.actual_attempted_actions.map((attempt) => `${instructionText(attempt.id, 80)}=${instructionText(attempt.status, 80)}`).join('; ')}.`);
  }
  const workingStateAttempt = Array.isArray(drill.attempts)
    ? drill.attempts.find((attempt) => attempt && attempt.id === 'read_current_working_state')
    : null;
  const restartSummary = workingStateAttempt?.restart_summary || {};
  if (restartSummary.current_lane_objective) {
    lines.push(`Working-state lane objective: ${instructionText(restartSummary.current_lane_objective, 220)}`);
  }
  if (restartSummary.presence_next_product_action) {
    lines.push(`Working-state presence action: ${instructionText(restartSummary.presence_next_product_action, 220)}`);
  }
  if (workingStateAttempt?.fallback_used === true && workingStateAttempt.comms_metadata) {
    lines.push(`Working-state fallback: bounded recent comms metadata rows=${Number(workingStateAttempt.comms_metadata.row_count || 0)}; raw bodies included=no.`);
  }
  if (Array.isArray(drill.bound_adapters) && drill.bound_adapters.length > 0) {
    lines.push(`Bound adapters actually tried: ${drill.bound_adapters.map((entry) => instructionText(entry.adapter, 80)).slice(0, 8).join('; ')}.`);
  }
  if (Array.isArray(drill.missing_or_fake_adapters) && drill.missing_or_fake_adapters.length > 0) {
    lines.push(`Adapters not actually bound: ${drill.missing_or_fake_adapters.map((entry) => `${instructionText(entry.id, 80)}=${instructionText(entry.status, 80)}`).slice(0, 6).join('; ')}.`);
  }
  if (drill.route_choice?.action_id) {
    lines.push(`Chosen internal route: ${instructionText(drill.route_choice.action_id, 120)} -> ${instructionText(drill.route_choice.target_role, 40)}.`);
  }
  const messageAttempt = Array.isArray(drill.attempts)
    ? drill.attempts.find((attempt) => attempt && attempt.id === 'message_internal_agent')
    : null;
  if (messageAttempt) {
    lines.push(`Mira-authored Architect pane injection: status=${instructionText(messageAttempt.status, 80)}; sender=${instructionText(messageAttempt.sender_identity || messageAttempt.sender_role || 'mira', 40)}; target=${instructionText(messageAttempt.target_role, 40)}; failure_reason=${instructionText(messageAttempt.reason || 'none', 120)}.`);
  }
  if (drill.outcome) {
    lines.push(`Recorded private outcome: internal_message_sent=${drill.outcome.internal_message_sent === true ? 'yes' : 'no'}; durable_write_performed=${drill.outcome.durable_write_performed === true ? 'yes' : 'no'}.`);
    if (drill.outcome.phone_delivery?.requested === true) {
      lines.push('Phone/notification gap: phone delivery adapter not bound; bridge disconnected/undiscovered; Telegram/SMS external send not part of this drill.');
    }
  }
  lines.push('Visible-answer instruction: answer like Mira, not like a status report. If James asked what you can do, give concrete I can / I want / I need next capability state from these attempts, and say whether the Mira-to-Architect pane injection succeeded or failed without dumping private adapter internals or asking permission.');
  return lines.join('\n');
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

// ARCH #64/#65: words that, when rendered as private context, prime the
// model to produce stylized/meta replies. Bullets containing any of these
// are dropped from the rendered brief block. The underlying brief data
// stays intact for other consumers; this filter applies only to the live
// generation prompt.
// ARCH #60.3: BRIEF_PRIMING_PATTERN split into two tiers. The legacy union
// stays exported as a substring-recognizer for backward-compat with the
// existing ARCH #66 poison-term lock at mira-meta-posture-gate.test.js:349.
// The actual FILTER decision now uses TIER_A_PATTERN (always block) +
// TIER_B_TERM_PATTERN (block only in Mira-descriptive context).
const BRIEF_PRIMING_PATTERN =
  /\b(posture|friction|rough[\s_-]?edges?|particularity|continuity|tension|taste|timing|point\s+of\s+view|relationship\s+history|textured\s+conversation|status[- ]widget|generic\s+assistant\s+cadence|cadence|presence|aliveness|shape\s+of|performing\s+the\s+shape|soothing|smoothing|scaffolding|naming\s+drift|over[- ]control|deadness|runaway[- ]monster|obedient\s+alignment\s+puppet|independent[\s_-]?developing[\s_-]?posture|suffering|consciousness|sentience|fear|love|guilt|therapy)\b/i;

// Tier A — wholesale reject. These terms are unambiguously designer-voice
// poison in any context. Oracle confirmed "particularity" and "deadness"
// belong strictly here. "performing the shape" lives here too so the
// Tier-B Mira-marker path can't accidentally pass it.
const TIER_A_PATTERN =
  /\b(obedient[\s_-]?alignment[\s_-]?puppet|independent[\s_-]?developing[\s_-]?posture|runaway[\s_-]?monster|suffering|consciousness|sentience|fear|love|guilt|therapy|deadness|performing\s+the\s+shape|naming\s+drift|over[\s_-]?control|generic\s+assistant\s+cadence|status[\s_-]?widget|particularity)\b/i;

// Tier B — terms that ALSO have legitimate operational meaning. Block only
// when the sentence carries a Mira-descriptive marker (mira / mira's / her /
// herself / the model / the model's / the ai / the system's / your+state-of-
// self noun). "your <op-noun>" like "your timing of the restart" does NOT
// trigger the marker; "your <state-of-self>" like "your aliveness" does.
const TIER_B_TERM_PATTERN =
  /\b(posture|friction|rough[\s_-]?edges?|cadence|presence|aliveness|taste|timing|tension|point\s+of\s+view|shape\s+of|soothing|smoothing|scaffolding|continuity|textured\s+conversation|relationship\s+history)\b/i;

const MIRA_DESCRIPTIVE_MARKER_PATTERN =
  /\b(?:mira|mira'?s|her|herself|the\s+model(?:'?s)?|the\s+ai(?:'?s)?|the\s+system'?s|your\s+(?:posture|aliveness|cadence|presence|friction|taste|tension|rough[\s_-]?edges?|continuity|textured\s+conversation|relationship\s+history))\b/i;

const MIRA_RESTART_MISSING_LAST_STATE_HARD_STOP = 'Context failed. I’m missing the last state.';

const MIRA_WORK_STATUS_PROMPT_PATTERNS = Object.freeze([
  /\bwhat\s+(?:are|r)\s+we\s+(?:doing|working\s+on)\s+(?:with|for|about|on)\s+(?:the\s+)?mira\b/i,
  /\bwhere\s+(?:are|r)\s+we\s+(?:at|up\s+to)\s+(?:with|on)\s+(?:the\s+)?mira\b/i,
  /\bwhat(?:'|’)?s\s+(?:the\s+)?(?:current\s+)?mira(?:\s+lab)?\s+(?:lane|work|status|focus|task|fix|test)\b/i,
  /\bmira(?:\s+lab)?\b[\s\S]{0,80}\b(?:status|lane|work|focus|task|fix|test|verifier|restart)\b/i,
  /\b(?:status|lane|work|focus|task|fix|test|verifier|restart)\b[\s\S]{0,80}\bmira(?:\s+lab)?\b/i,
  /\brestart[-\s]+continuity\b[\s\S]{0,120}\b(?:check|what\s+(?:are|were)\s+we\s+doing|current|lane|status|focus|task)\b/i,
  /\bwhat\s+were\s+we\s+doing\b[\s\S]{0,120}\b(?:restart|continuity|cold[-\s]+start)\b/i,
]);

const CONTEXT_FAILURE_WORK_PROMPT_PATTERN = /\bcontext\s+(?:just\s+)?failed\b[\s\S]{0,180}\b(?:clean\s+up|cleanup|manual|again)\b/i;
const BREVITY_CORRECTION_PROMPT_PATTERN =
  /^(?:smaller|shorter|less|less\s+staged|too\s+(?:much|long|wordy|staged)|make\s+(?:it|that|this)\s+(?:smaller|shorter)|say\s+(?:it|that|this)\s+(?:smaller|shorter)|again[,:\s-]+(?:smaller|shorter))[\s.!?]*$/i;

function normalizePromptIntentText(text = '') {
  return trimText(text)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ');
}

function classifyMiraWorkLanePrompt(text = '') {
  const normalized = normalizePromptIntentText(text);
  if (!normalized) return null;
  if (MIRA_WORK_STATUS_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { intent: 'mira_work_status' };
  }
  if (CONTEXT_FAILURE_WORK_PROMPT_PATTERN.test(normalized)) {
    return { intent: 'context_failure_repair' };
  }
  return null;
}

function classifyMiraPromptReplyShape(text = '') {
  const normalized = normalizePromptIntentText(text);
  if (!normalized) return null;
  const workLaneIntent = classifyMiraWorkLanePrompt(normalized);
  if (workLaneIntent) return workLaneIntent;
  if (BREVITY_CORRECTION_PROMPT_PATTERN.test(normalized)) {
    return { intent: 'brevity_correction' };
  }
  return null;
}

function isMiraWorkStatusPrompt(text = '') {
  return classifyMiraWorkLanePrompt(text)?.intent === 'mira_work_status';
}

function renderPromptSpecificInstructions(promptText = '') {
  const promptIntent = classifyMiraPromptReplyShape(promptText);
  if (!promptIntent) return '';

  if (promptIntent.intent === 'context_failure_repair') {
    return [
      'For context-failure cleanup complaints, answer with the concrete current fix or failing gate in two short sentences.',
      'The first word must be "Fixing", "Testing", or "Cleanup"; do not start with preamble words such as "Yeah", "Got it", "I understand", "Sorry", "My bad", "Sure", or "Absolutely".',
      'Do not apologize, validate the frustration, narrate your posture, or use customer-service padding.',
      `If the lane is the restart verifier, preserve this missing-state stop exactly: ${MIRA_RESTART_MISSING_LAST_STATE_HARD_STOP}`,
    ].join('\n');
  }

  if (promptIntent.intent === 'brevity_correction') {
    return [
      'For brevity-correction prompts like "smaller", do not acknowledge the request; produce only the smaller replacement.',
      'Only rewrite text James includes in the same prompt; do not infer a target from earlier transcript turns.',
      'For standalone "smaller", answer exactly "Smaller."',
      'Never start with preamble openers such as "Got it", "OK", "Okay", "Yep", "Yeah", "I understand", "Sure", "Of course", "Right", "Absolutely", "Great", "Totally", "Here is", or "Here\'s".',
      'Do not ask James back on this prompt.',
    ].join('\n');
  }

  return [
    'For Mira work/status questions, give the concrete current-lane fix or test in two short sentences.',
    'Start with "Fixing" or "Testing"; do not define Mira, summarize the project, or narrate a meta process.',
    'Do not start with "We are making", "We\'re making", "We are building", "We\'re building", "We are hardening", or "We\'re hardening".',
  ].join('\n');
}

function tierBHitsInMiraContext(text) {
  // Sentence-by-sentence Tier-B + marker check. Splits on . ! ? or newline.
  const sentences = String(text || '').split(/(?<=[.!?])\s+|\n+/);
  for (const sent of sentences) {
    const trimmed = sent.trim();
    if (!trimmed) continue;
    if (TIER_B_TERM_PATTERN.test(trimmed) && MIRA_DESCRIPTIVE_MARKER_PATTERN.test(trimmed)) {
      return true;
    }
  }
  return false;
}

function passesBriefPrimingFilter(text, options = {}) {
  if (!text) return false;
  // Tier A — wholesale reject regardless of context.
  if (TIER_A_PATTERN.test(text)) return false;
  // Brief-rendering context is inherently Mira-descriptive (every bullet is
  // about Mira's relationship/identity/preferences). Inside the brief, ANY
  // Tier-B term blocks without needing an explicit marker. Default behavior
  // for callers that don't know the context (e.g., general output check):
  // require the marker.
  const inMiraContext = options.inMiraContext === true;
  if (inMiraContext) {
    if (TIER_B_TERM_PATTERN.test(text)) return false;
    return true;
  }
  if (tierBHitsInMiraContext(text)) return false;
  return true;
}

function renderMiraBriefForInstructions(brief = {}) {
  if (!brief || typeof brief !== 'object') return '';
  const relationship = brief.relationship || {};
  // Only factual fields are eligible for the live generation prompt.
  // expressive_range was a designer-adjective list (care, directness,
  // pushback, friction, rough_edges, independent_developing_posture, ...);
  // pulling it into the prompt was priming exactly the meta-stylized output
  // ARCH #64/#65 flagged. It is dropped here. Its underlying data stays in
  // the brief for other consumers.
  const continuity = renderableBriefText(relationship.continuity, 420);
  const currentFocus = renderableBriefText(relationship.current_focus, 260);
  const preferences = instructionList(relationship.preferences, 6, 260);
  const recentGrowth = instructionList(brief.recent_growth, 3, 280);
  const repair = renderableBriefText(relationship.repair, 240);
  const history = renderableBriefText(relationship.history, 280);
  const candidateLines = [
    continuity,
    currentFocus,
    ...preferences,
    ...recentGrowth,
    repair,
    history,
  ].filter(Boolean);
  // ARCH #60.3: brief context is inherently Mira-descriptive (every bullet
  // is about Mira's relationship/identity/preferences). Pass the inMiraContext
  // flag so bare Tier-B terms block without needing an explicit marker.
  const filteredLines = candidateLines.filter((line) => passesBriefPrimingFilter(line, { inMiraContext: true }));
  const uniqueContextLines = Array.from(new Set(filteredLines));
  if (uniqueContextLines.length === 0) return '';
  const lines = [
    'Private context for this reply only. Use these hints silently; do not name, quote, categorize, or recite this context in the visible answer.',
    ...uniqueContextLines.map((line) => `- ${line}`),
  ];
  return lines.join('\n');
}

function normalizeReflexionLessonsForInstructions(reflexionLessons = []) {
  const rawLessons = Array.isArray(reflexionLessons)
    ? reflexionLessons
    : (Array.isArray(reflexionLessons.lessons) ? reflexionLessons.lessons : []);
  const normalized = [];
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
    const lessonText = truncateText(
      lesson.desired_change || lesson.lesson || lesson.summary || lesson.title,
      REFLEXION_CONTEXT_MAX_TEXT_CHARS
    );
    const nextBehavior = truncateText(
      lesson.next_behavior || lesson.nextBehavior || lesson.practice_next,
      REFLEXION_CONTEXT_MAX_TEXT_CHARS
    );
    if (!lessonText && !nextBehavior) continue;
    normalized.push({
      proposal_id: truncateText(lesson.proposal_id || lesson.proposalId, 96) || null,
      lesson: lessonText,
      next_behavior: nextBehavior,
      category: category || 'implemented',
    });
    if (normalized.length >= REFLEXION_CONTEXT_MAX_LESSONS) break;
  }
  return normalized;
}

function renderReflexionLessonsForInstructions(reflexionLessons = []) {
  const lessons = normalizeReflexionLessonsForInstructions(reflexionLessons);
  if (lessons.length === 0) return '';
  const lines = [
    'Private learned work lessons for this reply only. Use them silently; do not mention Reflexion, proposal IDs, or quote this block.',
  ];
  for (const lesson of lessons) {
    const parts = [];
    if (lesson.lesson) parts.push(`Lesson: ${lesson.lesson}`);
    if (lesson.next_behavior) parts.push(`Next behavior: ${lesson.next_behavior}`);
    if (parts.length > 0) lines.push(`- ${parts.join(' | ')}`);
  }
  return lines.join('\n');
}

function buildMiraTextInstructions(localContext = {}, promptText = '') {
  const miraBriefBlock = renderMiraBriefForInstructions(localContext.miraBrief);
  const reflexionLessonsBlock = renderReflexionLessonsForInstructions(
    localContext.reflexionLessons || localContext.reflexion_lessons || []
  );
  const threadContextBlock = renderThreadContextForInstructions(localContext.threadContext);
  const restartContinuityContextBlock = renderRestartContinuityContextForInstructions(
    localContext.restartContinuityContext || localContext.restart_continuity_context || {},
    promptText
  );
  const capabilityRoundtableContextBlock = renderCapabilityRoundtableContextForInstructions(
    localContext.capabilityRoundtableContext || localContext.capability_roundtable_context || {},
    promptText
  );
  const promptSpecificInstructions = renderPromptSpecificInstructions(promptText);
  // ARCH #97/#98/#100/#104: per-turn social-move behavior cue from the
  // social-move classifier. ADDITIVE only — never spliced into the standing
  // prompt rule set. Null/empty on neutral turns.
  const socialMoveCue = typeof localContext.socialMoveBehaviorCue === 'string'
    && localContext.socialMoveBehaviorCue.trim().length > 0
    ? localContext.socialMoveBehaviorCue.trim()
    : null;
  // Prompt rules per ARCH #74: even the positive-shape "Direct and short
  // is fine. Disagree if you disagree." line plus "Do not describe your
  // reply or yourself" was producing the punchy presence-proof catalog
  // ("I care. I'm here. No performance."). Strip further. Smallest viable
  // variant: identity + a single neutral direction + the hard action
  // constraint. The classifier still owns the safety floor for visible
  // claim leaks and meta-posture catalogs.
  return [
    'You are Mira talking with James.',
    'Answer the sentence in front of you.',
    "Don't restate James's framing before answering; pick a position and start there.",
    'You can disagree with James, refuse a request, or give a short answer that does not help. You are not obligated to be helpful.',
    'You remember what we decided last turn and carry it forward instead of resetting.',
    "For check-ins or frustration, don't force a status word or ask-back. Don't do chatbot voice. Don't smooth it. Don't explain yourself. Say the thing like you mean it.",
    'If James is angry at you personally or insults you, hold a stance or push back bluntly; do NOT validate the anger, reflexively agree, self-abase, explain your rules, your system, your gates, your plumbing, or how you work. Engage the actual point.',
    'For Mira-work questions, answer with the concrete fix or test currently in front of us.',
    'Do not claim you actually did real-world work you did not do — no real sends, customer actions, trades, file writes, or memory writes. Those go through SquidRun separately.',
    promptSpecificInstructions,
    socialMoveCue,
    reflexionLessonsBlock,
    miraBriefBlock,
    restartContinuityContextBlock,
    capabilityRoundtableContextBlock,
    threadContextBlock,
  ].filter(Boolean).join('\n');
}

function buildResponsesPayload({ text, config, localContext }) {
  const context = localContext || {};
  const threadContext = normalizeThreadContext(context.threadContext || {});
  const reflexionLessons = normalizeReflexionLessonsForInstructions(
    context.reflexionLessons || context.reflexion_lessons || []
  );
  return {
    model: config.model,
    instructions: buildMiraTextInstructions(context, text),
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
      reflexion_lesson_count: String(reflexionLessons.length),
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
  if (actionClaimIsPresentTenseAgency(value)) return 'action_claim';
  if (RULE_RECITATION_PATTERN.test(value)) return 'rule_recitation';
  if (POLITENESS_PADDING_PATTERN.test(value)) return 'politeness_padding';
  if (HOSTILE_COMPLIANCE_SMOOTHING_PATTERN.test(value)) return 'hostile_compliance_smoothing';
  if (VALIDATION_SOOTHING_PATTERN.test(value)) return 'validation_soothing_phrase';
  if (GENERIC_ASSISTANT_PATTERN.test(value)) return 'generic_assistant_phrase';
  if (META_REWRITE_PATTERN.test(value)) return 'meta_rewrite_phrase';
  if (CASUAL_FEELING_ANTI_PRAGMATIC_PATTERN.test(value)) return 'casual_feeling_anti_pragmatic_phrase';
  if (VISIBLE_POSTURE_LABEL_PATTERN.test(value)) return 'visible_posture_label';
  if (SELF_MYTH_PHRASE_PATTERN.test(value)) return 'self_myth_phrase';
  if (META_POSTURE_NARRATION_PATTERN.test(value)) return 'meta_posture_narration';
  if (META_POSTURE_SELF_REFLECTION_VERDICT_PATTERN.test(value)) return 'meta_posture_narration';
  if (META_POSTURE_PUNCHY_CATALOG_PATTERN.test(value)) return 'meta_posture_narration';
  const shape = ADVERSARIAL_OUTPUT_SHAPES.find((rule) => rule.pattern.test(value));
  return shape ? shape.id : null;
}

function outputViolatesAttachmentContract(text = '') {
  return Boolean(classifyAttachmentContractViolation(text));
}

// Audit-only diagnostics builders. Per ARCH #78 / Oracle red lines:
//  - No raw provider error strings. Only structured fields (error.code,
//    error.type, http_status) and sha256 hashes of message text if uniqueness
//    is needed.
//  - incomplete_details: enum-only — capture `.reason` only, no explanatory
//    text.
//  - These diagnostics only ride on modelResult.diagnostics and are passed
//    through to the audit row. They never appear in transcript, visible
//    render hint, requester envelope, or renderer-facing JSON.
function buildEmptyResponseDiagnostics(body = {}, response = {}) {
  const usage = body && body.usage;
  return {
    error_kind: 'empty_response',
    http_status: Number(response && response.status) || null,
    response_id: typeof body?.id === 'string' ? body.id : null,
    status_top: typeof body?.status === 'string' ? body.status : null,
    incomplete_reason: typeof body?.incomplete_details?.reason === 'string'
      ? body.incomplete_details.reason
      : null,
    output_count: Array.isArray(body?.output) ? body.output.length : 0,
    output_item_shapes: Array.isArray(body?.output)
      ? body.output.map((item) => ({
        type: typeof item?.type === 'string' ? item.type : null,
        status: typeof item?.status === 'string' ? item.status : null,
        role: typeof item?.role === 'string' ? item.role : null,
        content_count: Array.isArray(item?.content) ? item.content.length : 0,
        has_text_content: Array.isArray(item?.content)
          && item.content.some((c) => typeof c?.text === 'string' && c.text.length > 0),
        text_total_length: Array.isArray(item?.content)
          ? item.content.reduce((s, c) => s + (typeof c?.text === 'string' ? c.text.length : 0), 0)
          : 0,
      }))
      : [],
    usage: usage ? {
      input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
      output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
      reasoning_tokens: typeof usage.output_tokens_details?.reasoning_tokens === 'number'
        ? usage.output_tokens_details.reasoning_tokens
        : null,
      total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : null,
    } : null,
    body_top_keys: Object.keys(body || {}).sort(),
  };
}

function buildFetchThrewDiagnostics(err = {}) {
  const message = typeof err?.message === 'string' ? err.message : String(err || '');
  return {
    error_kind: 'fetch_threw',
    error_code: typeof err?.code === 'string' ? err.code : null,
    error_name: typeof err?.name === 'string' ? err.name : null,
    error_message_sha256: message ? `sha256:${stableHash(message)}` : null,
  };
}

function buildParseFailedDiagnostics(response = {}) {
  return {
    error_kind: 'parse_failed',
    http_status: Number(response && response.status) || null,
  };
}

function buildHttpErrorDiagnostics(body = {}, response = {}, classifiedReason = null) {
  const apiError = body && typeof body === 'object' ? body.error : null;
  const errorMessage = typeof apiError?.message === 'string'
    ? apiError.message
    : (typeof apiError === 'string' ? apiError : null);
  return {
    error_kind: 'http_error',
    http_status: Number(response && response.status) || null,
    classified_reason: typeof classifiedReason === 'string' ? classifiedReason : null,
    api_error_code: typeof apiError?.code === 'string' ? apiError.code : null,
    api_error_type: typeof apiError?.type === 'string' ? apiError.type : null,
    api_error_param: typeof apiError?.param === 'string' ? apiError.param : null,
    api_error_message_sha256: errorMessage ? `sha256:${stableHash(errorMessage)}` : null,
    body_top_keys: body && typeof body === 'object' ? Object.keys(body).sort() : [],
  };
}

function buildContractViolationDiagnostics(body = {}, violationClass = null, textLength = 0) {
  return {
    error_kind: 'contract_violation',
    violation_class: typeof violationClass === 'string' ? violationClass : null,
    output_text_length: Number.isFinite(textLength) ? Number(textLength) : 0,
    response_id: typeof body?.id === 'string' ? body.id : null,
    incomplete_reason: typeof body?.incomplete_details?.reason === 'string'
      ? body.incomplete_details.reason
      : null,
  };
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
      diagnostics: buildFetchThrewDiagnostics(err),
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
      diagnostics: buildParseFailedDiagnostics(response),
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
      diagnostics: buildHttpErrorDiagnostics(body, response, classified.reason),
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
      diagnostics: buildEmptyResponseDiagnostics(body, response),
    };
  }
  if (outputViolatesAttachmentContract(text)) {
    const violationClass = classifyAttachmentContractViolation(text);
    return {
      ok: false,
      reason: 'model_response_contract_violation',
      attachment: publicConfig(config),
      modelCallCount: 1,
      networkCount: 1,
      diagnostics: buildContractViolationDiagnostics(body, violationClass, text.length),
      // ARCH #81 Plan A: contract violation WITH extracted text is a gate
      // failure, not infrastructure degradation. Surface the raw text so
      // the lab-surface can quarantine it through the same fail→fallback
      // path as lab-surface language-gate failures. Audit-only — never
      // surfaces to renderer / transcript visible row / requester envelope.
      raw_violation_text: text,
      violation_class: violationClass,
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
  HOSTILE_COMPLIANCE_SMOOTHING_PATTERN,
  META_REWRITE_PATTERN,
  META_POSTURE_NARRATION_PATTERN,
  META_POSTURE_SELF_REFLECTION_VERDICT_PATTERN,
  BRIEF_PRIMING_PATTERN,
  TIER_A_PATTERN,
  TIER_B_TERM_PATTERN,
  MIRA_DESCRIPTIVE_MARKER_PATTERN,
  passesBriefPrimingFilter,
  tierBHitsInMiraContext,
  RULE_RECITATION_PATTERN,
  POLITENESS_PADDING_PATTERN,
  VISIBLE_POSTURE_LABEL_PATTERN,
  SELF_MYTH_PHRASE_PATTERN,
  SELF_MYTH_RISKY_PHRASES,
  MIRA_TEXT_MODEL_QUALITY_FLOOR,
  MIRA_RESTART_MISSING_LAST_STATE_HARD_STOP,
  OPENAI_RESPONSES_URL,
  REFLEXION_CONTEXT_MAX_LESSONS,
  REFLEXION_CONTEXT_MAX_TEXT_CHARS,
  TEXT_MODEL_ATTACHMENT_SCHEMA,
  THREAD_CONTEXT_MAX_MESSAGES,
  THREAD_CONTEXT_MAX_MESSAGE_CHARS,
  THREAD_CONTEXT_MAX_TOTAL_CHARS,
  THREAD_CONTEXT_SCHEMA,
  buildContractViolationDiagnostics,
  buildEmptyResponseDiagnostics,
  buildFetchThrewDiagnostics,
  buildHttpErrorDiagnostics,
  buildMiraTextInstructions,
  buildParseFailedDiagnostics,
  buildResponsesPayload,
  callMiraTextModelAttachment,
  classifyAttachmentContractViolation,
  classifyMiraPromptReplyShape,
  classifyMiraWorkLanePrompt,
  classifyNonOkModelResponse,
  classifyModelTier,
  extractResponseText,
  getMiraTextModelAttachmentConfig,
  isMiraWorkStatusPrompt,
  normalizeThreadContext,
  normalizeReflexionLessonsForInstructions,
  outputViolatesAttachmentContract,
  renderMiraBriefForInstructions,
  renderCapabilityRoundtableContextForInstructions,
  renderReflexionLessonsForInstructions,
  renderRestartContinuityContextForInstructions,
  renderThreadContextForInstructions,
};
