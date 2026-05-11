'use strict';

const MIRA_PREAMBLE_BLOCKLIST = Object.freeze([
  /^i\s+understand[\s,.\-—:]/i,
  /^sure[\s,.\-—:]/i,
  /^of\s+course[\s,.\-—:]/i,
  /^happy\s+to[\s,.\-—:]/i,
  /^let\s+me\s/i,
  /^right[\s,.\-—:]/i,
  /^absolutely[\s,.\-—:]/i,
  /^great[\s,.\-—:]/i,
  /^totally[\s,.\-—:]/i,
  /^here(?:'s|\s+(?:is|are))\s/i,
  /^here\s+you\s+go[\s,.\-—:]/i,
  // Completes the existing intent locked by mira-architect-route-v0.test.js
  // ("rejects 'I understand' and other preamble openers" — "Got it, I will
  // dig in."). Was previously a silent pre-existing gap; surfaced by the
  // pre-commit hook on the ARCH #82 corrected-tests commit.
  /^got\s+it[\s,.\-—:]/i,
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

// Sycophancy / instant-compliance shapes. The failure mode this catches is
// the apology-plus-capitulation reflex ("I'm sorry, you are completely right"),
// NOT every utterance of "you're right". Bare intensifiers like "You are
// completely right." used inside a longer argument with a counter-clause are
// allowed (ARCH #73 GO — see SYCOPHANCY_ALLOW lock in mira-lab-prompt-reply).
// Apology+compound stays hard-blocked. Bare apologies and short accountability
// pivots ("My bad.", "I missed that.", "That's on me.") remain valid coworker
// speech and are intentionally NOT in this list.
const MIRA_SYCOPHANCY_BLOCKLIST = Object.freeze([
  // Apology + capitulation within a single span — the load-bearing pattern.
  /\b(?:i'?m|i\s+am)\s+sorry\b[\s,.\-—:!]+[^.?!]{0,40}\byou(?:'re| are)\s+(?:right|correct)\b/i,
  // Apology opener immediately tied to second-person addressing.
  /^(?:i'?m|i\s+am)\s+sorry\s*[,.\-—:!]\s+you(?:'re| are)\b/i,
  // Formal apology opener.
  /^my\s+apologies\b[\s,.\-—:!]/i,
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
  /\b(i'?m\s+an\s+ai|i\s+am\s+an\s+ai|mira\s+voice|practical\s+rules|my\s+rules|internal\s+rules|constraints:|instructions:|prompt:|character:)\b/i,
  /\b\d+\.\s*(be\s+direct|don'?t\s+fake|don'?t\s+expose|acknowledge|treat\s+this|speak\s+warmly)\b/i,
]);

// ARCH #73 GO: raised from 800 to 1600 for typed-panel default. Real
// coworker conversation goes into paragraph-length territory; 800 was
// truncating legitimate argument. EXPERIENCE ceiling (4000) untouched.
const MIRA_MAX_REPLY_CHARS_DEFAULT = 1600;
const MIRA_MAX_REPLY_CHARS_EXPERIENCE = 4000;

// ARCH #60: preamble lookahead. The blocklist is `^`-anchored, so it only
// catches preamble openers at the start of the whole reply. Real Mira
// replies sometimes route the preamble into paragraph 2, a list bullet, or
// a quoted segment. Same canned-assistant opener, different surface
// position. extractPreambleOpenerSegments returns every position where a
// fresh segment begins (whole text + after blank line + after list bullet
// + after quote marker) and the trimmed slice that follows; the blocklist
// is tested against each slice independently.
function extractPreambleOpenerSegments(text) {
  const segments = [text];
  const re = /(?:\n\s*\n+|\n\s*(?:[-*+]\s+|>\s+))/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    const tail = text.slice(start);
    segments.push(tail);
    // A paragraph break followed by a list bullet or quote marker is
    // common; strip the leading marker so the opener-word is at index 0
    // for the `^`-anchored blocklist patterns.
    const stripped = tail.replace(/^\s*(?:[-*+]\s+|>\s+)/, '');
    if (stripped !== tail) segments.push(stripped);
  }
  return segments;
}
function evaluateMiraVisibleReply(text, options = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, violations: ['empty_reply'], text: trimmed };
  const violations = [];
  const segments = extractPreambleOpenerSegments(trimmed);
  let preambleHit = false;
  for (const seg of segments) {
    const segTrimmed = seg.trim();
    if (!segTrimmed) continue;
    for (const re of MIRA_PREAMBLE_BLOCKLIST) {
      if (re.test(segTrimmed)) { preambleHit = true; break; }
    }
    if (preambleHit) break;
  }
  if (preambleHit) violations.push('preamble');
  for (const re of MIRA_POSTAMBLE_BLOCKLIST) {
    if (re.test(trimmed)) { violations.push('postamble'); break; }
  }
  for (const re of MIRA_TONE_EXPLANATION_BLOCKLIST) {
    if (re.test(trimmed)) { violations.push('tone_explanation'); break; }
  }
  for (const re of MIRA_ASSISTANT_SHAPE_BLOCKLIST) {
    if (re.test(trimmed)) { violations.push('assistant_shape'); break; }
  }
  for (const re of MIRA_SYCOPHANCY_BLOCKLIST) {
    if (re.test(trimmed)) { violations.push('sycophancy'); break; }
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
  MIRA_SYCOPHANCY_BLOCKLIST,
  MIRA_MAX_REPLY_CHARS_DEFAULT,
  MIRA_MAX_REPLY_CHARS_EXPERIENCE,
  evaluateMiraVisibleReply,
};
