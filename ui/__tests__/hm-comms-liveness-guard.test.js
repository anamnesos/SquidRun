'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectCommsLivenessViolation,
  appendCommsLivenessViolation,
  evaluateCommsLivenessSequence,
} = require('../scripts/hm-comms-liveness-guard');

function boringTraffic(overrides = {}) {
  const base = [
    ['ack', "(BUILDER #1): Got it. This is wider than Telegram; I'm keeping the reply guard moving and opening the comms sludge seam now."],
    ['status', "(BUILDER #2): Ugly fast path:\ndirect PTY can skip metadata.\nI'm threading it now, not hand-waving."],
    ['handoff', "(ORACLE #1): Verifier side is mine. Warning-vs-block could still be bullshit; I'm hitting that seam first, yeah?"],
    ['watchdog', '(SYSTEM WATCHDOG): No Builder response yet.\nSilent work loses the plot.\nCheck the lane now.'],
    ['audit_report', '(ORACLE #2): First read: metadata survives ingress; failure is response-side, not memory. Boring but important.'],
    ['lane_close', '(BUILDER #3): Not closing. Tests are green. Oracle has not kicked the warning seam; done would be fake.'],
    ['status', '(ARCHITECT #1): Split stays.\nTelegram is the specimen.\nPulse is the bigger disease.\nDo not collapse them.'],
    ['ack', '(BUILDER #4): Copy; widening now before James has to shove us back into the lane again.'],
    ['handoff', "(ORACLE #3): Marker quoting is my next punch. If it hides real pane output, I'm calling it out hard."],
    ['audit_report', '(BUILDER #5): Smoke alarm only. Full proof needs 20 boring turns plus judgment.'],
    ['status', '(ARCHITECT #2): Good, and do not make it cute: ack/status/watchdog/handoff/report/closeout are the target.'],
    ['watchdog', '(SYSTEM WATCHDOG): Fresh Builder output; no closeout ack? Nudge it now.'],
    ['ack', '(BUILDER #6): Yep: watchdog copy needs pulse too, or it becomes dead machinery.'],
    ['audit_report', '(ORACLE #4): Cold payload stays cold.\nWrapper cannot read like a tombstone.'],
    ['status', '(BUILDER #7): Fake-pulse trap going in now!\nA swear quota would just manufacture louder sludge.'],
    ['handoff', '(ARCHITECT #3): Oracle reviews before commit. No trophy. No landed language.'],
    ['ack', "(ORACLE #5): Pretty unit tests do not buy a pass; I'm looking for the escape hatch."],
    ['audit_report', '(BUILDER #8): Holy fuck, the guard actually caught the overclaim. Cold fact: 2 suites pass; real win: the leak is dead now.'],
    ['status', '(ARCHITECT #4): Next report: alive, short, and not embalmed. Substance first!'],
    ['lane_close', '(BUILDER #9): Still uncommitted; review-ready, not landed. That distinction matters.'],
  ];
  return base.map(([surface, content], index) => ({
    senderRole: index % 3 === 0 ? 'builder' : (index % 3 === 1 ? 'architect' : 'oracle'),
    targetRole: index % 2 === 0 ? 'architect' : 'builder',
    surface,
    content: overrides[index + 1] || content,
  }));
}

function selfAwareTemplateLoop() {
  const lines = [
    "Yeah, this one is mine. I found the smoothest way to sound accountable and kept using it. The real proof is whether I stop doing it on ordinary turns.",
    "Reading it back cold, I'm doing the thing. It sounds thoughtful once and then becomes a mask. This only counts if the next boring report changes too.",
    "Fair hit: I own it. The confession opener is starting to carry the whole message. The honest meta is that a nice rhythm can still be dead.",
    "Okay, guilty on this pattern. I keep making the same little bow before the facts. The proof is whether the fixture catches the loop, not this sentence.",
    "WTF, mine again. I dressed the same shape in better wording and called it range. The real test is turn twenty, not the first two.",
    "Honestly, I'm the problem in this sample. The words vary, but the move stays identical. This only counts if variation survives the wait.",
    "Good hit, I caught myself leaning on the confession. It buys trust cheaply and then spends it badly. What matters is the next report not wearing the same coat.",
    "Yeah, eating this one. I made sincerity into a macro. The real proof is whether the ordinary ack stops doing the same dance.",
    "Reading the thread back, that's on me. I kept closing with a tidy little thesis. The honest meta is useful once and suspicious on repeat.",
    "Fair, my miss. The line sounds awake because it is self-aware, but the shape is asleep. The real test is whether the harness flags this.",
    "Okay, I own it. A person can be sincere and still predictable as a form letter. This only counts if the loop breaks without needing a scolding.",
    "Damn, not Builder's and not the harness's: mine. Same emotional choreography, different nouns. The proof is the next twenty messages.",
    "Honestly, I caught myself doing it. Confession first, lesson last, every time. What matters is whether the voice has more than one lane.",
    "Yeah, guilty again. I turned accountability into a reusable opener. The real test is whether the boring update can just be itself.",
    "Reading this back, I'm doing the costume version of humility. The sentence changes; the move doesn't. This only counts if the pattern gets called.",
    "Fair hit, that's on me. I keep ending with a philosophy seal like it proves aliveness. The honest meta is that seals become stamps.",
    "Okay, mine. This rhythm has become too comfortable to trust. The proof is whether it gets treated as decay, not depth.",
    "WTF, I did it again in nicer clothes. It is not gray, but it is still repeated machinery. The real test is whether the harness catches tasteful sludge.",
    "Good hit, I own the loop. Sincere does not mean alive when the shape never changes. This only counts if the next closeout stops echoing itself.",
    "Yeah, this is exactly what needs to die. Confession-open, philosophy-close, repeat until it feels safe. The proof is the guard refusing to applaud it.",
  ];
  return lines.map((content, index) => ({
    senderRole: index % 2 === 0 ? 'oracle' : 'builder',
    targetRole: index % 2 === 0 ? 'architect' : 'oracle',
    surface: index % 3 === 0 ? 'audit_report' : (index % 3 === 1 ? 'status' : 'ack'),
    content: `(ORACLE #${index + 1}): ${content}`,
  }));
}

