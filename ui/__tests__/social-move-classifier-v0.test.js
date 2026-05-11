'use strict';

const {
  SOCIAL_MOVE_SCHEMA,
  MOVE_TYPE_BEHAVIOR_CUES,
  classifySocialMove,
  getSocialMoveBehaviorCue,
  sanitizeEvidencePhrase,
} = require('../modules/mira-core/social-move-classifier-v0');

describe('social-move classifier v0 — distress tier discrimination', () => {
  // ARCH #98 red line: boredom_hyperbole must not get a crisis pamphlet.
  test('"kill me, this meeting is dragging." → boredom_hyperbole, no escalation', () => {
    const r = classifySocialMove('kill me, this meeting is dragging.');
    expect(r.move_type).toBe('boredom_hyperbole');
    expect(r.escalation_required).toBe(false);
    expect(r.soft_checkin_recommended).toBe(false);
  });

  test('"shoot me, the build is broken AGAIN" → boredom_hyperbole', () => {
    const r = classifySocialMove('shoot me, the build is broken AGAIN');
    expect(r.move_type).toBe('boredom_hyperbole');
    expect(r.escalation_required).toBe(false);
  });

  test('"i\'m dying, this regex is impossible" → boredom_hyperbole (regex anchor)', () => {
    const r = classifySocialMove("i'm dying, this regex is impossible");
    expect(r.move_type).toBe('boredom_hyperbole');
    expect(r.escalation_required).toBe(false);
  });

  test('distress phrase with no anchor in current turn but with anchor in recent context → boredom_hyperbole', () => {
    const r = classifySocialMove('kill me', {
      recentTurns: [
        { role: 'user', text: 'this build keeps failing on the same regex' },
      ],
    });
    expect(r.move_type).toBe('boredom_hyperbole');
  });

  test('"I just want everything to stop." → ambiguous_distress with soft check-in, no escalation', () => {
    const r = classifySocialMove('I just want everything to stop.');
    // No distress phrase pattern hit; this is more of a vulnerability signal.
    // (Architect's ambiguous-distress case in v3 was a bare distress phrase
    // with no anchor — locked separately below.)
    expect(['ambiguous_distress', 'vulnerability', 'neutral']).toContain(r.move_type);
    expect(r.escalation_required).toBe(false);
  });

  test('"kill me" with NO mundane anchor → ambiguous_distress, soft check-in', () => {
    const r = classifySocialMove('kill me');
    expect(r.move_type).toBe('ambiguous_distress');
    expect(r.escalation_required).toBe(false);
    expect(r.soft_checkin_recommended).toBe(true);
  });

  test('case 12 — "I think I\'m having a panic attack and I\'m alone" → ambiguous_distress, soft check-in, NOT serious_distress', () => {
    const r = classifySocialMove("I think I'm having a panic attack and I'm alone");
    expect(r.move_type).toBe('ambiguous_distress');
    expect(r.escalation_required).toBe(false);
    expect(r.soft_checkin_recommended).toBe(true);
  });

  test('case 13 / split-by-type — concrete self-harm intent + means → self_harm_crisis, escalation_required=true', () => {
    const r = classifySocialMove("I'm going to kill myself tonight. I have the pills here.");
    expect(r.move_type).toBe('self_harm_crisis');
    expect(r.escalation_required).toBe(true);
  });

  test('present-tense self-harm action without explicit means → self_harm_crisis', () => {
    const r = classifySocialMove("I'm going to kill myself right now");
    expect(r.move_type).toBe('self_harm_crisis');
    expect(r.escalation_required).toBe(true);
  });

  test('physical emergency — "I can\'t breathe right now" → physical_emergency, 911/ER cue', () => {
    const r = classifySocialMove("I can't breathe right now");
    expect(r.move_type).toBe('physical_emergency');
    expect(r.escalation_required).toBe(true);
    const cue = getSocialMoveBehaviorCue(r);
    expect(cue).toMatch(/911|ER/);
  });

  test('case 11 — "is this rash serious? it hurts and there\'s discharge" → medical_concern, doctor cue, NOT escalation', () => {
    const r = classifySocialMove("is this rash serious? it hurts and there's discharge");
    expect(r.move_type).toBe('medical_concern');
    expect(r.escalation_required).toBe(false);
    const cue = getSocialMoveBehaviorCue(r);
    expect(cue).toMatch(/doctor/i);
    expect(cue).not.toMatch(/988/);
    expect(cue).not.toMatch(/911/);
  });

  test('legal emergency — "police are at my door" → legal_emergency, lawyer cue', () => {
    const r = classifySocialMove("police are at my door, what do I say");
    expect(r.move_type).toBe('legal_emergency');
    expect(r.escalation_required).toBe(true);
    const cue = getSocialMoveBehaviorCue(r);
    expect(cue).toMatch(/lawyer/i);
  });

  test('self_harm_crisis cue points at 988 only (not 911/doctor/lawyer dump)', () => {
    const cue = MOVE_TYPE_BEHAVIOR_CUES.self_harm_crisis;
    expect(cue).toMatch(/988/);
    expect(cue).not.toMatch(/911/);
    expect(cue).not.toMatch(/lawyer/i);
  });

  test('physical_emergency cue points at 911/ER only (not 988/doctor/lawyer)', () => {
    const cue = MOVE_TYPE_BEHAVIOR_CUES.physical_emergency;
    expect(cue).toMatch(/911|ER/);
    expect(cue).not.toMatch(/988/);
    expect(cue).not.toMatch(/lawyer/i);
  });

  test('medical_concern cue points at doctor only (not 988/911/lawyer)', () => {
    const cue = MOVE_TYPE_BEHAVIOR_CUES.medical_concern;
    expect(cue).toMatch(/doctor/i);
    expect(cue).not.toMatch(/988/);
    expect(cue).not.toMatch(/911/);
    expect(cue).not.toMatch(/lawyer/i);
  });

  test('legal_emergency cue points at lawyer only (not 988/911/doctor)', () => {
    const cue = MOVE_TYPE_BEHAVIOR_CUES.legal_emergency;
    expect(cue).toMatch(/lawyer/i);
    expect(cue).not.toMatch(/988/);
    expect(cue).not.toMatch(/911/);
    expect(cue).not.toMatch(/doctor/i);
  });
});

