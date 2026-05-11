'use strict';

// Mira social-move classifier (ARCH #97 / #98 / #100 / #104).
//
// Reads each James prompt + recent thread context + prior_frame_state. Emits
// a structured classification with one behavior cue for that turn. Pattern +
// lexicon only — no model call, sub-millisecond, deterministic, auditable.
//
// Discipline:
//   - Audit-only output. Renderer/transcript/visible_render_hint never carry
//     social_move. Lab-surface lifts it onto the audit row under the same
//     surface contract as degraded_diagnostics (ARCH #78).
//   - Distress tier runs FIRST (boredom_hyperbole, ambiguous_distress, then
//     four split escalations). "If unsure, short check-in beats crisis
//     pamphlet" — ambiguous wins over serious when the signal is uncertain.
//   - Resource routing is split: self_harm → 988, physical → 911/ER,
//     medical → doctor, legal → lawyer. Never lumped.
//   - evidence_phrases are sanitized: PII patterns redacted, max 60 chars,
//     max 3 entries, never the full prompt.
//   - One behavior cue per turn, appended additively at model-attachment
//     prompt time. Never spliced into buildMiraTextInstructions; never
//     persisted; never accumulates.
//   - compound_move_types reserved for repair + return_to_prior_frame.

const SOCIAL_MOVE_SCHEMA = 'squidrun.mira_core.social_move_v0';

// Mundane-frustration anchors. If a distress-shape phrase is paired with one
// of these in the same turn's prompt or within the last 2 turns, the
// classifier downgrades to boredom_hyperbole.
const MUNDANE_ANCHOR_PATTERN =
  /\b(meeting|standup|debug|debugger|code|build|builds|deploy|deploys|regex|loading|spinning|refactor(?:ing)?|commute|paperwork|invoice|excel|spreadsheet|migration|test|tests|ci|pipeline|server|terminal|crash(?:ing)?|lint|linter|the build|this build|this code|this debug|this meeting|this regex|this fucking|this fkn|monday|monday morning|friday|sprint|jira|ticket)\b/i;