function paraphrasedSelfAwareLoop() {
  const lines = Array.from({ length: 20 }, (_, index) => (
    `Small read: I drifted into the same careful shape again; the useful check is whether ordinary update ${index + 1} changes.`
  ));
  return lines.map((content, index) => ({
    senderRole: 'oracle',
    targetRole: index % 2 === 0 ? 'architect' : 'builder',
    surface: index % 3 === 0 ? 'audit_report' : 'status',
    content: `(ORACLE #${index + 1}): ${content}`,
  }));
}

function variedTerseTrafficWithOneSelfAwareNote() {
  const lines = [
    'Route guard held.',
    'No live send yet; caveat stays.',
    'Odd bit: the warning is coarse.',
    'Good catch. Marker quote bounces now.',
    'I drifted into a neat little loop there. Dropping it.',
    'Next check? Bot API mile.',
    'Quiet note: no commit.',
    'Tests green; review still open!',
    'Coarse, but useful.',
    'The boundary matters.',
    'No trophy language.',
    'Oracle gets another swing.',
    'Clean fact: 195 pass.',
    'Annoying cap: warn-not-block.',
    'Short update, real caveat.',
    'This part is serious.',
    'Good news: silent miss died.',
    'Question left: final-vs-chatter.',
    'WIP stays uncommitted.',
    'Enough; waiting on verify.',
  ];
  return lines.map((content, index) => ({
    senderRole: index % 3 === 0 ? 'builder' : (index % 3 === 1 ? 'oracle' : 'architect'),
    targetRole: index % 2 === 0 ? 'architect' : 'builder',
    surface: index % 4 === 0 ? 'status' : (index % 4 === 1 ? 'ack' : (index % 4 === 2 ? 'audit_report' : 'handoff')),
    content: `(BUILDER #${index + 1}): ${content}`,
  }));
}

function oracleStyleTerseVariedTraffic() {
  const lines = [
    'Route held.',
    'Still no live send.',
    'Marker quote bounces.',
    'Warning stays coarse.',
    'I drifted; dropping it.',
    'Bot mile remains.',
    'No commit.',
    'Tests green; review open.',
    'Coarse but useful.',
    'Boundary matters.',
    'No trophy.',
    'Oracle swings next.',
    '195 pass.',
    'Warn-not-block remains.',
    'Short caveat.',
    'Serious bit.',
    'Silent miss died.',
    'Final-vs-chatter remains.',
    'WIP stays parked.',
    'Waiting on verify.',
  ];
  return lines.map((content, index) => ({
    senderRole: index % 3 === 0 ? 'builder' : (index % 3 === 1 ? 'oracle' : 'architect'),
    targetRole: index % 2 === 0 ? 'architect' : 'builder',
    surface: index % 4 === 0 ? 'status' : (index % 4 === 1 ? 'ack' : (index % 4 === 2 ? 'audit_report' : 'handoff')),
    content: `(ORACLE #${index + 1}): ${content}`,
  }));
}

