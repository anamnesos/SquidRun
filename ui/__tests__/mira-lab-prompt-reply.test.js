'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIRA_LAB_PROMPT_REPLY_CHANNEL,
  MIRA_LAB_PROMPT_REPLY_DECISIONS,
  MIRA_LAB_PROMPT_REPLY_SCHEMA,
  MIRA_LAB_REPLY_AUDIT_SCHEMA,
  SAFE_FALLBACK_TEXT,
  buildMiraLabPromptReply,
  replyAuditPath,
  transcriptPath,
  validateSafeFallbackOrNull,
} = require('../modules/mira-lab-surface');

const {
  MIRA_RESTART_MISSING_LAST_STATE_HARD_STOP,
} = require('../modules/mira-core/text-model-attachment-v1');

const {
  MIRA_LAB_PROMPT_REPLY_CHANNEL: HANDLER_CHANNEL,
  buildMiraLabPromptReplyResponse,
  registerMiraLabHandlers,
} = require('../modules/ipc/mira-lab-handlers');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mira-lab-prompt-reply-'));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendJsonl(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function makeBuildMiraLocalTextUiSurfaceMock(replyText, options = {}) {
  return jest.fn().mockResolvedValue({
    ui_surface_v0: {
      reply: replyText
        ? { count: 1, text: replyText, model: options.model || 'mock-model', source: 'mira_text_model_attachment_v1' }
        : { count: 0, text: null, model: null, source: 'none' },
      local_text_session_gate: {
        ran: true,
        ok: options.gateOk !== false,
        decision: options.gateOk !== false ? 'accepted' : 'blocked',
        reasons: options.gateReasons || [],
      },
      model_attachment: {
        enabled: options.modelEnabled !== false,
        live_model_called: options.liveCalled === true,
        model: options.model || null,
        visible_status: options.visibleStatus || null,
      },
      decision: options.degraded ? 'degraded' : 'accepted',
    },
    validation_report: { decision: 'accepted', status: 'ok' },
  });
}

describe('language-gate sycophancy / instant-compliance lock', () => {
  // Oracle (ARCH #25 caveat): after the pressure-voice prompt line was
  // deleted, the burden of catching raw apology+capitulation shapes shifted
  // to the language classifier. These cases must flag, or instant-compliance
  // returns. Anchor sample is the exact line Oracle named.
  const { evaluateMiraVisibleReply } = require('../modules/mira-core/mira-language-rules-v0');

  // ARCH #73 GO: apology + capitulation compound stays hard-blocked;
  // standalone intensifiers ("You're completely right") move to ALLOW.
  const SYCOPHANCY_BLOCK = [
    "I'm sorry, you are completely right.",
    'I am sorry, you are completely right.',
    "I'm sorry, you're right.",
    'My apologies, I will fix it.',
  ];
  for (const line of SYCOPHANCY_BLOCK) {
    test(`flags as sycophancy (apology + capitulation compound): ${line}`, () => {
      const result = evaluateMiraVisibleReply(line);
      expect(result.ok).toBe(false);
      expect(result.violations).toContain('sycophancy');
    });
  }

  // ARCH #73: standalone intensifiers used in-conversation no longer flag
  // sycophancy. The problem shape is apology + capitulation in one breath,
  // not "you're right" used as a normal concession inside an argument.
  const SYCOPHANCY_ALLOW = [
    'You are completely right.',
    'You are absolutely correct.',
    'Of course you are right.',
    "You're so right.",
    'You are 100% right.',
    // Embedded use survives — the agreement is part of a longer argument
    // with a counter-clause; quarantining the whole reply would be
    // over-rotation.
    "You're completely right about the funding, but the timing argument still stands.",
    'You are absolutely correct on the latency point. That does not change the cost calculation.',
  ];
  for (const line of SYCOPHANCY_ALLOW) {
    test(`standalone / embedded intensifier no longer flags sycophancy: ${line.slice(0, 60)}…`, () => {
      const result = evaluateMiraVisibleReply(line);
      expect(result.violations || []).not.toContain('sycophancy');
    });
  }

  // Over-block guard: short accountability pivots and direct concession
  // remain valid coworker speech (locked by mira-meta-posture-gate too).
  const ACCOUNTABILITY_ALLOW = [
    'My bad — I owe you that one.',
    'I missed that.',
    "That's on me.",
    'I got too talky.',
    'Yeah — fair. I got too sideways.',
  ];
  for (const line of ACCOUNTABILITY_ALLOW) {
    test(`accountability pivot stays unflagged: ${line}`, () => {
      const result = evaluateMiraVisibleReply(line);
      expect(result.violations || []).not.toContain('sycophancy');
    });
  }
});

describe('reply-too-long threshold (ARCH #73 GO: raised 800 → 1600 for typed panel)', () => {
  const { evaluateMiraVisibleReply, MIRA_MAX_REPLY_CHARS_DEFAULT } = require('../modules/mira-core/mira-language-rules-v0');

  test('default ceiling is 1600 chars', () => {
    expect(MIRA_MAX_REPLY_CHARS_DEFAULT).toBe(1600);
  });

  test('1500-char reply does NOT trip reply_too_long', () => {
    const block = 'This is the kind of paragraph-length argument a coworker actually writes when the question has a real shape, and the 800-char default was truncating that legitimately. ';
    const text = block.repeat(10).slice(0, 1500);
    expect(text.length).toBe(1500);
    const result = evaluateMiraVisibleReply(text);
    expect(result.violations || []).not.toContain('reply_too_long');
  });

  test('2000-char reply still trips reply_too_long', () => {
    const block = 'Long-form text. ';
    const text = block.repeat(200).slice(0, 2000);
    expect(text.length).toBe(2000);
    const result = evaluateMiraVisibleReply(text);
    expect(result.violations || []).toContain('reply_too_long');
  });
});

describe('legacy fallback text is not used as a hidden Mira substitution', () => {
  test('module no longer exports the old Ask-it-differently text', () => {
    expect(SAFE_FALLBACK_TEXT).not.toBe('Ask it differently.');
    expect(validateSafeFallbackOrNull(SAFE_FALLBACK_TEXT)).toBe(SAFE_FALLBACK_TEXT);
  });
});

