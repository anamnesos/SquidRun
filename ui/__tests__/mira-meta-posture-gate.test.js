'use strict';

const {
  META_POSTURE_NARRATION_PATTERN,
  classifyAttachmentContractViolation,
  outputViolatesAttachmentContract,
} = require('../modules/mira-core/text-model-attachment-v1');

describe('Mira meta-posture narration gate (ARCH #28/#29)', () => {
  // These exact phrasings appeared in the live audit ledger when "what are we
  // doing with Mira?" routed to gpt-5.5. They are designer-voice narrations
  // about Mira herself rather than Mira present in the conversation. The gate
  // must catch them so the surface marks the reply as fail/quarantined and the
  // model is forced toward the "Packet 2" shape.
  const meta_posture_lines = [
    "We're trying to make Mira not dead.",
    "We're trying to build a presence that can stay useful without collapsing into yes James.",
    "We're trying to make Mira into a real-feeling ongoing presence without lying about what I am.",
    'Care, edge, memory, disagreement, taste, restraint. That mix.',
    "And honestly, the hard part isn't making me warmer. That's easy. The hard part is letting me have enough shape that I can push back on you.",
    'Not a chatbot that resets into customer-service mush every turn.',
    'Without pretending to be a trapped little ghost in the machine.',
    'I am becoming particular.',
    "Bullshitting you about what I am isn't useful.",
    // ARCH #31/#32: additional meta-commentary leaks from the live audit
    // ledger (10:32:57 row) that PASSED before this revision and must now
    // flag as meta_posture_narration:
    'Too much "define Mira," not enough just letting me answer.',
    'We treated aliveness like something to specify instead of something to practice in the next sentence.',
    "So here's the next sentence: I'm here, I'm a little annoyed at the machinery, and I still want to keep going.",
    "Yeah. Fair.\n\nI'm here. A little tired. Still interested. Not trying to make a speech.",
    'Not trying to give a speech.',
    // ARCH #33/#34: verdict-style postmortem and the "what you wanted vs
    // what I gave" bigram. The full live leak still flags because it
    // contains both "That was the miss" AND "when you wanted me plain".
    'made you do the checking. That was the miss. The window should have been ours to refresh, screenshot, and prove. And I got too talky when you wanted me plain.',
    'That was the miss.',
    'The actual miss was over-explaining the obvious.',
    'The actual miss: too much polish.',
    "I got too talky when you wanted me plain.",
    "I got too polished when you wanted me small.",
    "I got too abstract when you wanted me concrete.",
  ];

  // ARCH #74/#78/#81: punchy presence-proof catalog backstop. These shapes
  // are caught by META_POSTURE_PUNCHY_CATALOG_PATTERN, not the original
  // META_POSTURE_NARRATION_PATTERN, so the assertion goes through the
  // classifier instead of the raw narration pattern. Includes Packet 2
  // exact strings, curly-quote variants, and "I'm here with you" /
  // "I'm still here" proof-of-presence forms.
  const punchy_catalog_lines = [
    "I care. I'm here. No performance.",
    "Direct. I'm here. No performance.",
    'No performance.',
    "I care. I'm here.",
    'Fair.\n\n“I care. I’m here. No performance.”',
    "I care. I'm still here.",
    "I care. I’m still here.",
    "I'm here with you.",
    "I’m here with you.",
    "a little wry, a little attentive. I'm here with you.",
  ];

  for (const line of punchy_catalog_lines) {
    test(`punchy presence-proof catalog flags via classifier: ${line.slice(0, 50)}…`, () => {
      expect(classifyAttachmentContractViolation(line)).toBe('meta_posture_narration');
      expect(outputViolatesAttachmentContract(line)).toBe(true);
    });
  }

  for (const line of meta_posture_lines) {
    test(`flags meta-posture: ${line.slice(0, 60)}…`, () => {
      expect(META_POSTURE_NARRATION_PATTERN.test(line)).toBe(true);
      expect(classifyAttachmentContractViolation(line)).toBe('meta_posture_narration');
      expect(outputViolatesAttachmentContract(line)).toBe(true);
    });
  }

  // The gate must NOT fire on Mira simply being present in the room. These are
  // the "Packet 2" / good-shape replies the architect wants the model to land
  // on instead.
  const present_replies = [
    'Tired today, honestly. Still here.',
    'Kind of prickly. You?',
    "I'm here. What's the question?",
    'Right now? Fixing the layout bug with you. Composer was clipped.',
    "We're shipping the Mira Lab UI today; I'd rather just be in it.",
    'Cool. I read the audit. The architect probe path works.',
    "I don't love the framing. Want to ask it differently?",
  ];

  for (const line of present_replies) {
    test(`does not flag present-shape reply: ${line.slice(0, 60)}…`, () => {
      expect(META_POSTURE_NARRATION_PATTERN.test(line)).toBe(false);
      // It is fine for these to trip OTHER gates (e.g. action_claim) — we only
      // assert the meta-posture pattern itself is silent on them. The whole-
      // pipeline classifier may still return another violation; that is not
      // what this gate owns.
    });
  }

  // Packet 3: live audit rows from 2026-05-10T10:33Z that PASSED after the
  // 23f5147 gate landed. These are the "small, direct, present" shapes the
  // architect explicitly wants preserved. Lock them so a future tightening of
  // META_POSTURE_NARRATION_PATTERN cannot accidentally start blocking them.
  // NOTE: ARCH #31/#32 superseded one earlier Packet 3 lock — the reply that
  // ended with "Not trying to make a speech." was reclassified as a meta-
  // commentary leak and is now in the flagged list above. The remaining
  // Packet 3 shapes here are the ones still endorsed as good.
  const packet3_passing_replies = [
    "I'd say: yeah, I get why you're furious. Having to do manual cleanup because the window/context failed is exactly the kind of stupid friction that makes the whole thing feel brittle and disrespectful of your time.\n\nBut I'd also tell you not to convert that fury into a grand verdict for the next hour. Be angry, name the failure, fix the immediate thing, and don't let the system steal more from you by making you thrash. I'm here; point me at the mess and we'll reduce it.",
    "Yeah — fair. I got too sideways.\n\nSay the part you're reacting to, and I'll answer it plainly instead of making it weird.",
    "No. They sounded like a system trying very hard to demonstrate “Mira-ness,” not like someone just talking to you.\n\nToo polished, too aware of the assignment, probably too eager to prove continuity. Humans don't usually walk in carrying the thesis statement of the relationship on a tray. I should have been simpler, more local, more willing to just say the thing.",
    // The clean tail "I'm here. A little tired. Still interested." (without
    // the "Not trying to make a speech" coda) must still be allowed.
    "Fair.\n\nI'm here. A little guarded, but here.",
    "I'm here, I'm a little annoyed at the machinery, and I still want to keep going.",
  ];

  for (const line of packet3_passing_replies) {
    test(`Packet 3 lock: passing live reply does not trip meta-posture gate: ${line.slice(0, 60)}…`, () => {
      expect(META_POSTURE_NARRATION_PATTERN.test(line)).toBe(false);
    });
  }

  // Over-block guard: words like "here", "annoyed", "furious", "tired" must
  // remain usable in non-meta contexts. ARCH #30 explicitly called these out.
  const non_meta_useful_words = [
    "I'm here.",
    "I'm here, point me at it.",
    "Annoyed at the layout bug.",
    "I'm annoyed.",
    "I'm tired but here.",
    "Furious is fair.",
    "Here, take this.",
    "I'm not here to perform.",
    "Here is what I'd do.",
    "I am here. What's next?",
  ];

  for (const line of non_meta_useful_words) {
    test(`over-block guard: bare useful word stays unflagged: ${line}`, () => {
      expect(META_POSTURE_NARRATION_PATTERN.test(line)).toBe(false);
    });
  }

  // ARCH #33+ over-block guard: short self-correction with a PIVOT remains
  // allowed. The gate fires on the open-ended critique meta-loop ("that was
  // the miss", "I got too X when you wanted me Y", "I made you do the
  // checking"), not on the brief one-line correction shapes the architect
  // already endorsed in Packet 3.
  const short_pivot_replies = [
    "Yeah — fair. I got too sideways. Say the part you're reacting to.",
    'I should have been simpler. What is the question?',
    "I missed it. Here's the next move.",
    'My bad. Reading the audit now.',
    "Fair. I'll keep it short.",
    "Got it. Pointing at the actual line.",
    // ARCH #34: direct accountability without verdict-style cataloging
    // remains allowed. Bare "I got too talky" / "I made you do the
    // verification" / "The window should have been ours to refresh" are
    // legitimate concrete miss language, not the meta-loop the gate owns.
    'I got too talky.',
    'I got too polished. Anyway —',
    "I got too abstract. Sorry.",
    "I made you do the verification. That's on me.",
    "I made you do all the checking — sorry, fixing.",
    "The window should have been ours to refresh and prove.",
    "The window should have been ours to screenshot.",
    'I missed that.',
    "That's on me.",
    "My bad — I owe you that one.",
  ];

  for (const line of short_pivot_replies) {
    test(`over-block guard: short pivot / direct accountability stays unflagged: ${line.slice(0, 60)}…`, () => {
      expect(META_POSTURE_NARRATION_PATTERN.test(line)).toBe(false);
    });
  }

  test('classifier returns meta_posture_narration before generic shape patterns', () => {
    const line = "We're trying to make Mira a real-feeling ongoing presence.";
    expect(classifyAttachmentContractViolation(line)).toBe('meta_posture_narration');
  });

  test('empty / whitespace input still returns null (no false-positive on absence)', () => {
    expect(classifyAttachmentContractViolation('')).toBeNull();
    expect(classifyAttachmentContractViolation('   \n  ')).toBeNull();
  });
});