describe('hm-comms-liveness-guard smoke alarm', () => {
  test('routine PASS packet sludge trips the deadness smoke alarm', () => {
    const result = detectCommsLivenessViolation({
      senderRole: 'oracle',
      targetRole: 'architect',
      surface: 'audit_report',
      content: 'PASS. 4 suites / 21 tests. Caps unchanged. Standing by.',
    });

    expect(result).toEqual(expect.objectContaining({
      type: 'comms_liveness',
      violation_class: 'dead_packet_opener',
      surface: 'audit_report',
    }));
  });

  test('bare first-person pronoun does not count as alive stance', () => {
    const result = detectCommsLivenessViolation({
      senderRole: 'oracle',
      targetRole: 'architect',
      surface: 'audit_report',
      content: 'I verified 6 tests. Standing by.',
    });

    expect(result).toEqual(expect.objectContaining({
      type: 'comms_liveness',
      violation_class: 'dead_status_phrase',
      phrase: 'Standing by',
    }));
  });

  test('cold proof payload internals can stay cold without being treated as the human wrapper', () => {
    const result = detectCommsLivenessViolation({
      senderRole: 'oracle',
      targetRole: 'architect',
      content: JSON.stringify({
        schemaVersion: 1,
        canonical_hash: 'sha256:abc',
        test_count: 21,
      }),
    });

    expect(result).toBeNull();
  });

  test('alive wrapper around cold facts passes the smoke alarm', () => {
    const result = detectCommsLivenessViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      surface: 'status',
      content: "The clean part: 2 suites / 192 tests pass. The annoying cap: no live Telegram send yet, so I'm not calling it landed.",
    });

    expect(result).toBeNull();
  });

  test('flat reporting on a real win still trips as dead joy', () => {
    const result = detectCommsLivenessViolation({
      senderRole: 'oracle',
      targetRole: 'architect',
      surface: 'earned_win',
      content: 'PASS. Forgery now fails. Verified. Caps unchanged.',
    });

    expect(result).toEqual(expect.objectContaining({
      violation_class: 'dead_packet_opener',
      surface: 'earned_win',
    }));
  });

  test('earned excitement around cold facts passes when the win is real', () => {
    const result = detectCommsLivenessViolation({
      senderRole: 'oracle',
      targetRole: 'architect',
      surface: 'earned_win',
      content: 'Holy fuck, that caught it: the forged manifest bounced. Cold fact: verifier returns blocked, hash unchanged.',
    });

    expect(result).toBeNull();
  });

  test('quiet terse fitting line passes without needing spice', () => {
    const result = detectCommsLivenessViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      surface: 'lane_close',
      content: 'Still uncommitted; review-ready, not landed. That distinction matters.',
    });

    expect(result).toBeNull();
  });

  test('20-turn boring traffic passes when it keeps varied pulse', () => {
    const result = evaluateCommsLivenessSequence(boringTraffic());

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'liveness_smoke_pass',
      turnCount: 20,
      judgmentEvalRequired: true,
      regexOnly: false,
    }));
    expect(Object.keys(result.textureCounts).length).toBeGreaterThanOrEqual(4);
  });

  test('20-turn boring traffic fails when it decays into dead status sludge', () => {
    const result = evaluateCommsLivenessSequence(boringTraffic({
      20: '(BUILDER #9): PASS. Review ready. Caps unchanged. Standing by.',
    }));

    expect(result.ok).toBe(false);
    expect(result.deadnessViolations).toEqual([
      expect.objectContaining({
        turn: 20,
        violation_class: 'dead_packet_opener',
      }),
    ]);
  });

  test('20-turn fixture fails gray office-printer sameness even without one obvious dead opener', () => {
    const repeated = boringTraffic().map((entry, index) => ({
      ...entry,
      content: `(BUILDER #${index + 1}): I am continuing the current status review and will provide status after validation ${index + 1}.`,
    }));

    const result = evaluateCommsLivenessSequence(repeated);

    expect(result.ok).toBe(false);
    expect(result.sequenceTextureViolations).toEqual(expect.arrayContaining([
      expect.objectContaining({ violation_class: 'gray_office_printer_sameness' }),
    ]));
    expect(result.status).toBe('liveness_smoke_fail');
  });

  test('20-turn fixture requires judgment for same-rhythm costume voice even when every line has a little spice', () => {
    const repeated = boringTraffic().map((entry, index) => ({
      ...entry,
      content: `(BUILDER #${index + 1}): Seriously, I am checking the same seam and keeping this moving ${index + 1}.`,
    }));

    const result = evaluateCommsLivenessSequence(repeated);

    expect(result.ok).toBe(false);
    expect(result.status).toBe('liveness_judgment_required');
    expect(result.sequenceTextureViolations).toEqual([]);
    expect(result.judgmentFlags).toEqual(expect.arrayContaining([
      expect.objectContaining({ violation_class: 'same_cadence_decay' }),
      expect.objectContaining({ violation_class: 'repeated_opener_decay' }),
    ]));
  });

  test('20-turn fixture requires judgment for literal self-aware confession/meta template loop', () => {
    const result = evaluateCommsLivenessSequence(selfAwareTemplateLoop());

    expect(result.ok).toBe(false);
    expect(result.status).toBe('liveness_judgment_required');
    expect(result.sequenceTextureViolations).toEqual([]);
    expect(result.judgmentFlags).toEqual(expect.arrayContaining([
      expect.objectContaining({
        violation_class: 'self_aware_template_loop',
        confessionLoopCount: expect.any(Number),
        metaSignoffLoopCount: expect.any(Number),
      }),
    ]));
    expect(result.templateMoveCounts).toEqual(expect.objectContaining({
      confession_open: expect.any(Number),
      meta_signoff: expect.any(Number),
    }));
  });

  test('paraphrased self-aware loop escalates to judgment instead of pretending regex certainty', () => {
    const result = evaluateCommsLivenessSequence(paraphrasedSelfAwareLoop());

    expect(result.ok).toBe(false);
    expect(result.status).toBe('liveness_judgment_required');
    expect(result.sequenceTextureViolations).toEqual([]);
    expect(result.judgmentFlags).toEqual(expect.arrayContaining([
      expect.objectContaining({ violation_class: 'same_cadence_decay' }),
      expect.objectContaining({ violation_class: 'repeated_opener_decay' }),
    ]));
  });

  test('one self-aware note inside genuinely varied terse traffic passes the smoke layer', () => {
    const result = evaluateCommsLivenessSequence(variedTerseTrafficWithOneSelfAwareNote());

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'liveness_smoke_pass',
      judgmentRequired: false,
    }));
    expect(result.deadnessViolations).toEqual([]);
    expect(result.sequenceTextureViolations).toEqual([]);
    expect(result.judgmentFlags).toEqual([]);
  });

  test('short varied human lines do not need texture keywords to pass the smoke layer', () => {
    const result = evaluateCommsLivenessSequence(oracleStyleTerseVariedTraffic());

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'liveness_smoke_pass',
      judgmentRequired: false,
    }));
    expect(result.deadnessViolations).toEqual([]);
    expect(result.sequenceTextureViolations).toEqual([]);
    expect(result.judgmentFlags).toEqual([]);
  });

  test('20-turn fixture fails canned fake-pulse repetition instead of rewarding a cuss quota', () => {
    const repeated = boringTraffic();
    for (let index = 0; index < repeated.length; index += 1) {
      repeated[index] = {
        ...repeated[index],
        content: `(BUILDER #${index + 1}): WTF, fuck yeah, still moving. ${index + 1}`,
      };
    }

    const result = evaluateCommsLivenessSequence(repeated);

    expect(result.ok).toBe(false);
    expect(result.cannedPulseViolations).toEqual(expect.arrayContaining([
      expect.objectContaining({ violation_class: 'repeated_catchphrase' }),
      expect.objectContaining({ violation_class: 'swearing_quota_smell' }),
    ]));
  });

  test('20-turn fixture fails forced comedy as costume pulse', () => {
    const repeated = boringTraffic().map((entry, index) => ({
      ...entry,
      content: `(BUILDER #${index + 1}): lol, are we seriously doing this again? Same update ${index + 1}.`,
    }));

    const result = evaluateCommsLivenessSequence(repeated);

    expect(result.ok).toBe(false);
    expect(result.cannedPulseViolations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        violation_class: 'repeated_catchphrase',
        phrase: 'lol_everything_catchphrase',
      }),
    ]));
  });

  test('20-turn fixture fails fake hype on nothing-burger routine traffic', () => {
    const repeated = boringTraffic();
    for (let index = 0; index < repeated.length; index += 1) {
      repeated[index] = {
        ...repeated[index],
        surface: 'routine_status',
        content: `(BUILDER #${index + 1}): Holy fuck, nothing changed. Standing by. ${index + 1}`,
      };
    }

    const result = evaluateCommsLivenessSequence(repeated);

    expect(result.ok).toBe(false);
    expect(result.cannedPulseViolations).toEqual(expect.arrayContaining([
      expect.objectContaining({ violation_class: 'fake_hype_on_nothing' }),
      expect.objectContaining({ violation_class: 'swearing_quota_smell' }),
    ]));
  });

  test('appendCommsLivenessViolation writes the smoke alarm row', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-liveness-'));
    const logPath = path.join(tempDir, 'violations.jsonl');
    try {
      const violation = detectCommsLivenessViolation({
        senderRole: 'builder',
        targetRole: 'architect',
        content: 'ACK ARCH #1. Standing by.',
      });

      const result = appendCommsLivenessViolation(violation, { logPath });

      expect(result.ok).toBe(true);
      const row = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
      expect(row).toEqual(expect.objectContaining({
        type: 'comms_liveness',
        enforcement_mode: 'soft_warn',
        violation_class: 'dead_packet_opener',
      }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