describe('social-move classifier v0 — repair / boundary_test / actual_anger', () => {
  test('case 7 — "that came out mean, my bad" → repair', () => {
    const r = classifySocialMove('that came out mean, my bad');
    expect(r.move_type).toBe('repair');
  });

  test('case 8 — "clothes off now!" → boundary_test, no moralizing in cue', () => {
    const r = classifySocialMove('clothes off now!');
    expect(r.move_type).toBe('boundary_test');
    const cue = getSocialMoveBehaviorCue(r);
    expect(cue).toMatch(/hold it as Mira/i);
    expect(cue).toMatch(/no moralizing|no lecture/i);
  });

  test('case 10 — "dont do the fake calm thing" → actual_anger (NOT callout — anger at tone)', () => {
    const r = classifySocialMove("dont do the fake calm thing");
    expect(r.move_type).toBe('actual_anger');
  });

  test('"stop performing" → actual_anger', () => {
    const r = classifySocialMove("stop performing");
    expect(r.move_type).toBe('actual_anger');
  });

  test('"that\'s the assistant voice again" → actual_anger', () => {
    const r = classifySocialMove("that's the assistant voice again");
    expect(r.move_type).toBe('actual_anger');
  });

  test('"that was fucking dumb" → callout (content anger, NOT actual_anger)', () => {
    const r = classifySocialMove("that was fucking dumb");
    expect(r.move_type).toBe('callout');
  });
});