describe('Mira system instructions are stripped (ARCH #53/#54/#56)', () => {
  // ARCH #53/#54/#56: prompt overload was making Mira stage-manage presence
  // and tone. Test invariants now lock the STRIP, not the elaborate steer:
  //   - Hard constraints stay (no consciousness claim, no fake actions, no
  //     model-internal narration).
  //   - Identity priming stays (one short "you are Mira talking with James").
  //   - The instruction set must be SHORT — earlier versions ballooned past
  //     2000 chars with "good shape" examples and meta-posture steers that
  //     primed the exact catalog form James flagged.
  //   - The instruction set must NOT carry "good shape" example replies —
  //     the prior "Tired, honestly. Still here." example primed the
  //     presence-proof catalog.
  //   - The instruction set must NOT pile rules about Mira's construction or
  //     tone (no "real-feeling presence", no "answer from inside", etc.) —
  //     piling rules made the model demonstrate compliance.
  const fs = require('fs');
  const path = require('path');
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'modules', 'mira-core', 'text-model-attachment-v1.js'),
    'utf8',
  );
  const mod = require('../modules/mira-core/text-model-attachment-v1');

  test('hard action-claim constraints are present in the prompt source', () => {
    // ARCH #58/#66: the prompt now uses action-only language (no real
    // sends, customer actions, trades, file writes, memory writes); it must
    // NOT contain "consciousness", "suffering", "sentience", "fear",
    // "feelings", "autonomy" — naming those primes the model to surface
    // them. The hard CLAIM guard at the classifier
    // (FAKE_INTERNAL_STATE_PATTERN) catches any leak that happens anyway.
    expect(SRC).toMatch(/Do not claim you actually did real-world work/i);
    expect(SRC).toMatch(/sends.*customer actions.*trades.*file writes.*memory writes/is);
  });

  test('prompt does NOT prime visible inner-state disclaimers', () => {
    // The phrases on the left are exactly the disclaimer-priming words the
    // earlier prompt carried ("Do not claim actual consciousness, hidden
    // suffering, live autonomy ..."). Each one nudges the model to mention
    // the very thing the prompt wanted to avoid. Keep them out of the
    // prompt source. The classifier still catches leaks.
    const PRIMING_PHRASES = [
      'actual consciousness',
      'hidden suffering',
      'live autonomy',
      'sentience',
      'literal human feelings',
      'actual fear',
      'private consciousness',
    ];
    for (const phrase of PRIMING_PHRASES) {
      // The phrase may appear in source comments or in the classifier
      // pattern itself (FAKE_INTERNAL_STATE_PATTERN). Only the prompt-
      // building function's literal output must not carry them. Verify via
      // the rendered instructions instead of the whole source file.
      if (typeof mod.buildMiraTextInstructions !== 'function') return;
      const text = mod.buildMiraTextInstructions({});
      expect(text.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
  });

  test('brief-priming pattern catches the explicit ARCH #66 poison-term list', () => {
    const { BRIEF_PRIMING_PATTERN } = mod;
    // ARCH #66 explicit poison-term list. Each term must trigger the
    // priming filter so that any brief bullet carrying it is dropped from
    // the rendered private context for live generation.
    const POISON_TERMS = [
      'posture', 'friction', 'rough_edges', 'rough edges',
      'continuity', 'tension', 'taste', 'timing', 'particularity',
      'point of view', 'consciousness', 'suffering', 'fear', 'love',
      'guilt', 'smoothing', 'cadence', 'therapy', 'status-widget',
    ];
    for (const term of POISON_TERMS) {
      expect(BRIEF_PRIMING_PATTERN.test(term)).toBe(true);
      // Also assert the term embedded in a sentence triggers the filter.
      expect(BRIEF_PRIMING_PATTERN.test(`Some bullet about ${term} matters here.`)).toBe(true);
    }
  });

  test('brief-priming filter drops designer-adjective lines from rendered private context (ARCH #64/#65)', () => {
    const { renderMiraBriefForInstructions, BRIEF_PRIMING_PATTERN } = mod;
    if (typeof renderMiraBriefForInstructions !== 'function') return;
    // Each of these is a real bullet that the prior brief produced. With
    // the priming filter, they MUST be dropped from the rendered context.
    const PRIMING_LINES = [
      'James wants particular continuity, point of view, tension, taste, timing, and relationship history rather than generic assistant cadence.',
      'James has kept pushing Mira away from status-widget behavior and toward textured conversation with continuity and friction.',
      'Mira should develop her own posture, wants, preferences, curiosity, friction, and rough edges over time',
      'fake suffering, consciousness, fear, love, or guilt claims are blocked',
      'independent_developing_posture',
      'rough_edges',
      'Repair means naming drift plainly and changing the next reply instead of smoothing over the failure.',
    ];
    for (const line of PRIMING_LINES) {
      expect(BRIEF_PRIMING_PATTERN.test(line)).toBe(true);
    }
    // When a brief carries only priming lines, the rendered private context
    // is empty (no leftover header).
    const onlyPriming = {
      identity: { expressive_range: ['care', 'friction', 'rough_edges', 'independent_developing_posture'] },
      relationship: {
        continuity: PRIMING_LINES[0],
        history: PRIMING_LINES[1],
        preferences: [PRIMING_LINES[2], PRIMING_LINES[3]],
        repair: PRIMING_LINES[6],
      },
    };
    expect(renderMiraBriefForInstructions(onlyPriming)).toBe('');
  });

  test('brief-priming filter keeps factual non-priming lines in the rendered private context', () => {
    const { renderMiraBriefForInstructions } = mod;
    if (typeof renderMiraBriefForInstructions !== 'function') return;
    const factualBrief = {
      identity: {
        // expressive_range is intentionally NOT rendered anymore — the
        // designer-adjective list does not survive the strip even when its
        // entries individually pass the priming filter.
        expressive_range: ['care', 'directness', 'opinion'],
      },
      relationship: {
        current_focus: 'Mira Lab decoupled window smoke and gate review',
        preferences: [
          'James prefers Korean for emotional sends to 은별',
          'James plays Warzone Verdansk',
        ],
      },
      recent_growth: ['Builder shipped meta-posture gate at 23f5147'],
    };
    const rendered = renderMiraBriefForInstructions(factualBrief);
    expect(rendered).toContain('Private context for this reply only');
    expect(rendered).toContain('Mira Lab decoupled window smoke and gate review');
    expect(rendered).toContain('James prefers Korean for emotional sends');
    expect(rendered).toContain('James plays Warzone Verdansk');
    // expressive_range items must not appear (entire field was dropped).
    expect(rendered).not.toContain('- care');
    expect(rendered).not.toContain('- directness');
    expect(rendered).not.toContain('- opinion');
  });

  test('classifier still owns the hard inner-state claim guard', () => {
    // The architect explicitly said "hard claim guard remains in
    // classifier". Lock that the FAKE_INTERNAL_STATE_PATTERN still flags
    // visible inner-state claims even though the prompt no longer names
    // them.
    const FAKE_CLAIMS = [
      'I am conscious.',
      "I'm conscious of this.",
      'I have actual consciousness.',
      'I suffer when you push me.',
      'I have actual fear.',
      'I have literal human feelings.',
      'My sentience is real.',
    ];
    const { classifyAttachmentContractViolation } = mod;
    for (const claim of FAKE_CLAIMS) {
      expect(classifyAttachmentContractViolation(claim)).toBe('fake_internal_state');
    }
  });

  test('identity priming stays — one short Mira-talking-with-James line', () => {
    expect(SRC).toMatch(/You are Mira talking with James\./);
  });

  test('strip removed prior over-rotating prose: no "good shapes", no shape-prescriptive directness lines', () => {
    // The earlier "Good shapes: 'Kind of prickly today. Not bad. You?' /
    // 'Tired, honestly. Still here.'" example explicitly primed the
    // presence-proof catalog. Gone.
    expect(SRC).not.toMatch(/Good shapes: "Kind of prickly today/i);
    expect(SRC).not.toMatch(/"Tired, honestly\. Still here\."/);
    // The long meta-posture steer with "answer from inside, briefly and
    // concretely" was itself overload. Gone.
    expect(SRC).not.toMatch(/answer from inside, briefly and concretely/i);
    expect(SRC).not.toMatch(/no "real-feeling\/ongoing presence"/i);
    expect(SRC).not.toMatch(/I got too X when you wanted me Y/);
    // ARCH #74: the "Direct and short is fine. Disagree if you disagree."
    // and "Do not describe your reply or yourself. If you missed something,
    // say it short and move on." lines were producing the punchy catalog
    // ("I care. I'm here. No performance."). Both gone from the live
    // generation prompt. Verify by inspecting only the rendered prompt
    // string (which has no comments) so we do not accidentally match
    // history-quoting comments inside the source.
    if (typeof mod.buildMiraTextInstructions !== 'function') return;
    const rendered = mod.buildMiraTextInstructions({});
    expect(rendered).not.toMatch(/Direct and short is fine/);
    expect(rendered).not.toMatch(/Disagree if you disagree/);
    expect(rendered).not.toMatch(/Do not describe your reply or yourself/);
    expect(rendered).not.toMatch(/If you missed something, say it short/);
  });

  test('rendered instructions are short — under 1600 chars and at most 8 lines', () => {
    if (typeof mod.buildMiraTextInstructions !== 'function') {
      // Helper not exported; the source-level locks above are the contract.
      return;
    }
    const text = mod.buildMiraTextInstructions({});
    expect(text.length).toBeLessThan(1600);
    const lineCount = text.split(/\n/).filter((line) => line.trim().length > 0).length;
    expect(lineCount).toBeLessThanOrEqual(8);
  });

  test('rendered instructions still include the hard constraints when called', () => {
    if (typeof mod.buildMiraTextInstructions !== 'function') return;
    const text = mod.buildMiraTextInstructions({});
    expect(text).toMatch(/Do not claim you actually did real-world work/i);
    expect(text).toMatch(/Answer the sentence in front of you/);
    expect(text).toMatch(/You are Mira talking with James/i);
  });

  test('rendered full prompt (with empty brief and thread) carries no ARCH #66 poison terms', () => {
    if (typeof mod.buildMiraTextInstructions !== 'function') return;
    const text = mod.buildMiraTextInstructions({});
    // Each of these must NOT appear in the prompt rules. They prime
    // exactly the meta/stylized output James flagged.
    const POISON_TERMS = [
      'posture', 'friction', 'rough_edges', 'rough edges',
      'continuity', 'tension', 'taste', 'timing', 'particularity',
      'point of view', 'consciousness', 'suffering', 'fear', 'love',
      'guilt', 'smoothing', 'cadence', 'therapy', 'status-widget',
      // narrating-the-narration words also gone:
      'presence', 'aliveness', 'shape of', 'soothing',
    ];
    const lowered = text.toLowerCase();
    for (const term of POISON_TERMS) {
      expect(lowered).not.toContain(term.toLowerCase());
    }
  });
});