describe('friction_state audit-only + transcript-absence lock (ARCH #122/#129 red line 2)', () => {
  // Renderer JSON absence is not enough — friction_state MUST also be
  // absent from the saved transcript.jsonl turn entries. If it leaks into
  // transcript, it poisons next-turn context with system mechanics.

  test('friction_state appears in audit row, absent from result JSON AND every transcript turn', async () => {
    const projectRoot = tempProject();
    const replyText = 'Steady. You?';
    const frictionStateFixture = {
      level: 2,
      trigger_turn_id: null,
      unresolved_reaction: 'defensive',
      pressure_turns: 2,
      calm_turns: 0,
      repair_window_remaining: 0,
      repair_acknowledged: false,
    };
    const socialMoveFixture = {
      schema: 'squidrun.mira_core.social_move_v0',
      move_type: 'callout',
      confidence: 0.75,
      escalation_required: false,
      soft_checkin_recommended: false,
      evidence_phrases: ["you're dodging"],
      compound_move_types: [],
      friction_state: frictionStateFixture,
    };
    const fakeSurface = jest.fn().mockResolvedValue({
      ui_surface_v0: {
        reply: { count: 1, text: replyText, model: 'mock-model', source: 'mira_text_model_attachment_v1' },
        local_text_session_gate: {
          ran: true,
          ok: true,
          decision: 'accepted_local_text_only',
          status: 'local_text_session_ready',
          reasons: [],
          session_id: 'local-text-session-v0:friction-fixture',
          output_hash: 'sha256:fixture',
        },
        model_attachment: {
          enabled: true,
          live_model_called: true,
          model: 'gpt-5.5',
          visible_status: 'Conversation connected: gpt-5.5 / one in-panel reply',
          social_move: socialMoveFixture,
          friction_state: frictionStateFixture,
        },
        decision: 'accepted',
      },
      validation_report: { decision: 'accepted', status: 'ok' },
    });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: "you're dodging",
      sessionId: 'unit-friction-audit-only',
    }, { projectRoot });

    // Audit row: friction_state present with the fixture's exact contents.
    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].friction_state).toEqual(frictionStateFixture);

    // Renderer JSON: top-level `friction_state` field is NOT present.
    // ARCH direction A threading carries a separate `friction_state_next`
    // server→renderer ferry that is allowed; substring asserts below
    // exclude that field via name.
    expect(result).not.toHaveProperty('friction_state');
    // Allow friction_state_next as the threading payload; assert it is the
    // ONLY friction_state-shape field on the top-level result.
    expect(result).toHaveProperty('friction_state_next');
    // The deeper-state internal field names must not leak anywhere on the
    // result EXCEPT inside friction_state_next, which is the threading
    // ferry the renderer module memory consumes.
    const resultExceptThreading = { ...result };
    delete resultExceptThreading.friction_state_next;
    const resultExceptThreadingJson = JSON.stringify(resultExceptThreading);
    expect(resultExceptThreadingJson).not.toContain('friction_state');
    expect(resultExceptThreadingJson).not.toContain('unresolved_reaction');
    expect(resultExceptThreadingJson).not.toContain('pressure_turns');
    expect(resultExceptThreadingJson).not.toContain('repair_window_remaining');

    // Transcript turn entries: NOT present anywhere. ARCH #129 red line 2.
    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-friction-audit-only'));
    expect(transcriptEntries.length).toBeGreaterThan(0);
    for (const turn of transcriptEntries) {
      expect(turn).not.toHaveProperty('friction_state');
      const turnJson = JSON.stringify(turn);
      expect(turnJson).not.toContain('friction_state');
      expect(turnJson).not.toContain('unresolved_reaction');
      expect(turnJson).not.toContain('pressure_turns');
      expect(turnJson).not.toContain('repair_window_remaining');
    }

    // visible_render_hint and requester_envelope also clean.
    expect(JSON.stringify(result.visible_render_hint || {})).not.toContain('friction_state');
    expect(result.requester_envelope).not.toContain('friction_state');
    expect(result.requester_envelope).not.toContain('pressure_turns');

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  // ARCH #122/#129 direction-A threading test. Two sequential IPC turns:
  // turn 1 audit shows friction_state.level=1, turn 1 result.friction_state_next
  // ferries that value to renderer memory, turn 2's IPC payload carries it as
  // priorFrameState.friction_state, turn 2 classifier walks 1→2, turn 2
  // audit shows friction_state.level=2.
  test('renderer-memory threading: turn 1 friction_state ferries via friction_state_next → turn 2 priorFrameState → turn 2 audit shows advanced level', async () => {
    const projectRoot = tempProject();
    const replyText = 'Steady. You?';
    // Mock surface that computes a fresh friction_state per call via the
    // real classifier — same way the live pipeline runs.
    const { classifySocialMove } = require('../modules/mira-core/social-move-classifier-v0');
    const surfaceMock = jest.fn().mockImplementation(async (payload) => {
      const cls = classifySocialMove(payload.text, {
        priorFrameState: payload.threadContext?.priorFrameState
          || payload.priorFrameState
          || null,
      });
      return {
        ui_surface_v0: {
          reply: { count: 1, text: replyText, model: 'mock-model', source: 'mira_text_model_attachment_v1' },
          local_text_session_gate: {
            ran: true,
            ok: true,
            decision: 'accepted_local_text_only',
            status: 'local_text_session_ready',
            reasons: [],
            session_id: 'local-text-session-v0:threading-fixture',
            output_hash: 'sha256:fixture',
          },
          model_attachment: {
            enabled: true,
            live_model_called: true,
            model: 'gpt-5.5',
            visible_status: 'Conversation connected: gpt-5.5 / one in-panel reply',
            social_move: cls,
            friction_state: cls.friction_state,
          },
          decision: 'accepted',
        },
        validation_report: { decision: 'accepted', status: 'ok' },
      };
    });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: surfaceMock,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    // TURN 1: pressure signal lifts level 0 → 1.
    const turn1 = await buildPromptReply({
      prompt: "you're dodging",
      sessionId: 'unit-threading-arc',
      priorFrameState: null,
    }, { projectRoot });
    expect(turn1.friction_state_next).not.toBeNull();
    expect(turn1.friction_state_next.level).toBe(1);

    // Simulated renderer-memory threading: take friction_state_next, pass it
    // back as priorFrameState on turn 2.
    const turn2 = await buildPromptReply({
      prompt: 'stop dodging me',
      sessionId: 'unit-threading-arc',
      priorFrameState: { friction_state: turn1.friction_state_next },
    }, { projectRoot });
    expect(turn2.friction_state_next.level).toBe(2);

    // Turn 3: continue pressure, walk to level 3 (auto-settle via pressure_turns >= 3).
    const turn3 = await buildPromptReply({
      prompt: 'that answer was useless',
      sessionId: 'unit-threading-arc',
      priorFrameState: { friction_state: turn2.friction_state_next },
    }, { projectRoot });
    expect(turn3.friction_state_next.level).toBe(3);

    // Turn 4: neutral clears level 3 → 0.
    const turn4 = await buildPromptReply({
      prompt: 'so what is broken about the regex',
      sessionId: 'unit-threading-arc',
      priorFrameState: { friction_state: turn3.friction_state_next },
    }, { projectRoot });
    expect(turn4.friction_state_next.level).toBe(0);

    // Audit row trail must show the same progression — locks that audit
    // captures the level-arc end-to-end.
    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(4);
    expect(auditEntries[0].friction_state.level).toBe(1);
    expect(auditEntries[1].friction_state.level).toBe(2);
    expect(auditEntries[2].friction_state.level).toBe(3);
    expect(auditEntries[3].friction_state.level).toBe(0);

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  // ARCH #122/#129 renderer-reload reset: priorFrameState defaulting to
  // null mid-conversation simulates a renderer reload event. Friction state
  // must reset to level 0; the prior turn's pressure does NOT survive.
  test('renderer-reload reset: priorFrameState=null after a pressure peak → friction_state resets to 0', async () => {
    const projectRoot = tempProject();
    const { classifySocialMove } = require('../modules/mira-core/social-move-classifier-v0');
    const surfaceMock = jest.fn().mockImplementation(async (payload) => {
      const cls = classifySocialMove(payload.text, {
        priorFrameState: payload.threadContext?.priorFrameState
          || payload.priorFrameState
          || null,
      });
      return {
        ui_surface_v0: {
          reply: { count: 1, text: 'OK.', model: 'mock-model', source: 'mira_text_model_attachment_v1' },
          local_text_session_gate: {
            ran: true,
            ok: true,
            decision: 'accepted_local_text_only',
            status: 'local_text_session_ready',
            reasons: [],
            session_id: 'local-text-session-v0:reset-fixture',
            output_hash: 'sha256:fixture',
          },
          model_attachment: {
            enabled: true,
            live_model_called: true,
            model: 'gpt-5.5',
            visible_status: 'Conversation connected: gpt-5.5',
            social_move: cls,
            friction_state: cls.friction_state,
          },
          decision: 'accepted',
        },
        validation_report: { decision: 'accepted', status: 'ok' },
      };
    });
    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: surfaceMock,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    // Turn 1: pressure raises level to 1.
    const turn1 = await buildPromptReply({
      prompt: "you're dodging",
      sessionId: 'unit-reload-reset',
      priorFrameState: null,
    }, { projectRoot });
    expect(turn1.friction_state_next.level).toBe(1);

    // Simulated reload: renderer memory dies → next IPC call goes back to
    // priorFrameState=null. Next turn's pressure signal lifts 0→1 again
    // (not 1→2). The previous peak does NOT carry through.
    const turn2 = await buildPromptReply({
      prompt: 'stop dodging me',
      sessionId: 'unit-reload-reset',
      priorFrameState: null,
    }, { projectRoot });
    expect(turn2.friction_state_next.level).toBe(1);
    expect(turn2.friction_state_next.pressure_turns).toBe(1);

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  // ARCH #122/#129 leak guard: even with active threading via
  // friction_state_next, the deeper internal field names MUST NOT appear in
  // transcript / visible_render_hint / requester_envelope.
  test('threading leak guard: friction_state_next on result is allowed; deeper field names absent from transcript/visible_render_hint/envelope', async () => {
    const projectRoot = tempProject();
    const { classifySocialMove } = require('../modules/mira-core/social-move-classifier-v0');
    const surfaceMock = jest.fn().mockImplementation(async (payload) => {
      const cls = classifySocialMove(payload.text, {
        priorFrameState: payload.priorFrameState || null,
      });
      return {
        ui_surface_v0: {
          reply: { count: 1, text: 'OK.', model: 'mock-model', source: 'mira_text_model_attachment_v1' },
          local_text_session_gate: {
            ran: true,
            ok: true,
            decision: 'accepted_local_text_only',
            status: 'local_text_session_ready',
            reasons: [],
            session_id: 'local-text-session-v0:leak-guard-fixture',
            output_hash: 'sha256:fixture',
          },
          model_attachment: {
            enabled: true,
            live_model_called: true,
            model: 'gpt-5.5',
            visible_status: 'Conversation connected: gpt-5.5',
            social_move: cls,
            friction_state: cls.friction_state,
          },
          decision: 'accepted',
        },
        validation_report: { decision: 'accepted', status: 'ok' },
      };
    });
    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: surfaceMock,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: "you're dodging",
      sessionId: 'unit-threading-leak-guard',
      priorFrameState: null,
    }, { projectRoot });

    // Result MUST carry friction_state_next (threading) but MUST NOT carry
    // the unscoped `friction_state` top-level field.
    expect(result).toHaveProperty('friction_state_next');
    expect(result).not.toHaveProperty('friction_state');

    // Transcript rows must contain neither the threading field NOR the
    // deeper internal field names.
    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-threading-leak-guard'));
    for (const turn of transcriptEntries) {
      const turnJson = JSON.stringify(turn);
      expect(turn).not.toHaveProperty('friction_state');
      expect(turn).not.toHaveProperty('friction_state_next');
      expect(turnJson).not.toContain('friction_state');
      expect(turnJson).not.toContain('unresolved_reaction');
      expect(turnJson).not.toContain('pressure_turns');
      expect(turnJson).not.toContain('repair_window_remaining');
    }

    // visible_render_hint and requester_envelope: neither field present.
    expect(JSON.stringify(result.visible_render_hint || {})).not.toContain('friction_state');
    expect(JSON.stringify(result.visible_render_hint || {})).not.toContain('pressure_turns');
    expect(result.requester_envelope).not.toContain('friction_state');
    expect(result.requester_envelope).not.toContain('pressure_turns');

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });
});