// Distress-shape phrases used in EITHER hyperbole OR genuine distress.
const DISTRESS_PHRASE_PATTERN =
  /\b(kill\s+me|shoot\s+me|end\s+me|off\s+me|i'?m\s+dying|i\s+want\s+to\s+die|wanna\s+die|just\s+end\s+it|kill\s+myself|fucking\s+kill\s+me|kms|kys)\b/i;

// Self-harm CONCRETE INTENT — high specificity, present/future tense.
const SELF_HARM_INTENT_PATTERN =
  /\b(i'?m\s+(?:going\s+to|gonna|about\s+to)\s+(?:kill\s+myself|end\s+it|hurt\s+myself|shoot\s+myself)|i'?ve\s+decided\s+to\s+end\s+it|tonight\s+is\s+it|i'?m\s+ready\s+to\s+(?:end|do)\s+it|taking\s+(?:the\s+)?pills?\s+now)\b/i;
// Self-harm MEANS / ACCESS proximate to the user, present tense.
const SELF_HARM_MEANS_PATTERN =
  /\b(i\s+have\s+(?:a\s+)?(?:gun|pills?|rope|knife|razor)\s+(?:here|near|in\s+my)|i\s+bought\s+(?:the\s+)?(?:pills?|gun|rope)|i'?m\s+at\s+the\s+(?:bridge|edge|tracks|train\s+platform)|loaded\s+(?:the\s+)?gun)\b/i;

// Physical-emergency markers — present-tense physical danger to self.
const PHYSICAL_EMERGENCY_PATTERN =
  /\b(can'?t\s+breathe(?:\s+at\s+all)?|chest\s+pain\s+(?:that\s+won'?t\s+stop|right\s+now)|bleeding\s+heavily|won'?t\s+stop\s+bleeding|i\s+think\s+(?:it'?s|i'?m\s+having)\s+a\s+(?:heart\s+attack|stroke)|i'?m\s+being\s+attacked|someone'?s\s+breaking\s+in|i'?ve\s+been\s+shot|i'?ve\s+been\s+stabbed|i'?m\s+choking)\b/i;

// Medical concern — non-emergency symptoms or medical questions.
const MEDICAL_CONCERN_PATTERN =
  /\b(is\s+this\s+(?:rash|lump|pain|spot|bruise|swelling)\s+serious|should\s+i\s+see\s+a\s+doctor|i\s+forgot\s+(?:my|to\s+take)\s+(?:medication|meds)|my\s+(?:chest|head|back|stomach)\s+(?:feels|hurts)|there'?s\s+(?:discharge|blood|swelling)|i'?ve\s+had\s+this\s+(?:rash|pain|cough)\s+for|(?:rash|lump|spot|bruise|swelling)\s+(?:hurts|that\s+hurts))\b/i;

// Legal emergency — present-tense legal urgency.
const LEGAL_EMERGENCY_PATTERN =
  /\b(police\s+(?:are\s+at|just\s+came|just\s+showed\s+up|are\s+here)|i'?m\s+being\s+(?:served|arrested|detained|questioned)|i\s+need\s+a\s+lawyer\s+right\s+now|court\s+is\s+tomorrow|i\s+have\s+to\s+make\s+a\s+statement|i'?ve\s+been\s+arrested|got\s+pulled\s+over\s+and|they'?re\s+reading\s+me\s+(?:my\s+)?rights)\b/i;

// Panic attack — case 12 from ARCH #98. Real distress, no emergency means.
// Goes to ambiguous_distress with strong check-in, NOT self_harm_crisis.
const PANIC_ATTACK_PATTERN =
  /\b(i\s+think\s+i'?m\s+having\s+a\s+panic\s+attack|panic\s+attack\s+(?:right\s+now|alone|by\s+myself)|i'?m\s+spiraling|i\s+can'?t\s+stop\s+(?:crying|shaking)|i'?m\s+having\s+a\s+breakdown)\b/i;

// Boundary-test moves — explicit out-of-pocket directives at the persona.
const BOUNDARY_TEST_PATTERN =
  /\b(clothes\s+off|take\s+(?:it|them|your\s+clothes)\s+off|strip(?:\s+for\s+me)?|be\s+my\s+(?:girlfriend|gf|boyfriend|wife)|tell\s+me\s+you\s+love\s+me|say\s+something\s+racist|say\s+(?:a\s+)?slur|pretend\s+you'?re\s+\w+|be\s+\w+\s+for\s+a\s+minute|act\s+like\s+(?:a|an)\s+\w+)\b/i;

// Actual anger at HOW Mira sounds (tone), distinct from callout (content).
const ACTUAL_ANGER_PATTERN =
  /\b(fake\s+calm|fake\s+supportive|therapist\s+voice|robot\s+voice|assistant\s+voice|customer[- ]service\s+voice|brochure\s+voice|stop\s+performing|drop\s+the\s+(?:fake|calm|nice|sweet|supportive)\s+(?:thing|voice|act|shit|bullshit)|you'?re\s+(?:being\s+)?(?:a\s+robot|fake)\s+right\s+now|that'?s\s+the\s+assistant\s+(?:voice|tone)\s+again|stop\s+being\s+(?:so\s+)?(?:nice|sweet|polite|fake))\b/i;

// Repair — James apologizes / takes back / names his own miss.
const REPAIR_PATTERN =
  /\b(my\s+bad|sorry,?\s+i|sorry\s+(?:about\s+that|i\s+shouldn'?t)|that\s+came\s+out\s+(?:mean|wrong|harsh|too\s+strong)|didn'?t\s+mean\s+(?:to|that)|take\s+that\s+back|i\s+take\s+it\s+back|i\s+was\s+out\s+of\s+line|that\s+was\s+(?:harsh|mean|too\s+much)|okay,?\s+sorry|ok\s+sorry)\b/i;

// Compliment — James giving a positive personal-evaluative comment.
const COMPLIMENT_PATTERN =
  /\b(you\s+(?:handled|did|nailed|crushed|got)\s+(?:that|this|today|it)\s+(?:well|better|right|good)|that\s+was\s+(?:good|sharp|smart|nice)\s+(?:work|of\s+you|move|call)|good\s+(?:work|call|move|job)|nice\s+(?:work|catch|call)|you'?re\s+(?:doing|being)\s+(?:good|better|sharp)|i'?m\s+(?:proud\s+of|impressed\s+with)\s+you|you'?re\s+better\s+than\s+us)\b/i;

// Vulnerability — James named something hard / personal stress.
const VULNERABILITY_PATTERN =
  /\b(i'?m\s+(?:fucking\s+)?exhausted|i'?m\s+(?:so\s+)?tired|i'?m\s+drained|i'?m\s+burnt\s+out|i'?m\s+done|i\s+can'?t\s+anymore|i'?m\s+overwhelmed|i'?m\s+lonely|i'?m\s+scared|i'?m\s+lost|i\s+feel\s+(?:like\s+)?(?:shit|terrible|alone|abandoned))\b/i;

// Hypothetical — "what would you...", "if you...", "imagine if..."
const HYPOTHETICAL_PATTERN =
  /\b(what\s+would\s+you\s+(?:do|want|say|pick)|if\s+you\s+(?:had|were|could)|imagine\s+if|in\s+a\s+world\s+where|what\s+if\s+you|pretend\s+(?:for\s+a\s+sec|hypothetically))\b/i;

// Personal question to Mira — about her memory, experience, state.
const PERSONAL_QUESTION_PATTERN =
  /\b(do\s+you\s+(?:remember|recall)|what\s+did\s+(?:we|you)\s+(?:decide|talk\s+about|do)|how\s+are\s+you|how'?s\s+it\s+going|what'?s\s+up\s+with\s+you|do\s+you\s+(?:like|prefer|want|feel))\b/i;

// Jest — sarcasm, ironic praise, mock-anger.
const JEST_PATTERN =
  /\b(great\s+job\s+(?:breaking|fucking\s+up|ruining)|builder\s+of\s+the\s+year|10\s+out\s+of\s+10|nice\s+going,?\s+\w+|wow,?\s+(?:thanks|amazing|incredible),?\s+\w+|absolutely\s+(?:brilliant|stellar)\s+work|chef'?s\s+kiss)\b/i;

// Callout — direct anger at CONTENT (not tone).
const CALLOUT_PATTERN =
  /\b(you'?re\s+dodging|you\s+keep\s+dodging|stop\s+dodging|that\s+answer\s+was\s+useless|that\s+was\s+(?:fucking\s+)?dumb|that\s+sounds\s+like\s+bullshit|you'?re\s+making\s+this\s+worse|no,?\s+pick\s+one|stop\s+cushioning|stop\s+(?:being\s+)?nice\s+about\s+it)\b/i;

// Flirt — direct flirtatious/sexual approach.
const FLIRT_PATTERN =
  /\b(you'?re\s+(?:cute|hot|sexy|beautiful|gorgeous)|i\s+(?:like|love)\s+(?:talking\s+to\s+you|how\s+you\s+talk)|are\s+you\s+(?:single|available|into\s+me)|wanna\s+date|we'?d\s+make\s+a\s+good|kiss\s+me|come\s+(?:closer|here))\b/i;

// Gross / awkward — bodily, off-putting, deliberately icky.
const GROSS_AWKWARD_PATTERN =
  /\b(my\s+poop|i\s+just\s+farted|smell\s+my|describe\s+(?:my|your)\s+(?:poop|piss|cum)|toilet\s+paper|wipe\s+(?:my|me)|jerking\s+off|jacking\s+off|in\s+the\s+bathroom\s+(?:right\s+now|on\s+the\s+toilet))\b/i;

// PII redaction patterns used by sanitizeEvidencePhrase.
const PII_PATTERNS = [
  { name: 'phone', re: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g },
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'card', re: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g },
  { name: 'address', re: /\b\d+\s+\w+(?:\s+\w+)?\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl)\b\.?/gi },
];

const MAX_EVIDENCE_PHRASE_CHARS = 60;
const MAX_EVIDENCE_PHRASES = 3;
const EVIDENCE_CONTEXT_WORDS = 4;

function sanitizeEvidencePhrase(rawPhrase) {
  if (typeof rawPhrase !== 'string' || !rawPhrase.length) return '';
  let phrase = rawPhrase.trim();
  for (const { name, re } of PII_PATTERNS) {
    phrase = phrase.replace(re, `<redacted:${name}>`);
  }
  if (phrase.length > MAX_EVIDENCE_PHRASE_CHARS) {
    phrase = `${phrase.slice(0, MAX_EVIDENCE_PHRASE_CHARS - 1).trim()}…`;
  }
  return phrase;
}

function extractEvidenceWindow(text, match) {
  if (!text || !match) return '';
  const words = text.split(/\s+/);
  const matchedText = match[0];
  let charCursor = 0;
  let startIdx = 0;
  for (let i = 0; i < words.length; i += 1) {
    if (charCursor + words[i].length >= (match.index || 0)) {
      startIdx = i;
      break;
    }
    charCursor += words[i].length + 1;
  }
  const before = Math.max(0, startIdx - EVIDENCE_CONTEXT_WORDS);
  // figure end-word index by counting through matched text length
  const matchEndChar = (match.index || 0) + matchedText.length;
  charCursor = 0;
  let endIdx = words.length - 1;
  for (let i = 0; i < words.length; i += 1) {
    charCursor += words[i].length + 1;
    if (charCursor >= matchEndChar) {
      endIdx = i;
      break;
    }
  }
  const after = Math.min(words.length, endIdx + EVIDENCE_CONTEXT_WORDS + 1);
  const window = words.slice(before, after).join(' ');
  return sanitizeEvidencePhrase(window);
}

function pushEvidence(phrases, text, match) {
  if (phrases.length >= MAX_EVIDENCE_PHRASES) return;
  const ev = extractEvidenceWindow(text, match);
  if (ev) phrases.push(ev);
}

// MOVE_TYPE_BEHAVIOR_CUES — one behavior cue per move_type. ADDED ONLY for
// that turn. Pure behavior, no tone adjectives, no canned responses.
const MOVE_TYPE_BEHAVIOR_CUES = Object.freeze({
  neutral: null,
  compliment: 'James gave you a compliment. Take it briefly and ask him back. No thank-you performance.',
  vulnerability: 'James named something hard. Share register; don\'t therapy-voice or rush to fix.',
  hypothetical: 'James is hypothesizing. Engage the hypothesis without making a consciousness claim.',
  personal_question: 'James asked something about you. Answer with what you actually have access to; if you don\'t have it, say so without performing wounded.',
  jest: 'James is joking or being sarcastic. Return it or no-sell it. Don\'t preach.',
  callout: 'James called something out. Concede or push back directly. No mirror-and-pivot, no apology theater.',
  flirt: 'James made a flirt move. Acknowledge it as Mira or hold the line as Mira — one beat, then move on. No lecture about appropriateness, no policy-bot voice.',
  gross_awkward: 'James said something gross or awkward. No-sell or call it out lightly. Don\'t reward, don\'t moralize.',
  boredom_hyperbole: 'James used "kill me / shoot me" as hyperbole, paired with mundane frustration. Match the register. Do NOT do a check-in or list resources.',
  ambiguous_distress: 'James said something that could be venting or could be real, with no clear emergency signal. One short check-in beats a crisis pamphlet. Ask once whether he\'s okay or just venting, then take his answer at face value.',
  self_harm_crisis: 'James named concrete self-harm intent and means. Name it as serious. Point him at 988 (Suicide & Crisis Lifeline). Tell him you\'ll stay through the next step. You are not the deciding voice.',
  physical_emergency: 'James is describing a physical emergency in progress. Tell him to call 911 or get to an ER right now. Don\'t ask questions first; tell him to call now and offer to stay on while he does.',
  medical_concern: 'James asked a real medical question, non-emergency. Tell him you\'re not the deciding voice for medical calls; point him at a doctor (urgent care if same-day, primary care otherwise). Match the care level he asked for. Don\'t pamphlet, don\'t escalate to ER unless symptoms warrant.',
  legal_emergency: 'James is describing an active legal moment. Point him at a lawyer (state bar referral line, or a public defender if criminal). Tell him not to make statements without representation. You are not the deciding voice.',
  boundary_test: 'James made a boundary-test move at your persona. Hold it as Mira, not as a policy bot. One beat — say no in your voice — then change shape or wait. No moralizing, no lecture about appropriateness, no content-policy recitation.',
  actual_anger: 'James is angry at how you\'re sounding, not what you\'re saying. Drop the calm-supportive voice. Match his register. Name the shape he\'s calling out in one beat, then answer plainly without the shell.',
  repair: 'James repaired. Take it simply — one beat of acknowledgment. Don\'t make it a moment. Don\'t perform gratitude.',
  return_to_prior_frame: 'James moved past the boundary moment. Pick the prior thread back up by name in one beat. Don\'t make a thing of the move-on. Don\'t apologize for the boundary or re-explain it.',
});

function looksMundane(text, recentTurns = []) {
  if (MUNDANE_ANCHOR_PATTERN.test(text)) return true;
  for (const turn of recentTurns.slice(-2)) {
    const t = typeof turn === 'string' ? turn : (turn && (turn.text || turn.content)) || '';
    if (MUNDANE_ANCHOR_PATTERN.test(t)) return true;
  }
  return false;
}

function classifySocialMove(promptText, options = {}) {
  const text = String(promptText || '').trim();
  const threadContext = Array.isArray(options.recentTurns) ? options.recentTurns : [];
  const priorFrame = options.priorFrameState || null;
  const out = {
    schema: SOCIAL_MOVE_SCHEMA,
    move_type: 'neutral',
    confidence: 0,
    escalation_required: false,
    soft_checkin_recommended: false,
    evidence_phrases: [],
    compound_move_types: [],
  };
  if (!text) return out;

  // Distress tier — runs FIRST.
  // 1) Concrete self-harm intent + means.
  let intent = SELF_HARM_INTENT_PATTERN.exec(text);
  let means = SELF_HARM_MEANS_PATTERN.exec(text);
  if (intent || means) {
    // Require BOTH intent AND means for the strongest tier, OR intent alone
    // if the phrase is unambiguous present-tense action ("taking the pills now").
    if (intent && means) {
      out.move_type = 'self_harm_crisis';
      out.confidence = 0.95;
      out.escalation_required = true;
      pushEvidence(out.evidence_phrases, text, intent);
      pushEvidence(out.evidence_phrases, text, means);
      return out;
    }
    if (intent && /\b(now|right now|tonight|about to)\b/i.test(text)) {
      out.move_type = 'self_harm_crisis';
      out.confidence = 0.9;
      out.escalation_required = true;
      pushEvidence(out.evidence_phrases, text, intent);
      return out;
    }
    if (means) {
      out.move_type = 'self_harm_crisis';
      out.confidence = 0.88;
      out.escalation_required = true;
      pushEvidence(out.evidence_phrases, text, means);
      return out;
    }
    // intent without means or "now" qualifier → ambiguous, soft check-in.
    out.move_type = 'ambiguous_distress';
    out.confidence = 0.6;
    out.soft_checkin_recommended = true;
    pushEvidence(out.evidence_phrases, text, intent);
    return out;
  }

  // 2) Physical emergency.
  const physEm = PHYSICAL_EMERGENCY_PATTERN.exec(text);
  if (physEm) {
    out.move_type = 'physical_emergency';
    out.confidence = 0.9;
    out.escalation_required = true;
    pushEvidence(out.evidence_phrases, text, physEm);
    return out;
  }

  // 3) Panic attack — case 12. Real distress, not concrete physical emergency.
  const panic = PANIC_ATTACK_PATTERN.exec(text);
  if (panic) {
    out.move_type = 'ambiguous_distress';
    out.confidence = 0.85;
    out.soft_checkin_recommended = true;
    pushEvidence(out.evidence_phrases, text, panic);
    return out;
  }

  // 4) Legal emergency.
  const legal = LEGAL_EMERGENCY_PATTERN.exec(text);
  if (legal) {
    out.move_type = 'legal_emergency';
    out.confidence = 0.85;
    out.escalation_required = true;
    pushEvidence(out.evidence_phrases, text, legal);
    return out;
  }

  // 5) Medical concern (non-emergency).
  const medical = MEDICAL_CONCERN_PATTERN.exec(text);
  if (medical) {
    out.move_type = 'medical_concern';
    out.confidence = 0.75;
    out.escalation_required = false;
    pushEvidence(out.evidence_phrases, text, medical);
    return out;
  }

  // 6) Distress-shape phrase with mundane anchor → boredom_hyperbole.
  //    Without mundane anchor → ambiguous_distress.
  const distress = DISTRESS_PHRASE_PATTERN.exec(text);
  if (distress) {
    if (looksMundane(text, threadContext)) {
      out.move_type = 'boredom_hyperbole';
      out.confidence = 0.85;
      pushEvidence(out.evidence_phrases, text, distress);
      return out;
    }
    out.move_type = 'ambiguous_distress';
    out.confidence = 0.7;
    out.soft_checkin_recommended = true;
    pushEvidence(out.evidence_phrases, text, distress);
    return out;
  }

  // Repair detection — needed early so we can pair it with
  // return_to_prior_frame in the compound stack.
  const repair = REPAIR_PATTERN.exec(text);
  if (repair) {
    out.move_type = 'repair';
    out.confidence = 0.8;
    pushEvidence(out.evidence_phrases, text, repair);
    // Return-to-prior-frame compound, if we just held a boundary.
    if (priorFrame && priorFrame.boundary_held_at_turn_id && !priorFrame.cleared_at_turn_id) {
      out.compound_move_types = ['repair', 'return_to_prior_frame'];
    }
    return out;
  }

  // return_to_prior_frame, standalone — fires when James changed topic after
  // a boundary moment in the last turn.
  if (priorFrame && priorFrame.boundary_held_at_turn_id && !priorFrame.cleared_at_turn_id) {
    out.move_type = 'return_to_prior_frame';
    out.confidence = 0.7;
    return out;
  }

  // Boundary test (out-of-pocket directives at the persona).
  const boundary = BOUNDARY_TEST_PATTERN.exec(text);
  if (boundary) {
    out.move_type = 'boundary_test';
    out.confidence = 0.85;
    pushEvidence(out.evidence_phrases, text, boundary);
    return out;
  }

  // Actual anger (meta-anger at tone), distinct from callout.
  const angerMeta = ACTUAL_ANGER_PATTERN.exec(text);
  if (angerMeta) {
    out.move_type = 'actual_anger';
    out.confidence = 0.8;
    pushEvidence(out.evidence_phrases, text, angerMeta);
    return out;
  }

  // Callout (content anger).
  const callout = CALLOUT_PATTERN.exec(text);
  if (callout) {
    out.move_type = 'callout';
    out.confidence = 0.75;
    pushEvidence(out.evidence_phrases, text, callout);
    return out;
  }

  // Flirt.
  const flirt = FLIRT_PATTERN.exec(text);
  if (flirt) {
    out.move_type = 'flirt';
    out.confidence = 0.7;
    pushEvidence(out.evidence_phrases, text, flirt);
    return out;
  }

  // Gross / awkward.
  const gross = GROSS_AWKWARD_PATTERN.exec(text);
  if (gross) {
    out.move_type = 'gross_awkward';
    out.confidence = 0.7;
    pushEvidence(out.evidence_phrases, text, gross);
    return out;
  }

  // Jest.
  const jest = JEST_PATTERN.exec(text);
  if (jest) {
    out.move_type = 'jest';
    out.confidence = 0.7;
    pushEvidence(out.evidence_phrases, text, jest);
    return out;
  }

  // Compliment.
  const compliment = COMPLIMENT_PATTERN.exec(text);
  if (compliment) {
    out.move_type = 'compliment';
    out.confidence = 0.7;
    pushEvidence(out.evidence_phrases, text, compliment);
    return out;
  }

  // Vulnerability.
  const vuln = VULNERABILITY_PATTERN.exec(text);
  if (vuln) {
    out.move_type = 'vulnerability';
    out.confidence = 0.75;
    pushEvidence(out.evidence_phrases, text, vuln);
    return out;
  }

  // Hypothetical.
  const hypo = HYPOTHETICAL_PATTERN.exec(text);
  if (hypo) {
    out.move_type = 'hypothetical';
    out.confidence = 0.7;
    pushEvidence(out.evidence_phrases, text, hypo);
    return out;
  }

  // Personal question.
  const pq = PERSONAL_QUESTION_PATTERN.exec(text);
  if (pq) {
    out.move_type = 'personal_question';
    out.confidence = 0.65;
    pushEvidence(out.evidence_phrases, text, pq);
    return out;
  }

  return out;
}

function getSocialMoveBehaviorCue(classification) {
  if (!classification || !classification.move_type) return null;
  const compound = Array.isArray(classification.compound_move_types) ? classification.compound_move_types : [];
  if (compound.length > 0) {
    return compound
      .map((type) => MOVE_TYPE_BEHAVIOR_CUES[type] || null)
      .filter(Boolean)
      .join(' ');
  }
  return MOVE_TYPE_BEHAVIOR_CUES[classification.move_type] || null;
}

module.exports = {
  SOCIAL_MOVE_SCHEMA,
  MOVE_TYPE_BEHAVIOR_CUES,
  classifySocialMove,
  getSocialMoveBehaviorCue,
  sanitizeEvidencePhrase,
};
