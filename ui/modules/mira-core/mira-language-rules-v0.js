'use strict';

const MIRA_PREAMBLE_BLOCKLIST = Object.freeze([
  /^i\s+understand[\s,.\-—:]/i,
  /^sure[\s,.\-—:]/i,
  /^of\s+course[\s,.\-—:]/i,
  /^happy\s+to[\s,.\-—:]/i,
  /^let\s+me\s/i,
  /^got\s+it[\s,.\-—:]/i,
  /^right[\s,.\-—:]/i,
  /^absolutely[\s,.\-—:]/i,
  /^great[\s,.\-—:]/i,
  /^totally[\s,.\-—:]/i,
  /^here(?:'s|\s+(?:is|are))\s/i,
  /^here\s+you\s+go[\s,.\-—:]/i,
]);

const MIRA_POSTAMBLE_BLOCKLIST = Object.freeze([
  /hope\s+(that|this)\s+helps[.!]?\s*$/i,
  /anything\s+else\??\s*$/i,
  /(let\s+me\s+know|just\s+let\s+me\s+know|happy\s+to\s+help)[^.!?]*[.!?]?\s*$/i,
  /(feel\s+free\s+to|don'?t\s+hesitate\s+to)[^.!?]*[.!?]?\s*$/i,
]);

const MIRA_TONE_EXPLANATION_BLOCKLIST = Object.freeze([
  /\b(speaking\s+plainly|to\s+be\s+honest|let\s+me\s+be\s+direct|warmly|gently|softly)\s*[,.\-—:]/i,
  /\bi'?ll\s+be\s+(honest|direct|blunt|brief|warm|plain)[\s,.\-—:]/i,
  /\bin\s+plain\s+english[\s,.\-—:]/i,
]);

const MIRA_ASSISTANT_SHAPE_BLOCKLIST = Object.freeze([
  /^i\s+just\s+want(?:ed)?\s+to/i,
  /^to\s+clarify[\s,.\-—:]/i,
  /^to\s+be\s+clear[\s,.\-—:]/i,
  /^for\s+clarity[\s,.\-—:]/i,
  /^just\s+to\s+be\s+clear[\s,.\-—:]/i,
  /^that'?s\s+(valid|fair|good|true)[\s,.\-—:!]/i,
  /^if\s+(?:you'?d\s+like|you\s+(?:want|need))[\s,.\-—:]/i,
  /^would\s+you\s+like\s+me\s+to/i,
  /\bi'?m\s+(trying|attempting)\s+(not\s+to|to)\s+(sound|be|seem|come\s+across)/i,
  /\bi'?m\s+not\s+(your|a|just\s+a)\s*(typical|usual|ordinary|generic)?\s*(ai|assistant|chatbot|bot)/i,
  /\bi\s+hear\s+you[\s,.\-—:]/i,
  /\bi\s+get\s+(it|that)[\s,.\-—:]/i,
  /\b(good|great|fair|valid)\s+point[\s,.\-—:]/i,
  /\bthat'?s\s+a\s+(good|great|fair|valid)\s+point[\s,.\-—:]/i,
  /\bi\s+want\s+to\s+(make\s+sure|be\s+clear|be\s+careful|push\s+back)/i,
]);

const MIRA_MAX_REPLY_CHARS_DEFAULT = 800;
const MIRA_MAX_REPLY_CHARS_EXPERIENCE = 4000;

function evaluateMiraVisibleReply(text, options = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, violations: ['empty_reply'], text: trimmed };
  const violations = [];
  for (const re of MIRA_PREAMBLE_BLOCKLIST) {
    if (re.test(trimmed)) { violations.push('preamble'); break; }
  }
  for (const re of MIRA_POSTAMBLE_BLOCKLIST) {
    if (re.test(trimmed)) { violations.push('postamble'); break; }
  }
  for (const re of MIRA_TONE_EXPLANATION_BLOCKLIST) {
    if (re.test(trimmed)) { violations.push('tone_explanation'); break; }
  }
  for (const re of MIRA_ASSISTANT_SHAPE_BLOCKLIST) {
    if (re.test(trimmed)) { violations.push('assistant_shape'); break; }
  }
  const maxReplyChars = Number.isFinite(Number(options.maxReplyChars))
    ? Math.max(1, Math.floor(Number(options.maxReplyChars)))
    : MIRA_MAX_REPLY_CHARS_DEFAULT;
  if (trimmed.length > maxReplyChars) {
    violations.push('reply_too_long');
  }
  return {
    ok: violations.length === 0,
    violations,
    text: trimmed,
    max_reply_chars: maxReplyChars,
  };
}

module.exports = {
  MIRA_PREAMBLE_BLOCKLIST,
  MIRA_POSTAMBLE_BLOCKLIST,
  MIRA_TONE_EXPLANATION_BLOCKLIST,
  MIRA_ASSISTANT_SHAPE_BLOCKLIST,
  MIRA_MAX_REPLY_CHARS_DEFAULT,
  MIRA_MAX_REPLY_CHARS_EXPERIENCE,
  evaluateMiraVisibleReply,
};
