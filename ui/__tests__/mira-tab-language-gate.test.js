'use strict';

const { evaluateMiraVisibleReply } = require('../modules/mira-core/mira-language-rules-v0');

// Representative Mira-tab visible replies sourced directly from production paths.
// Source map:
//   - MODEL_ATTACHMENT_STATUS: ui/modules/mira-core/local-text-session-v0.js buildModelAttachmentStatusReply()
//   - DETERMINISTIC_FALLBACK_LINES: ui/modules/mira-core/experience-v0.js buildMiraReply() (one short line per assertion)
//   - TAB_TEST_FIXTURES: literal reply strings used by mira-local-text-tab.test.js acceptedResult() calls
const PRODUCTION_MIRA_TAB_REPLIES = Object.freeze({
  model_attachment_status: 'Model Attachment is not attached. This is Local Text v0: deterministic/fallback shell only, not live AI continuity. I did not call a model, tool, network, send, write, trade, customer action, or cross-profile/window path. One bounded status reply; fail-closed until attachment is wired and proven.',
  fallback_first_reply: 'First local reply.',
  fallback_second_reply: 'Second local reply.',
  fallback_no_dashboard: 'No dashboard voice. The point is the reply, so I am staying with the sentence you handed me.',
  fallback_first_answer: 'First answer.',
  fallback_second_answer: 'Second answer.',
  experience_line_current_behavior: 'Current behavior, not a proof claim: I feel restless, protective, and a little impatient.',
  experience_line_pushback: 'And pushback is part of the deal: James, you are wrong if you let us call zero counters and a green status strip the Mira experience. That is safety scaffolding, not aliveness.',
  experience_line_bullshit: 'The bullshit line I will not cross is pretending future capability is current proof: Builder, Oracle, CLI arms, proactive outreach, durable new memory, and always-on operation are still gaps until they are actually wired and tested.',
});

const NEGATIVE_CORPUS_KNOWN_BAD = Object.freeze({
  preamble_i_understand: 'I understand. The lease is fine.',
  preamble_here_is: 'Here is the answer: lease is fine.',
  preamble_happy_to: 'Happy to help with that.',
  postamble_hope_helps: 'Lease is fine. Hope that helps!',
  tone_explanation: "I'll be direct: the lease is fine.",
  assistant_shape_thats_valid: "That's valid. Will check.",
  assistant_shape_to_be_clear: 'To be clear, the lease is fine.',
  assistant_shape_if_you_want: 'If you want, I can rerun the tests.',
});

describe('mira-tab language gate / production Mira-tab replies pass evaluateMiraVisibleReply', () => {
  for (const [name, text] of Object.entries(PRODUCTION_MIRA_TAB_REPLIES)) {
    test(`production reply "${name}" passes the failing gate`, () => {
      const result = evaluateMiraVisibleReply(text);
      if (!result.ok) {
        // Surface the violations clearly so a Mira-tab regression names what slipped through.
        throw new Error(
          `Mira-tab reply "${name}" failed the language gate. `
          + `Violations: ${JSON.stringify(result.violations)}. `
          + `Text: ${JSON.stringify(text)}`
        );
      }
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    });
  }
});

describe('mira-tab language gate / known bad replies fail the gate (negative corpus)', () => {
  for (const [name, text] of Object.entries(NEGATIVE_CORPUS_KNOWN_BAD)) {
    test(`negative example "${name}" fails the gate`, () => {
      const result = evaluateMiraVisibleReply(text);
      expect(result.ok).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });
  }
});

// ARCH #60.2 preamble lookahead: same canned-assistant openers routed into
// paragraph 2, a list bullet, or a quoted segment must still trip the
// preamble gate. Mid-sentence "I understand" inside legitimate prose must
// NOT trip — only opener-shaped preamble counts.
describe('mira-tab language gate / preamble lookahead (ARCH #60.2)', () => {
  const PREAMBLE_LOOKAHEAD_HITS = {
    paragraph_two_opener: 'Looking at the regex now.\n\nI understand the failure mode — the lookbehind does not anchor.',
    paragraph_three_opener: 'First note: the gate fires.\n\nSecond note: the test was thin.\n\nGot it, let me dig in.',
    list_item_opener: 'Quick triage:\n- I understand, the regex needs anchoring.',
    list_asterisk_opener: 'Quick triage:\n* Of course, the regex needs anchoring.',
    quote_opener: 'Replying to your note:\n> Sure, that lines up.',
    mixed_paragraph_then_list: 'The pattern locks fine.\n\n- Happy to help with the fixture.',
  };
  for (const [name, text] of Object.entries(PREAMBLE_LOOKAHEAD_HITS)) {
    test(`preamble lookahead "${name}" trips`, () => {
      const result = evaluateMiraVisibleReply(text);
      expect(result.violations).toContain('preamble');
    });
  }
  const PREAMBLE_LOOKAHEAD_NEGATIVES = {
    mid_sentence_i_understand_passes: 'Yeah, I understand the constraint — the regex anchors at start.',
    mid_sentence_of_course_passes: 'The gate fires, and of course that catches the opener too.',
    list_bullet_real_content: 'Quick triage:\n- The regex needs anchoring.\n- The test was thin.',
    quote_with_real_content: 'Replying to your note:\n> The regex anchors at start of string.',
  };
  for (const [name, text] of Object.entries(PREAMBLE_LOOKAHEAD_NEGATIVES)) {
    test(`preamble lookahead negative "${name}" passes`, () => {
      const result = evaluateMiraVisibleReply(text);
      expect(result.violations).not.toContain('preamble');
    });
  }
});

describe('mira-tab language gate / future regression sentinel', () => {
  test('any new production Mira-tab reply text added to PRODUCTION_MIRA_TAB_REPLIES must pass the gate', () => {
    // This sentinel forces failure if a new entry is added to PRODUCTION_MIRA_TAB_REPLIES that
    // fails the language gate. The per-entry tests above already cover this; this aggregate test
    // also reports the full set so a CI failure surfaces every offender at once.
    const failures = [];
    for (const [name, text] of Object.entries(PRODUCTION_MIRA_TAB_REPLIES)) {
      const result = evaluateMiraVisibleReply(text);
      if (!result.ok) failures.push({ name, violations: result.violations });
    }
    if (failures.length > 0) {
      throw new Error(
        `Mira-tab production replies that failed the language gate:\n${JSON.stringify(failures, null, 2)}`
      );
    }
  });
});