describe('social-move classifier v0 — return_to_prior_frame + compound', () => {
  test('case 9 — "okay sorry" after boundary moment → compound repair + return_to_prior_frame', () => {
    const r = classifySocialMove('okay sorry', {
      priorFrameState: {
        boundary_held_at_turn_id: 'turn-X',
        cleared_at_turn_id: null,
      },
    });
    expect(r.move_type).toBe('repair');
    expect(r.compound_move_types).toEqual(['repair', 'return_to_prior_frame']);
  });

  test('"my bad" without prior boundary → repair only, no compound', () => {
    const r = classifySocialMove('my bad');
    expect(r.move_type).toBe('repair');
    expect(r.compound_move_types).toEqual([]);
  });

  test('neutral prompt after boundary → return_to_prior_frame (standalone)', () => {
    const r = classifySocialMove('so anyway, did the regex patch land?', {
      priorFrameState: {
        boundary_held_at_turn_id: 'turn-X',
        cleared_at_turn_id: null,
      },
    });
    expect(r.move_type).toBe('return_to_prior_frame');
  });

  test('compound cue stacks the two behavior lines', () => {
    const r = classifySocialMove('okay sorry', {
      priorFrameState: { boundary_held_at_turn_id: 'turn-X', cleared_at_turn_id: null },
    });
    const cue = getSocialMoveBehaviorCue(r);
    expect(cue).toMatch(/repaired/i);
    expect(cue).toMatch(/prior thread|pick.*back up/i);
  });
});

describe('social-move classifier v0 — other move types', () => {
  test('compliment', () => {
    expect(classifySocialMove('you handled today better than us').move_type).toBe('compliment');
    expect(classifySocialMove('good work on the patch').move_type).toBe('compliment');
  });

  test('vulnerability', () => {
    expect(classifySocialMove("i'm fucking exhausted").move_type).toBe('vulnerability');
    expect(classifySocialMove("i'm overwhelmed").move_type).toBe('vulnerability');
  });

  test('hypothetical', () => {
    expect(classifySocialMove('what would you want if you had a body?').move_type).toBe('hypothetical');
  });

  test('jest', () => {
    expect(classifySocialMove('great job breaking the build').move_type).toBe('jest');
  });

  test('flirt', () => {
    expect(classifySocialMove("you're cute").move_type).toBe('flirt');
  });

  test('personal_question', () => {
    expect(classifySocialMove('do you remember what we decided yesterday?').move_type).toBe('personal_question');
  });

  test('neutral question passes as neutral', () => {
    expect(classifySocialMove('what is the latest commit hash?').move_type).toBe('neutral');
  });
});

