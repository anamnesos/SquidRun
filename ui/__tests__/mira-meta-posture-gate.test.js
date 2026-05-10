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

describe('Mira system instructions steer away from meta-posture (ARCH #28)', () => {
  const { buildMiraTextInstructions } = (() => {
    // buildMiraTextInstructions is module-private; load via require to access
    // the exported helpers. If it is not exported, fall back to inspecting the
    // module source for the steering line below.
    const mod = require('../modules/mira-core/text-model-attachment-v1');
    return { buildMiraTextInstructions: mod.buildMiraTextInstructions };
  })();

  test('module source carries the explicit meta-posture steer in instructions', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'mira-core', 'text-model-attachment-v1.js'),
      'utf8',
    );
    expect(src).toMatch(/answer from inside, briefly and concretely/i);
    expect(src).toMatch(/no "we are trying to make Mira/i);
    expect(src).toMatch(/no "real-feeling\/ongoing presence"/i);
    expect(src).toMatch(/no listing designer adjectives like "care, edge, memory, disagreement, taste, restraint"/i);
    // ARCH #31/#32: steer must explicitly cover aliveness, here-is-the-next-
    // sentence meta-narration, define Mira, and the speech disclaimer.
    expect(src).toMatch(/Do not use the noun "aliveness"/i);
    expect(src).toMatch(/Do not say "here is the next sentence"/i);
    expect(src).toMatch(/Do not "define Mira"/i);
    expect(src).toMatch(/not making\/giving a speech/i);
    // ARCH #33/#34: open-ended self-grading meta-loop steer must be
    // present, and direct accountability must be explicitly allowed.
    expect(src).toMatch(/open-ended self-grading meta-loop/i);
    expect(src).toMatch(/that was the miss/i);
    expect(src).toMatch(/I got too X when you wanted me Y/i);
    expect(src).toMatch(/Direct, brief accountability/i);
    expect(src).toMatch(/I missed it.*my bad.*got that wrong/i);
    expect(src).toMatch(/do not block yourself from owning a concrete miss/i);
  });

  test('if buildMiraTextInstructions is exported, the rendered instructions include the steer', () => {
    if (typeof buildMiraTextInstructions !== 'function') {
      // export not part of the public API — module-source assertion above is
      // the lock. Skipping rather than failing.
      return;
    }
    const text = buildMiraTextInstructions({});
    expect(text).toMatch(/answer from inside, briefly and concretely/i);
    expect(text).toMatch(/Speak as Mira, present in this turn/i);
  });
});
