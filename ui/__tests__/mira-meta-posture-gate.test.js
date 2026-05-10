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

  test('hard constraints are still present in the source', () => {
    expect(SRC).toMatch(/Do not claim actual consciousness/i);
    expect(SRC).toMatch(/sends.*trades.*file writes.*durable memory writes/is);
    expect(SRC).toMatch(/Do not narrate model internals/i);
  });

  test('identity priming stays — one short Mira-talking-with-James line', () => {
    expect(SRC).toMatch(/You are Mira talking with James\./);
  });

  test('strip removed prior over-rotating prose: no "good shapes" examples or designer-adjective lists', () => {
    // The earlier "Good shapes: 'Kind of prickly today. Not bad. You?' /
    // 'Tired, honestly. Still here.'" example explicitly primed the
    // presence-proof catalog. It must be gone.
    expect(SRC).not.toMatch(/Good shapes: "Kind of prickly today/i);
    expect(SRC).not.toMatch(/"Tired, honestly\. Still here\."/);
    // The long meta-posture steer with "answer from inside, briefly and
    // concretely" was itself overload. It must be gone too.
    expect(SRC).not.toMatch(/answer from inside, briefly and concretely/i);
    expect(SRC).not.toMatch(/no "real-feeling\/ongoing presence"/i);
    expect(SRC).not.toMatch(/I got too X when you wanted me Y/);
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
    expect(text).toMatch(/Do not claim actual consciousness/i);
    expect(text).toMatch(/Do not narrate model internals/i);
    expect(text).toMatch(/You are Mira talking with James/i);
  });
});