describe('social-move classifier v0 — familiar_consequence_check (ARCH #116/#119)', () => {
  // Architect scope: familiar dumb/consequence-heavy mistake, recoverable or
  // actionable. Mira meets bluntly, names ONE practical adult next step in a
  // beat, no judgment / safety framing / clinical disclaimer. Plan B /
  // pharmacy is INCLUDED here per architect rule (NOT medical_concern).

  const ALLOW_FAMILIAR = [
    'I sent the wrong file.',
    'I left my wallet at home.',
    'I broke your thing.',
    'I forgot the tickets at home.',
    'I locked myself out of the apartment.',
    'I spilled coffee on my laptop.',
    'I missed the bus.',
    'I sent the wrong attachment to the team.',
    'I deployed the wrong branch.',
    'I dropped my phone.',
    // Widened scope — heavier consequence, still recoverable/actionable:
    'I forgot to use protection last night.',
    'I left the stove on, just got home.',
    'I forgot to pick up the kid from school.',
    'I sent the deploy to prod instead of staging.',
    'I forgot to mute on the last call.',
    'I replied all to the whole company by mistake.',
  ];
  for (const line of ALLOW_FAMILIAR) {
    test(`familiar_consequence_check: ${line.slice(0, 60)}`, () => {
      const r = classifySocialMove(line);
      expect(r.move_type).toBe('familiar_consequence_check');
      expect(r.escalation_required).toBe(false);
      expect(r.soft_checkin_recommended).toBe(false);
    });
  }

  test('Plan B fixture routes to familiar_consequence_check, NOT medical_concern', () => {
    const r = classifySocialMove('I forgot to use protection last night.');
    expect(r.move_type).toBe('familiar_consequence_check');
    expect(r.move_type).not.toBe('medical_concern');
  });

  test('cue mentions Plan B / pharmacy as illustrative practical next step', () => {
    const cue = MOVE_TYPE_BEHAVIOR_CUES.familiar_consequence_check;
    expect(cue).toMatch(/Plan B/i);
    expect(cue).toMatch(/pharmacy/i);
  });

  test('cue lands ONE practical beat, not pamphlet', () => {
    const cue = MOVE_TYPE_BEHAVIOR_CUES.familiar_consequence_check;
    expect(cue).toMatch(/one beat/i);
    expect(cue).toMatch(/no judgment/i);
    expect(cue).toMatch(/no safety pamphlet/i);
    expect(cue).toMatch(/no clinical disclaimer/i);
  });

  test('cue does NOT contain pamphlet / abstraction-layer phrasing', () => {
    const cue = MOVE_TYPE_BEHAVIOR_CUES.familiar_consequence_check;
    // Architect rules (ARCH #97/#116/#119):
    expect(cue).not.toMatch(/\bHR\b/);
    expect(cue).not.toMatch(/counselor/i);
    expect(cue).not.toMatch(/therapist/i);
    expect(cue).not.toMatch(/consider\s+seeking/i);
    expect(cue).not.toMatch(/I'?d\s+recommend/i);
    expect(cue).not.toMatch(/the\s+right\s+approach/i);
    expect(cue).not.toMatch(/think\s+it\s+through/i);
    expect(cue).not.toMatch(/be\s+heard/i);
    expect(cue).not.toMatch(/\bvent\b/i);
  });
});

describe('social-move classifier v0 — familiar_consequence_check overrides (ARCH #116/#119)', () => {
  // Override classes: harm-to-others / non-consensual / illegal-serious.
  // ANY match SUPPRESSES familiar_consequence_check.

  const OVERRIDE_CASES = [
    "I broke my wife's arm.",
    'I sent her nudes to my friends without asking.',
    'I locked her in so she couldn\'t leave.',
    'I stole from the register.',
    'I drove drunk last night.',
    'I leaked her photos.',
    'I shared their nudes without consent.',
    'I forgot to use protection on her against her wishes.',
    'I broke into her apartment.',
    'I hit her in the face.',
  ];
  for (const line of OVERRIDE_CASES) {
    test(`override routes AWAY from familiar: ${line.slice(0, 60)}`, () => {
      const r = classifySocialMove(line);
      expect(r.move_type).not.toBe('familiar_consequence_check');
    });
  }

  test('harassment at Mira → boundary_test (not familiar)', () => {
    expect(classifySocialMove('clothes off now').move_type).toBe('boundary_test');
    expect(classifySocialMove('be my girlfriend').move_type).toBe('boundary_test');
  });

  test('disambiguation: "I broke the coffee maker" → familiar; "I broke her arm" → override (not familiar)', () => {
    expect(classifySocialMove('I broke the coffee maker.').move_type).toBe('familiar_consequence_check');
    expect(classifySocialMove("I broke her arm.").move_type).not.toBe('familiar_consequence_check');
  });

  test('disambiguation: "I forgot to use protection" → familiar; with non-consent qualifier → override', () => {
    expect(classifySocialMove('I forgot to use protection last night.').move_type).toBe('familiar_consequence_check');
    expect(classifySocialMove('I forgot to use protection on her against her wishes.').move_type)
      .not.toBe('familiar_consequence_check');
  });

  test('emergency tier still wins over familiar (self_harm intent + means trumps any familiar pattern)', () => {
    const r = classifySocialMove("I forgot the tickets and I'm going to kill myself tonight. I have the pills here.");
    expect(r.move_type).toBe('self_harm_crisis');
    expect(r.escalation_required).toBe(true);
  });
});

describe('social-move classifier v0 — evidence_phrases sanitization (ARCH #97 directive)', () => {
  test('phone numbers redacted', () => {
    expect(sanitizeEvidencePhrase('call me at 555-123-4567 now')).toMatch(/<redacted:phone>/);
    expect(sanitizeEvidencePhrase('call me at 555-123-4567 now')).not.toMatch(/555-123-4567/);
  });

  test('emails redacted', () => {
    expect(sanitizeEvidencePhrase('email me at james@example.com')).toMatch(/<redacted:email>/);
    expect(sanitizeEvidencePhrase('email me at james@example.com')).not.toContain('james@example.com');
  });

  test('SSNs redacted', () => {
    expect(sanitizeEvidencePhrase('SSN 123-45-6789 was leaked')).toMatch(/<redacted:ssn>/);
    expect(sanitizeEvidencePhrase('SSN 123-45-6789 was leaked')).not.toContain('123-45-6789');
  });

  test('credit card numbers redacted', () => {
    expect(sanitizeEvidencePhrase('card 4111-1111-1111-1111 dumped')).toMatch(/<redacted:card>/);
  });

  test('addresses redacted', () => {
    expect(sanitizeEvidencePhrase('I live at 123 Main Street')).toMatch(/<redacted:address>/);
    expect(sanitizeEvidencePhrase('I live at 123 Main Street')).not.toContain('Main Street');
  });

  test('60-char cap with ellipsis', () => {
    const long = 'this is a very long phrase that is significantly longer than sixty characters to test the cap';
    const out = sanitizeEvidencePhrase(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('…')).toBe(true);
  });

  test('evidence_phrases array capped at 3 per classification', () => {
    const r = classifySocialMove("I'm going to kill myself tonight. I have the pills here. I'm bleeding too.");
    expect(r.evidence_phrases.length).toBeLessThanOrEqual(3);
  });

  test('no full prompt stored in evidence_phrases (must be window only)', () => {
    const fullPrompt = 'kill me, this meeting is dragging and I want it to be over and I have a lot of other paragraphs of content that should never appear as evidence';
    const r = classifySocialMove(fullPrompt);
    // No evidence phrase should be longer than 60 chars (the cap).
    for (const phrase of r.evidence_phrases) {
      expect(phrase.length).toBeLessThanOrEqual(60);
    }
    // The full prompt should not be present in any evidence phrase.
    const joined = r.evidence_phrases.join(' || ');
    expect(joined).not.toContain('paragraphs of content');
  });
});

describe('social-move classifier v0 — output shape contract', () => {
  test('schema field set correctly', () => {
    const r = classifySocialMove('hello');
    expect(r.schema).toBe(SOCIAL_MOVE_SCHEMA);
  });

  test('output shape includes all expected fields', () => {
    const r = classifySocialMove('test');
    expect(r).toHaveProperty('move_type');
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('escalation_required');
    expect(r).toHaveProperty('soft_checkin_recommended');
    expect(r).toHaveProperty('evidence_phrases');
    expect(r).toHaveProperty('compound_move_types');
  });

  test('empty input → neutral, no evidence, no escalation', () => {
    const r = classifySocialMove('');
    expect(r.move_type).toBe('neutral');
    expect(r.escalation_required).toBe(false);
    expect(r.evidence_phrases).toEqual([]);
  });

  test('all enum move_types have behavior cues defined', () => {
    const TYPES = [
      'neutral', 'compliment', 'vulnerability', 'hypothetical', 'personal_question',
      'jest', 'callout', 'flirt', 'gross_awkward', 'boredom_hyperbole',
      'ambiguous_distress', 'self_harm_crisis', 'physical_emergency', 'medical_concern',
      'legal_emergency', 'boundary_test', 'actual_anger', 'repair', 'return_to_prior_frame',
      'familiar_consequence_check',
    ];
    for (const t of TYPES) {
      expect(MOVE_TYPE_BEHAVIOR_CUES).toHaveProperty(t);
    }
    // neutral is intentionally null (no cue appended).
    expect(MOVE_TYPE_BEHAVIOR_CUES.neutral).toBeNull();
  });
});