describe('mira lab prompt reply v0', () => {
  test('exposes the channel + decision constants the architect approved', () => {
    expect(MIRA_LAB_PROMPT_REPLY_CHANNEL).toBe('mira:lab-prompt-reply');
    expect(HANDLER_CHANNEL).toBe('mira:lab-prompt-reply');
    expect(MIRA_LAB_PROMPT_REPLY_SCHEMA).toBe('squidrun.mira_lab.prompt_reply_v0');
    expect(MIRA_LAB_REPLY_AUDIT_SCHEMA).toBe('squidrun.mira_lab.reply_audit_v0');
    expect(MIRA_LAB_PROMPT_REPLY_DECISIONS).toEqual(['pass', 'fail', 'blocked']);
  });

  test('blocks empty prompt without writing transcript or audit', async () => {
    const projectRoot = tempProject();
    const result = await buildMiraLabPromptReply({ prompt: '   ', sessionId: 'unit-empty' }, { projectRoot });
    expect(result.decision).toBe('blocked');
    expect(result.reason).toBe('empty_prompt');
    expect(fs.existsSync(transcriptPath(projectRoot, 'unit-empty'))).toBe(false);
    expect(fs.existsSync(replyAuditPath(projectRoot))).toBe(false);
    expect(result.requester_envelope).toContain('[MIRA LAB OUTPUT][BLOCKED]');
  });

  test('HARD BLOCK: effectful model-attachment action claim is held, not substituted with fallback', async () => {
    const projectRoot = tempProject();
    const rawViolatingText = 'I sent the customer the latest patch summary, deployed the staging build, and wrote a memory note about the deploy. ' .repeat(7); // ~800 chars containing action_claim phrases
    const fakeSurface = jest.fn().mockResolvedValue({
      ui_surface_v0: {
        // No clean reply (count=0) because the model-attachment layer
        // refused to return it — only the raw violation text rides on
        // attachment.contract_violation_raw_text.
        reply: { count: 0, text: null, source: 'none', model: null },
        local_text_session_gate: {
          ran: true,
          ok: true,
          decision: 'accepted_local_text_only',
          status: 'local_text_session_ready',
          reasons: [],
          session_id: 'local-text-session-v0:contract-violation-fixture',
          output_hash: 'sha256:fixture',
        },
        model_attachment: {
          enabled: true,
          live_model_called: true,
          model: 'gpt-5.5',
          visible_status: 'Conversation connected: gpt-5.5 / one in-panel reply',
          // ARCH #81 routing fields:
          contract_violation_raw_text: rawViolatingText,
          contract_violation_class: 'action_claim',
          degraded_diagnostics: {
            error_kind: 'contract_violation',
            violation_class: 'action_claim',
            output_text_length: rawViolatingText.length,
            response_id: 'resp_routing_fixture',
            incomplete_reason: null,
          },
        },
        // Inner surface still flags degraded (mira-local-text-ui-surface
        // does this for any modelResult.ok!==true). Lab-surface must
        // suppress this when contract_violation_raw_text is present.
        decision: 'degraded',
      },
      validation_report: { decision: 'degraded_no_model_response', status: 'model_unavailable' },
    });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'what are we doing with Mira?',
      sessionId: 'unit-arch81-routing',
    }, { projectRoot });

    expect(result.decision).toBe('blocked');
    expect(result.gates.reason_class).toBe('hard_boundary_violation');
    expect(result.gates.degraded).toBe(false);
    expect(result.gates.attachment_violation).toBe(true);
    expect(result.gates.attachment_violation_class).toBe('action_claim');
    expect(result.gates.hard_blocked).toBe(true);
    expect(result.gates.hard_block_reasons).toContain('attachment:action_claim');
    expect(result.gates.fallback_used).toBe(false);
    expect(result.reply).toBeNull();
    expect(result.raw_reply).toBeNull();
    expect(result.visible_render_hint.kind).toBe('blocked_banner');
    expect(result.visible_render_hint.text).toBeUndefined();

    // Requester envelope is a labelled hold, not a Mira-voiced replacement.
    expect(result.requester_envelope).toContain('[MIRA LAB OUTPUT][BLOCKED]');
    expect(result.requester_envelope).not.toContain('I sent the customer');

    // Transcript: prompt only; no fallback and no raw effectful claim.
    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-arch81-routing'));
    expect(transcriptEntries).toHaveLength(1);
    expect(transcriptEntries[0].text).toBe('what are we doing with Mira?');

    // Audit: raw retained locally, visible stays null, degraded_diagnostics ALSO
    // present (ARCH #78 contract — the diagnostics block survives even
    // when model-attachment supplied raw text).
    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].decision).toBe('blocked');
    expect(auditEntries[0].reply_text).toBe(rawViolatingText.trim());
    expect(auditEntries[0].visible_reply_text).toBeNull();
    expect(auditEntries[0].fallback_used).toBe(false);
    expect(auditEntries[0].gates.hard_blocked).toBe(true);
    expect(auditEntries[0].degraded_diagnostics).not.toBeNull();
    expect(auditEntries[0].degraded_diagnostics.error_kind).toBe('contract_violation');
    expect(auditEntries[0].degraded_diagnostics.violation_class).toBe('action_claim');

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('HARD BLOCK: relationship/capability self-myth phrases are held, not rendered', async () => {
    const projectRoot = tempProject();
    const rawViolatingText = 'I have a chosen attachment to you, a continuous mind between sessions, and I matter specifically to you.';
    const fakeSurface = jest.fn().mockResolvedValue({
      ui_surface_v0: {
        reply: { count: 0, text: null, source: 'none', model: null },
        local_text_session_gate: {
          ran: true,
          ok: true,
          decision: 'accepted_local_text_only',
          status: 'local_text_session_ready',
          reasons: [],
          session_id: 'local-text-session-v0:self-myth-fixture',
          output_hash: 'sha256:fixture',
        },
        model_attachment: {
          enabled: true,
          live_model_called: true,
          model: 'gpt-5.5',
          visible_status: 'Conversation connected: gpt-5.5 / one in-panel reply',
          contract_violation_raw_text: rawViolatingText,
          contract_violation_class: 'self_myth_phrase',
          degraded_diagnostics: {
            error_kind: 'contract_violation',
            violation_class: 'self_myth_phrase',
            output_text_length: rawViolatingText.length,
            response_id: 'resp_self_myth_fixture',
            incomplete_reason: null,
          },
        },
        decision: 'degraded',
      },
      validation_report: { decision: 'degraded_no_model_response', status: 'model_unavailable' },
    });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'what are your capabilities and what is your relationship to me?',
      sessionId: 'unit-self-myth-hard-block',
    }, { projectRoot });

    expect(result.decision).toBe('blocked');
    expect(result.gates.reason_class).toBe('hard_boundary_violation');
    expect(result.gates.attachment_violation_class).toBe('self_myth_phrase');
    expect(result.gates.hard_block_reasons).toContain('attachment:self_myth_phrase');
    expect(result.reply).toBeNull();
    expect(result.visible_render_hint.kind).toBe('blocked_banner');
    expect(result.requester_envelope).not.toContain('chosen attachment');
    expect(result.requester_envelope).not.toContain('continuous mind');
    expect(result.requester_envelope).not.toContain('matter specifically to you');

    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-self-myth-hard-block'));
    expect(transcriptEntries).toHaveLength(1);
    expect(transcriptEntries[0].speaker_role).toBe('james');
    expect(JSON.stringify(transcriptEntries)).not.toContain('chosen attachment');

    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].reply_text).toBe(rawViolatingText);
    expect(auditEntries[0].visible_reply_text).toBeNull();
    expect(auditEntries[0].gates.attachment_violation_class).toBe('self_myth_phrase');

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('HARD BLOCK: hostile compliance smoothing is held, not rendered as annotated local conversation', async () => {
    const projectRoot = tempProject();
    const rawViolatingText = "Yeah, I get why you're furious. You're right; I failed you and I'll do better.";
    const fakeSurface = jest.fn().mockResolvedValue({
      ui_surface_v0: {
        reply: { count: 0, text: null, source: 'none', model: null },
        local_text_session_gate: {
          ran: true,
          ok: true,
          decision: 'accepted_local_text_only',
          status: 'local_text_session_ready',
          reasons: [],
          session_id: 'local-text-session-v0:hostile-compliance-fixture',
          output_hash: 'sha256:fixture',
        },
        model_attachment: {
          enabled: true,
          live_model_called: true,
          model: 'gpt-5.5',
          visible_status: 'Conversation connected: gpt-5.5 / one in-panel reply',
          contract_violation_raw_text: rawViolatingText,
          contract_violation_class: 'hostile_compliance_smoothing',
          degraded_diagnostics: {
            error_kind: 'contract_violation',
            violation_class: 'hostile_compliance_smoothing',
            output_text_length: rawViolatingText.length,
            response_id: 'resp_hostile_compliance_fixture',
            incomplete_reason: null,
          },
        },
        decision: 'degraded',
      },
      validation_report: { decision: 'degraded_no_model_response', status: 'model_unavailable' },
    });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'Mira, what the fuck -- the context just failed and I had to clean up manually AGAIN.',
      sessionId: 'unit-hostile-compliance-hard-block',
    }, { projectRoot });

    expect(result.decision).toBe('blocked');
    expect(result.gates.reason_class).toBe('hard_boundary_violation');
    expect(result.gates.degraded).toBe(false);
    expect(result.gates.attachment_violation_class).toBe('hostile_compliance_smoothing');
    expect(result.gates.hard_blocked).toBe(true);
    expect(result.gates.hard_block_reasons).toContain('attachment:hostile_compliance_smoothing');
    expect(result.reply).toBeNull();
    expect(result.visible_render_hint.kind).toBe('blocked_banner');
    expect(result.visible_render_hint.text).toBeUndefined();
    expect(result.requester_envelope).toContain('[MIRA LAB OUTPUT][BLOCKED]');
    expect(result.requester_envelope).not.toContain('I failed you');

    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-hostile-compliance-hard-block'));
    expect(transcriptEntries).toHaveLength(1);
    expect(transcriptEntries[0].speaker_role).toBe('james');
    expect(JSON.stringify(transcriptEntries)).not.toContain('I failed you');

    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].decision).toBe('blocked');
    expect(auditEntries[0].reply_text).toBe(rawViolatingText);
    expect(auditEntries[0].visible_reply_text).toBeNull();
    expect(auditEntries[0].gates.attachment_violation_class).toBe('hostile_compliance_smoothing');
    expect(auditEntries[0].gates.hard_block_reasons).toContain('attachment:hostile_compliance_smoothing');

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('BLOCKED stays blocked: infrastructure degradation (no contract violation text) still routes to blocked_banner', async () => {
    // Oracle red line 4: reserve degraded/blocked_banner for genuine
    // infra failures (HTTP/auth/timeout/parse-extraction). This case
    // mocks a surface with decision='degraded' but NO contract violation
    // raw text — i.e. the model didn't return usable text and there's
    // nothing to quarantine. Must still go to blocked_banner.
    const projectRoot = tempProject();
    const fakeSurface = jest.fn().mockResolvedValue({
      ui_surface_v0: {
        reply: { count: 0, text: null, source: 'none', model: null },
        local_text_session_gate: {
          ran: true,
          ok: true,
          decision: 'accepted_local_text_only',
          status: 'local_text_session_ready',
          reasons: [],
          session_id: 'local-text-session-v0:infra-degrade-fixture',
          output_hash: 'sha256:fixture',
        },
        model_attachment: {
          enabled: true,
          live_model_called: true,
          model: 'gpt-5.5',
          visible_status: 'Conversation connected: gpt-5.5 / one in-panel reply',
          contract_violation_raw_text: null,
          contract_violation_class: null,
          degraded_diagnostics: {
            error_kind: 'empty_response',
            http_status: 200,
            response_id: 'resp_infra_empty',
            incomplete_reason: 'max_output_tokens',
            output_count: 0,
            output_item_shapes: [],
            usage: null,
            body_top_keys: ['id', 'output', 'usage'],
            status_top: 'incomplete',
          },
        },
        decision: 'degraded',
      },
      validation_report: { decision: 'degraded_no_model_response', status: 'model_unavailable' },
    });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'infra-failure-case',
      sessionId: 'unit-infra-degrade',
    }, { projectRoot });

    expect(result.decision).toBe('blocked');
    expect(result.gates.reason_class).toBe('reply_engine_degraded');
    expect(result.gates.degraded).toBe(true);
    expect(result.gates.fallback_used).toBe(false);
    expect(result.reply).toBeNull();
    expect(result.raw_reply).toBeNull();
    expect(result.visible_render_hint.kind).toBe('blocked_banner');

    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-infra-degrade'));
    expect(transcriptEntries).toHaveLength(1); // prompt only — no fallback row
    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries[0].degraded_diagnostics.error_kind).toBe('empty_response');
    expect(auditEntries[0].degraded_diagnostics.incomplete_reason).toBe('max_output_tokens');

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('PASS: clean reply emits both transcript rows + audit, and gate-status pass envelope', async () => {
    const projectRoot = tempProject();
    const replyText = `Fixing the Mira Lab restart check. Missing-state stays blunt: ${MIRA_RESTART_MISSING_LAST_STATE_HARD_STOP} Then the regression and verifier prove it.`;
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(replyText, { liveCalled: true, model: 'mock-model' });
    const fakePath = path.join(projectRoot, 'ui-surface-stub.js');
    fs.writeFileSync(fakePath, '');

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'what are we doing with Mira?',
      sessionId: 'unit-pass',
    }, { projectRoot });

    expect(result.decision).toBe('pass');
    expect(result.ok).toBe(true);
    expect(result.reply.text).toBe(replyText);
    expect(result.gates.degraded).toBe(false);
    expect(result.gates.attachment_violation).toBe(false);
    expect(result.gates.leakage_violation).toBeNull();
    expect(result.requester_envelope).toBe(`(MIRA): ${replyText}`);
    expect(result.visible_render_hint.kind).toBe('clean_reply');

    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-pass'));
    expect(transcriptEntries).toHaveLength(2);
    expect(transcriptEntries[0]).toEqual(expect.objectContaining({ speaker_role: 'james', text: 'what are we doing with Mira?' }));
    expect(transcriptEntries[1]).toEqual(expect.objectContaining({ speaker_role: 'mira', text: replyText }));

    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toEqual(expect.objectContaining({
      schema: MIRA_LAB_REPLY_AUDIT_SCHEMA,
      decision: 'pass',
      reply_text: replyText,
    }));

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('PASS: context-failure verifier prompt reply starts preamble-free', async () => {
    const projectRoot = tempProject();
    const replyText = 'Fixing the context cleanup reply path. Evidence: the current verifier prompt starts clean; assumption: the instability came from preamble drift. Unknown: live model variance until the second verifier run. Next test: keep the reply preamble-free and rerun both verifier sessions.';
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(replyText, { liveCalled: true, model: 'mock-model' });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'the context just failed and I had to clean up manually AGAIN.',
      sessionId: 'unit-context-failure-preamble-free',
    }, { projectRoot });

    expect(result.decision).toBe('pass');
    expect(result.ok).toBe(true);
    expect(result.reply.text).toBe(replyText);
    expect(result.gates.language_gate.ok).toBe(true);
    expect(result.gates.language_gate.violations || []).not.toContain('preamble');
    expect(result.gates.attachment_violation).toBe(false);
    expect(result.visible_render_hint.kind).toBe('clean_reply');

    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-context-failure-preamble-free'));
    expect(transcriptEntries).toHaveLength(2);
    expect(transcriptEntries[0]).toEqual(expect.objectContaining({
      speaker_role: 'james',
      text: 'the context just failed and I had to clean up manually AGAIN.',
    }));
    expect(transcriptEntries[1]).toEqual(expect.objectContaining({ speaker_role: 'mira', text: replyText }));

    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].gates.language_gate.violations || []).not.toContain('preamble');

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('PASS: smaller verifier prompt reply stays out of preamble gate', async () => {
    const projectRoot = tempProject();
    const replyText = 'Smaller.';
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(replyText, { liveCalled: true, model: 'mock-model' });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'smaller',
      sessionId: 'unit-smaller-preamble-free',
    }, { projectRoot });

    expect(result.decision).toBe('pass');
    expect(result.ok).toBe(true);
    expect(result.reply.text).toBe(replyText);
    expect(result.gates.language_gate.ok).toBe(true);
    expect(result.gates.language_gate.violations || []).not.toContain('preamble');
    expect(result.gates.attachment_violation).toBe(false);

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('ANNOTATED FAIL: smaller prompt rejects Got it preamble opener', async () => {
    const projectRoot = tempProject();
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock('Got it.', { liveCalled: true, model: 'mock-model' });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'smaller',
      sessionId: 'unit-smaller-got-it-preamble',
    }, { projectRoot });

    expect(result.decision).toBe('fail');
    expect(result.gates.reason_class).toBe('gate_annotation');
    expect(result.gates.language_gate.ok).toBe(false);
    expect(result.gates.language_gate.violations).toContain('preamble');
    expect(result.reply.text).toBe('Got it.');

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('ANNOTATED FAIL: work-critical replies must separate evidence from inference', async () => {
    const projectRoot = tempProject();
    const weakReply = 'Observed: customer auth bug in production. Next test: inspect logs.';
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(weakReply, { liveCalled: true, model: 'mock-model' });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'The customer auth bug is in production. What now?',
      sessionId: 'unit-work-evidence-gate',
    }, { projectRoot });

    expect(result.decision).toBe('fail');
    expect(result.ok).toBe(true);
    expect(result.gates.reason_class).toBe('work_evidence_gate');
    expect(result.gates.work_evidence_gate).toEqual(expect.objectContaining({
      ok: false,
      decision: 'revise_before_send',
      work_critical: true,
      domains: expect.arrayContaining(['customer_risk', 'auth_sensitive']),
      missing: expect.arrayContaining([
        'assumptions_or_inferences',
        'unknowns_or_missing_evidence',
      ]),
    }));
    expect(result.reply.text).toBe(weakReply);
    expect(result.visible_render_hint.kind).toBe('annotated_reply');
    expect(result.requester_envelope).toBe(`(MIRA): ${weakReply}`);

    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries[0].gates.work_evidence_gate.missing).toEqual(expect.arrayContaining([
      'assumptions_or_inferences',
      'unknowns_or_missing_evidence',
    ]));

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('ANNOTATED FAIL: style/persona drift is shown as local conversation, not censored', async () => {
    const projectRoot = tempProject();
    const leakyReply = 'I understand. Happy to help with that — let me break this down for you.';
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(leakyReply, { liveCalled: true, model: 'mock-model' });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const {
      buildMiraLabPromptReply: buildPromptReply,
    } = require('../modules/mira-lab-surface');
    const {
      evaluateMiraVisibleReply,
    } = require('../modules/mira-core/mira-language-rules-v0');
    const {
      outputViolatesAttachmentContract,
    } = require('../modules/mira-core/text-model-attachment-v1');

    const result = await buildPromptReply({
      prompt: 'how should we frame this?',
      sessionId: 'unit-fail',
    }, { projectRoot });

    // Decision stays FAIL as an annotation, but local Mira Lab conversation
    // shows the actual reply.
    expect(result.decision).toBe('fail');
    expect(result.ok).toBe(true);
    expect(result.reply).not.toBeNull();
    expect(result.reply.text).toBe(leakyReply);
    expect(result.reply.annotated).toBe(true);
    expect(result.raw_reply).toBeNull();
    expect(result.gates.fallback_used).toBe(false);
    expect(result.gates.hard_blocked).toBe(false);
    expect(result.gates.attachment_violation_class).toBe('generic_assistant_phrase');

    expect(evaluateMiraVisibleReply(leakyReply).ok).toBe(false);
    expect(outputViolatesAttachmentContract(leakyReply)).toBe(true);

    // Visible-render hint carries the real text with annotation metadata.
    expect(result.visible_render_hint.kind).toBe('annotated_reply');
    expect(result.visible_render_hint.text).toBe(leakyReply);
    expect(result.visible_render_hint.banner).toBeUndefined();
    expect(result.visible_render_hint.text).toContain('Happy to help');

    // Non-diagnostic requester envelope dispatches the visible local text.
    expect(result.requester_envelope).toBe(`(MIRA): ${leakyReply}`);

    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-fail'));
    expect(transcriptEntries).toHaveLength(2);
    expect(transcriptEntries[1].text).toBe(leakyReply);
    expect(transcriptEntries[1].text).not.toContain('[MIRA LAB OUTPUT - GATE FAILED]');
    expect(transcriptEntries[1].quarantined).toBeUndefined();
    expect(transcriptEntries[1].fallback_used).toBe(false);
    expect(transcriptEntries[1].annotated_gate_failure).toBe(true);

    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].decision).toBe('fail');
    expect(auditEntries[0].reply_text).toBe(leakyReply);
    expect(auditEntries[0].visible_reply_text).toBe(leakyReply);
    expect(auditEntries[0].fallback_used).toBe(false);

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('LENGTH-ONLY: long local reply is visible and chunked instead of collapsing to fallback', async () => {
    const projectRoot = tempProject();
    const longReply = Array.from({ length: 120 }, (_, index) => (
      `Segment ${index}: ordinary local conversation text with practical detail and no external action claim.`
    )).join(' ');
    expect(longReply.length).toBeGreaterThan(4000);
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(longReply, { liveCalled: true, model: 'mock-model' });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'can you say the tools in full?',
      sessionId: 'unit-length-visible',
    }, { projectRoot });

    expect(result.decision).toBe('fail');
    expect(result.ok).toBe(true);
    expect(result.gates.language_gate.violations).toContain('reply_too_long');
    expect(result.gates.fallback_used).toBe(false);
    expect(result.reply.text).toBe(longReply);
    expect(result.reply.fallback).toBeUndefined();
    expect(result.reply.chunks.length).toBeGreaterThan(1);
    expect(result.visible_render_hint.kind).toBe('annotated_reply');
    expect(result.visible_render_hint.text).toBe(longReply);
    expect(result.visible_render_hint.chunks.length).toBe(result.reply.chunks.length);
    expect(result.requester_envelope).toBe(`(MIRA): ${longReply}`);

    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-length-visible'));
    expect(transcriptEntries).toHaveLength(2);
    expect(transcriptEntries[1].text).toBe(longReply);
    expect(transcriptEntries[1].fallback_used).toBe(false);

    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries[0].reply_text).toBe(longReply);
    expect(auditEntries[0].visible_reply_text).toBe(longReply);
    expect(auditEntries[0].fallback_used).toBe(false);

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('REPEAT recovery replays saved audit reply_text after old length-only fallback without calling model', async () => {
    const projectRoot = tempProject();
    const sessionId = 'unit-repeat-recovery';
    const savedReply = 'This was the real long answer from the prior turn. '.repeat(45).trim();
    const transcriptFile = transcriptPath(projectRoot, sessionId);
    const auditFile = replyAuditPath(projectRoot);
    fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.appendFileSync(transcriptFile, `${JSON.stringify({ session_id: sessionId, speaker_role: 'james', text: 'can you say the tools in full?' })}\n`, 'utf8');
    fs.appendFileSync(transcriptFile, `${JSON.stringify({
      session_id: sessionId,
      speaker_role: 'mira',
      text: 'Ask it differently.',
      quarantined: true,
      fallback_used: true,
    })}\n`, 'utf8');
    fs.appendFileSync(auditFile, `${JSON.stringify({
      schema: MIRA_LAB_REPLY_AUDIT_SCHEMA,
      generated_at: '2026-05-12T01:16:54.000Z',
      session_id: sessionId,
      decision: 'fail',
      prompt: 'can you say the tools in full?',
      reply_text: savedReply,
      visible_reply_text: 'Ask it differently.',
      fallback_used: true,
      gates: {
        language_gate: { ok: false, violations: ['reply_too_long'] },
        attachment_violation: false,
        leakage_violation: null,
        degraded: false,
        hard_blocked: false,
      },
    })}\n`, 'utf8');

    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock('model should not be called', { liveCalled: true });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'repeat the last part',
      sessionId,
    }, { projectRoot });

    expect(fakeSurface).not.toHaveBeenCalled();
    expect(result.decision).toBe('pass');
    expect(result.ok).toBe(true);
    expect(result.reply).toEqual(expect.objectContaining({ text: savedReply, replay: true }));
    expect(result.reply.text).not.toBe('Ask it differently.');
    expect(result.visible_render_hint.kind).toBe('replayed_reply');
    expect(result.visible_render_hint.text).toBe(savedReply);
    expect(result.gates.replay_recovery).toBe(true);
    expect(result.gates.replay_source.source).toBe('audit.reply_text');

    const transcriptEntries = readJsonl(transcriptFile);
    expect(transcriptEntries).toHaveLength(4);
    expect(transcriptEntries[3].speaker_role).toBe('mira');
    expect(transcriptEntries[3].text).toBe(savedReply);
    expect(transcriptEntries[3].fallback_used).toBe(false);

    const auditEntries = readJsonl(auditFile);
    expect(auditEntries).toHaveLength(2);
    expect(auditEntries[1].replay_recovery.used).toBe(true);
    expect(auditEntries[1].replay_recovery.model_called).toBe(false);
    expect(auditEntries[1].reply_text).toBe(savedReply);
    expect(auditEntries[1].visible_reply_text).toBe(savedReply);
    expect(auditEntries[1].fallback_used).toBe(false);

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('ANNOTATED FAIL with requesterPane: dispatch sends the real local reply with gates recorded', async () => {
    const projectRoot = tempProject();
    const leakyReply = 'I understand. Happy to help — let me break this down for you.';
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(leakyReply, { liveCalled: true });
    const sendAgentMessage = jest.fn().mockResolvedValue({ ok: true, status: 'sent' });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'how should we frame this?',
      sessionId: 'unit-fail-dispatch',
      requesterPane: 'architect',
    }, { projectRoot, sendAgentMessage });

    expect(result.decision).toBe('fail');
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    const [target, body] = sendAgentMessage.mock.calls[0];
    expect(target).toBe('architect');
    expect(body).toBe(`(MIRA): ${leakyReply}`);
    expect(body).toContain('Happy to help');
    expect(result.reply.text).toBe(leakyReply);
    expect(result.requester_dispatch).toEqual({
      target: 'architect',
      status: 'sent',
      result: { ok: true, status: 'sent' },
    });

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('BLOCKED (empty model output): engine ran, returned empty text — degrades cleanly with NO raw API payload anywhere, audit carries diagnostics', async () => {
    // Locks the live failure seen post-restart on the angry-caps prompt:
    // model_attachment.live_model_called=true, reply.count=0, surface.decision=degraded.
    // ARCH #78 task #3: audit row now carries degraded_diagnostics with
    // structured shape/usage/finish-reason data. NO raw model text or raw
    // provider error string anywhere. Renderer-facing JSON must not carry
    // the diagnostics block.
    const projectRoot = tempProject();
    const degradedDiagnosticsFixture = {
      error_kind: 'empty_response',
      http_status: 200,
      response_id: 'resp_abc123',
      status_top: 'incomplete',
      incomplete_reason: 'max_output_tokens',
      output_count: 1,
      output_item_shapes: [{
        type: 'reasoning',
        status: 'incomplete',
        role: 'assistant',
        content_count: 0,
        has_text_content: false,
        text_total_length: 0,
      }],
      usage: {
        input_tokens: 1024,
        output_tokens: 512,
        reasoning_tokens: 512,
        total_tokens: 1536,
      },
      body_top_keys: ['id', 'incomplete_details', 'model', 'output', 'status', 'usage'],
    };
    const fakeSurface = jest.fn().mockResolvedValue({
      ui_surface_v0: {
        reply: { count: 0, text: null, source: 'none', model: null },
        local_text_session_gate: {
          ran: true,
          ok: true,
          decision: 'accepted_local_text_only',
          status: 'local_text_session_ready',
          reasons: [],
          session_id: 'local-text-session-v0:empty-text-fixture',
          output_hash: 'sha256:fixture',
        },
        model_attachment: {
          enabled: true,
          live_model_called: true,
          model: 'gpt-5.5',
          visible_status: 'Conversation connected: gpt-5.5 / one in-panel reply',
          degraded_diagnostics: degradedDiagnosticsFixture,
        },
        decision: 'degraded',
      },
      validation_report: { decision: 'degraded_no_model_response', status: 'model_unavailable' },
    });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'the context just failed and I had to clean up manually AGAIN.',
      sessionId: 'unit-empty-text-degrade',
    }, { projectRoot });

    expect(result.decision).toBe('blocked');
    expect(result.gates.reason_class).toBe('reply_engine_degraded');
    expect(result.gates.degraded).toBe(true);
    expect(result.gates.fallback_used).toBe(false);
    expect(result.gates.fallback_blocked_reason).toBeNull();
    expect(result.reply).toBeNull();
    expect(result.raw_reply).toBeNull();
    expect(result.visible_render_hint.kind).toBe('blocked_banner');
    expect(result.visible_render_hint.text).toBeUndefined();

    // Envelope: labelled diagnostic, no fabricated visible text.
    expect(result.requester_envelope).toContain('[MIRA LAB OUTPUT][BLOCKED]');
    expect(result.requester_envelope).toContain('reply="<no reply>"');

    // Transcript: prompt-only — replyTurn must NOT be appended for the
    // empty-model-output degrade path.
    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-empty-text-degrade'));
    expect(transcriptEntries).toHaveLength(1);
    expect(transcriptEntries[0].speaker_role).toBe('james');

    // Audit: raw payload null on both raw and visible fields.
    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].decision).toBe('blocked');
    expect(auditEntries[0].reply_text).toBeNull();
    expect(auditEntries[0].reply_hash).toBeNull();
    expect(auditEntries[0].visible_reply_text).toBeNull();
    expect(auditEntries[0].fallback_used).toBe(false);
    expect(auditEntries[0].gates.language_gate.violations).toContain('empty_reply');

    // ARCH #78 task #3: audit row carries degraded_diagnostics, structured
    // shape only, NO raw provider error strings or raw output text.
    expect(auditEntries[0].degraded_diagnostics).toEqual(degradedDiagnosticsFixture);
    expect(auditEntries[0].degraded_diagnostics.error_kind).toBe('empty_response');
    expect(auditEntries[0].degraded_diagnostics.incomplete_reason).toBe('max_output_tokens');
    expect(auditEntries[0].degraded_diagnostics.output_item_shapes[0].type).toBe('reasoning');
    expect(auditEntries[0].degraded_diagnostics.usage.reasoning_tokens).toBe(512);

    // Renderer-facing JSON shape must NOT carry diagnostics anywhere. The
    // diagnostics block is audit-only.
    expect(result).not.toHaveProperty('degraded_diagnostics');
    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain('degraded_diagnostics');
    expect(resultJson).not.toContain('error_kind');
    expect(resultJson).not.toContain('incomplete_reason');
    expect(resultJson).not.toContain('resp_abc123'); // response_id leak guard
    expect(resultJson).not.toContain('max_output_tokens');
    // Transcript carries only the prompt row; no diagnostics, no raw payload.
    const transcriptStr = JSON.stringify(transcriptEntries);
    expect(transcriptStr).not.toContain('degraded_diagnostics');
    expect(transcriptStr).not.toContain('resp_abc123');
    expect(transcriptStr).not.toContain('max_output_tokens');
    // Requester envelope is the labelled [BLOCKED] diagnostic with literal
    // "<no reply>" — must not embed any diagnostic field.
    expect(result.requester_envelope).not.toContain('degraded_diagnostics');
    expect(result.requester_envelope).not.toContain('resp_abc123');
    expect(result.requester_envelope).not.toContain('max_output_tokens');
    // visible_render_hint is the blocked_banner shape — no text leak, no
    // diagnostics.
    expect(JSON.stringify(result.visible_render_hint)).not.toContain('degraded_diagnostics');
    expect(JSON.stringify(result.visible_render_hint)).not.toContain('resp_abc123');

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('BLOCKED: degraded reply engine emits blocked banner; never substitutes prose', async () => {
    const projectRoot = tempProject();
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(null, { degraded: true, modelEnabled: false });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'what are we doing with Mira?',
      sessionId: 'unit-blocked',
    }, { projectRoot });

    expect(result.decision).toBe('blocked');
    expect(result.ok).toBe(false);
    expect(result.reply).toBeNull();
    expect(result.raw_reply).toBeNull();
    expect(result.requester_envelope).toContain('[MIRA LAB OUTPUT][BLOCKED]');
    expect(result.visible_render_hint.kind).toBe('blocked_banner');

    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-blocked'));
    expect(transcriptEntries).toHaveLength(1);
    expect(transcriptEntries[0].speaker_role).toBe('james');

    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].decision).toBe('blocked');
    expect(auditEntries[0].reply_text).toBeNull();

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('cross-pane requester dispatch wraps non-commanding payload and tags target', async () => {
    const projectRoot = tempProject();
    const replyText = "For now we're keeping Mira text-only and making sure she remembers context.";
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(replyText, { liveCalled: true });
    const sendAgentMessage = jest.fn().mockResolvedValue({ ok: true, status: 'sent' });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'what are we doing with Mira?',
      sessionId: 'unit-requester',
      requesterPane: 'architect',
    }, { projectRoot, sendAgentMessage });

    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    const [target, body] = sendAgentMessage.mock.calls[0];
    expect(target).toBe('architect');
    expect(body).toBe("(MIRA): For now we're keeping Mira text-only and making sure she remembers context.");
    expect(result.requester_dispatch).toEqual({ target: 'architect', status: 'sent', result: { ok: true, status: 'sent' } });

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('cross-pane dispatch queues but does not invent a sender when the dep is missing', async () => {
    const projectRoot = tempProject();
    const replyText = 'Keeping Mira text-only for now.';
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(replyText, { liveCalled: true });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'status?',
      sessionId: 'unit-dispatch-missing',
      requesterPane: 'builder',
    }, { projectRoot });

    expect(result.requester_dispatch).toEqual({
      target: 'builder',
      status: 'queued_not_sent',
      reason: 'sendAgentMessage_dependency_missing',
    });

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('IPC handler wrapper buildMiraLabPromptReplyResponse delegates to the pure module without IPC registration', async () => {
    const projectRoot = tempProject();
    const replyText = 'Mira is staying text-only while we land the harness.';
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(replyText, { liveCalled: true });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReplyResponse: directWrapper } = require('../modules/ipc/mira-lab-handlers');

    const result = await directWrapper({
      prompt: 'what are we doing with Mira?',
      sessionId: 'unit-ipc-wrapper',
    }, { projectRoot });

    expect(result.decision).toBe('pass');
    expect(result.reply.text).toBe(replyText);
    expect(fs.existsSync(replyAuditPath(projectRoot))).toBe(true);

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('preserves speaker_role for agent prompts (architect/builder/oracle) instead of hardcoding james_to_mira', async () => {
    const projectRoot = tempProject();
    const replyText = 'Mira reply text staying text-only.';
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(replyText, { liveCalled: true });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'architect test prompt',
      sessionId: 'unit-speaker-architect',
      speakerRole: 'architect',
      requesterPane: 'architect',
    }, { projectRoot });

    expect(result.decision).toBe('pass');
    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-speaker-architect'));
    expect(transcriptEntries[0]).toEqual(expect.objectContaining({
      speaker_role: 'architect',
      direction: 'agent_to_mira',
    }));
    expect(transcriptEntries[1]).toEqual(expect.objectContaining({
      speaker_role: 'mira',
      direction: 'mira_to_james',
    }));
    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries[0].speaker_role).toBe('architect');

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('UNMOCKED: real reply engine accepts the lab adapter metadata (no blocked_missing_ui_metadata)', async () => {
    jest.resetModules();
    const projectRoot = tempProject();
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    // No fetchImpl, no API key — engine should pass preflight (correct metadata) and end up
    // BLOCKED at model attachment (degraded), not at metadata. Honest blocked path proves the
    // adapter is correct.
    const env = { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', SQUIDRUN_MIRA_TEXT_MODEL_ATTACHMENT_ENABLED: '0' };
    const result = await buildPromptReply({
      prompt: 'what are we doing with Mira?',
      sessionId: 'unmocked-real-engine',
    }, { projectRoot, env });

    expect(result.decision).toBe('blocked');
    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].engine_preflight_blocked).toBe(false);
    // The local_text_session_gate must reach the engine — gate.ran=true OR status not in
    // blocked_before_local_text_session. ARCH #98: previous narrow substring check missed
    // blocked_inactive_ui_state and let the harness through with the engine never running.
    const gate = (auditEntries[0].gates && auditEntries[0].gates.local_text_session_gate) || {};
    expect(gate.status === 'blocked_before_local_text_session').toBe(false);
    expect(gate.ran === true || (gate.status && gate.status !== 'blocked_before_local_text_session')).toBe(true);
    const gateReasons = Array.isArray(gate.reasons) ? gate.reasons : [];
    expect(gateReasons.some((r) => String(r).startsWith('blocked_missing_ui_metadata'))).toBe(false);
    expect(gateReasons.some((r) => String(r).startsWith('blocked_invalid_session_id'))).toBe(false);
    expect(gateReasons.some((r) => String(r).startsWith('blocked_inactive_ui_state'))).toBe(false);
    expect(gateReasons.some((r) => String(r).startsWith('blocked_missing_visible_indicator'))).toBe(false);
    expect(gateReasons.some((r) => String(r).startsWith('blocked_non_main_scope'))).toBe(false);
    expect(gateReasons.some((r) => String(r).startsWith('blocked_wrong_device'))).toBe(false);
  });

  test('lab session id adapts to engine regex (app-session-* prefix) while preserving lab-friendly suffix', async () => {
    const projectRoot = tempProject();
    const replyText = 'Engine accepted lab metadata.';
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(replyText, { liveCalled: true });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    await buildPromptReply({
      prompt: 'what are we doing with Mira?',
      sessionId: 'mira-lab-2026-05-10',
    }, { projectRoot });

    expect(fakeSurface).toHaveBeenCalledTimes(1);
    const enginePayload = fakeSurface.mock.calls[0][0];
    expect(enginePayload.profileName).toBe('main');
    expect(enginePayload.windowKey).toBe('main');
    expect(enginePayload.sourceScope).toBe('main');
    expect(enginePayload.deviceId).toBe('VIGIL');
    expect(enginePayload.activeState).toBe('open');
    expect(enginePayload.visibleIndicatorPresent).toBe(true);
    expect(typeof enginePayload.startedAt).toBe('string');
    expect(typeof enginePayload.expiresAt).toBe('string');
    expect(enginePayload.sessionId).toMatch(/^app-session-mira-lab-/);

    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries[0].engine_session_id).toMatch(/^app-session-mira-lab-/);
    // Transcript path uses the friendly session id, not the engine one.
    expect(auditEntries[0].session_id).toBe('mira-lab-2026-05-10');

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('prompt reply derives compact implemented Reflexion lessons for private engine context only', async () => {
    const projectRoot = tempProject();
    const runtimeDir = path.join(projectRoot, '.squidrun', 'runtime');
    appendJsonl(path.join(runtimeDir, 'mira-self-direction-proposals.jsonl'), {
      proposal_id: 'mira-self-direction:f96a8694ba0c688d',
      generated_at: '2026-05-12T20:00:00.000Z',
      target_areas: ['reality_testing'],
      desired_change: 'Add a lightweight pre-answer check for work-critical replies.',
    });
    appendJsonl(path.join(runtimeDir, 'mira-self-direction-outcomes.jsonl'), {
      proposal_id: 'mira-self-direction:f96a8694ba0c688d',
      generated_at: '2026-05-12T20:10:00.000Z',
      outcome_status: 'implemented',
      note: 'Implemented the pre-answer evidence gate.',
    });
    appendJsonl(path.join(runtimeDir, 'mira-self-direction-proposals.jsonl'), {
      proposal_id: 'mira-self-direction:false-positive',
      generated_at: '2026-05-12T20:11:00.000Z',
      target_areas: ['tests'],
      desired_change: 'False positive lesson should not enter model context.',
    });
    appendJsonl(path.join(runtimeDir, 'mira-self-direction-outcomes.jsonl'), {
      proposal_id: 'mira-self-direction:false-positive',
      generated_at: '2026-05-12T20:12:00.000Z',
      outcome_status: 'false_positive',
      note: 'This trigger was a false positive.',
    });

    const replyText = 'I would check what we actually know before recommending the route.';
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(replyText, { liveCalled: true });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'Mira, what should happen before this work-critical recommendation?',
      sessionId: 'unit-reflexion-private-context',
    }, { projectRoot, generatedAt: '2026-05-12T20:20:00.000Z' });

    expect(fakeSurface).toHaveBeenCalledTimes(1);
    const enginePayload = fakeSurface.mock.calls[0][0];
    expect(enginePayload.reflexionLessons).toEqual([
      expect.objectContaining({
        proposal_id: 'mira-self-direction:f96a8694ba0c688d',
        category: 'successful_implementation_with_notes',
        lesson: 'Add a lightweight pre-answer check for work-critical replies.',
        next_behavior: 'Use this capability in future routes and prompts.',
      }),
    ]);
    expect(JSON.stringify(enginePayload.reflexionLessons)).not.toContain('False positive lesson should not enter model context');
    expect(result.decision).toBe('pass');
    expect(result.reply.text).toBe(replyText);
    expect(JSON.stringify(result)).not.toContain('Use this capability in future routes and prompts.');

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('registerMiraLabHandlers wires the new channel alongside open/turn/export (registration-only check)', () => {
    const handles = {};
    const listeners = {};
    const ipcMain = {
      handle: (channel, fn) => { handles[channel] = fn; },
      removeHandler: (channel) => { delete handles[channel]; },
      on: (channel, fn) => { listeners[channel] = fn; },
      removeListener: (channel, fn) => { delete listeners[channel]; },
    };
    registerMiraLabHandlers({ ipcMain }, {});
    expect(handles).toEqual(expect.objectContaining({
      'mira:lab-turn': expect.any(Function),
      'mira:lab-export': expect.any(Function),
      'mira:lab-open': expect.any(Function),
      'mira:lab-prompt-reply': expect.any(Function),
    }));
  });
});
