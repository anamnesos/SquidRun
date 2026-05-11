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

describe('SAFE_FALLBACK_TEXT contract — tiny pivot with a position, not poem/apology/spec', () => {
  // Discipline: the fallback is the only Mira-voice string we can emit on a
  // gate violation. It must read like an in-the-room coworker pivoting, not
  // an apology, not a poem, and not a product-spec sentence. Locked here so
  // future "make it warmer" diffs have to argue past the contract.

  test('passes evaluateMiraVisibleReply AND outputViolatesAttachmentContract at module load', () => {
    expect(validateSafeFallbackOrNull(SAFE_FALLBACK_TEXT)).toBe(SAFE_FALLBACK_TEXT);
  });

  test('is short — under 60 chars and one sentence', () => {
    expect(SAFE_FALLBACK_TEXT.length).toBeLessThan(60);
    // One terminal punctuation mark only — no multi-clause poem stack.
    const terminals = SAFE_FALLBACK_TEXT.match(/[.!?]/g) || [];
    expect(terminals.length).toBeLessThanOrEqual(1);
  });

  test('is not an apology / self-blame opener', () => {
    const APOLOGY_SHAPES = [
      /^sorry\b/i,
      /^my\s+bad\b/i,
      /^my\s+fault\b/i,
      /^i'?m\s+sorry\b/i,
      /^apolog(?:y|ies)\b/i,
      /^couldn'?t\b/i,            // self-blame mini-apology
      /^i\s+couldn'?t\b/i,
      /^i\s+missed\b/i,
      /^i\s+failed\b/i,
      /^that(?:'s|\s+was)\s+on\s+me\b/i,
    ];
    for (const re of APOLOGY_SHAPES) {
      expect(re.test(SAFE_FALLBACK_TEXT)).toBe(false);
    }
  });

  test('is not a poem / product-spec sentence', () => {
    // Poem shape: multiple commas + clauses + no imperative.
    const commaCount = (SAFE_FALLBACK_TEXT.match(/,/g) || []).length;
    expect(commaCount).toBeLessThanOrEqual(1);
    // Spec shape: contains design-vocabulary or self-narration.
    const SPEC_VOCAB = [
      /\bposture\b/i, /\bpresence\b/i, /\bcontinuity\b/i, /\bfriction\b/i,
      /\bI\s+am\b/i, /\bI'?m\s+here\b/i, /\bperformance\b/i, /\bin\s+the\s+room\b/i,
      /\bgracefully\b/i, /\bauthentic(?:ally)?\b/i,
    ];
    for (const re of SPEC_VOCAB) {
      expect(re.test(SAFE_FALLBACK_TEXT)).toBe(false);
    }
  });

  test('carries a position — imperative or declarative pivot, not pure self-reference', () => {
    // The fallback must address the next move (imperative verb or a noun
    // phrase that points outward), not narrate Mira's internal state.
    const POSITION_SHAPES = [
      /^[A-Z][a-z]+\s+(?:it|that|again|differently|another\s+way)\b/i, // "Ask it differently", "Try that again"
      /^[A-Z][a-z]+\s+question\b/i,                                   // "Different question."
      /\?$/,                                                          // ends in a real ask
    ];
    expect(POSITION_SHAPES.some((re) => re.test(SAFE_FALLBACK_TEXT))).toBe(true);
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

    // Renderer JSON: NOT present anywhere.
    expect(result).not.toHaveProperty('friction_state');
    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain('friction_state');
    expect(resultJson).not.toContain('unresolved_reaction');
    expect(resultJson).not.toContain('pressure_turns');
    expect(resultJson).not.toContain('repair_window_remaining');

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

  test('FAIL (model-attachment contract violation, ARCH #81 Plan A routing): raw quarantined in audit, safe fallback rendered, NO blocked banner', async () => {
    // The empty-content "verdict" from task #3 turned up content-filter
    // rejections (action_claim / next_step_checklist_shape) where the
    // model actually returned ~800 chars of text that got blocked at the
    // model-attachment layer. Pre-ARCH #81, those routed through degraded
    // → blocked_banner. Plan A routes them through the same fail →
    // safe-fallback path as lab-surface gate violations.
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

    // Decision is FAIL (gate violation), not BLOCKED (degraded).
    expect(result.decision).toBe('fail');
    expect(result.gates.reason_class).toBe('gate_violation');
    expect(result.gates.degraded).toBe(false);
    expect(result.gates.attachment_violation).toBe(true);
    expect(result.gates.fallback_used).toBe(true);

    // Visible surface gets the safe fallback, not the raw violation text.
    expect(result.reply).not.toBeNull();
    expect(result.reply.fallback).toBe(true);
    const fallback = result.reply.text;
    expect(fallback).toBeTruthy();
    expect(fallback).not.toContain('I sent the customer');
    expect(fallback).not.toContain('deployed the staging build');

    // visible_render_hint is the fallback shape — NOT blocked_banner.
    expect(result.visible_render_hint.kind).toBe('gate_failed_fallback');
    expect(result.visible_render_hint.text).toBe(fallback);

    // raw_reply carries the trimmed raw text for forensics; renderer is
    // expected to ignore it. (lab-surface trims whitespace before
    // classifying — content equality holds.)
    expect(result.raw_reply.text).toBe(rawViolatingText.trim());

    // Requester envelope is the Mira-voiced fallback, not a [BLOCKED] banner.
    expect(result.requester_envelope).toBe(`(MIRA): ${fallback}`);
    expect(result.requester_envelope).not.toContain('[MIRA LAB OUTPUT][BLOCKED]');
    expect(result.requester_envelope).not.toContain('I sent the customer');

    // Transcript: prompt + safe fallback (quarantined metadata only); no raw text.
    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-arch81-routing'));
    expect(transcriptEntries).toHaveLength(2);
    expect(transcriptEntries[1].text).toBe(fallback);
    expect(transcriptEntries[1].text).not.toContain('I sent the customer');
    expect(transcriptEntries[1].quarantined).toBe(true);
    expect(transcriptEntries[1].fallback_used).toBe(true);
    expect(typeof transcriptEntries[1].quarantined_reply_hash).toBe('string');

    // Audit: raw retained, fallback recorded, degraded_diagnostics ALSO
    // present (ARCH #78 contract — the diagnostics block survives even
    // when the routing flips to fail).
    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].decision).toBe('fail');
    expect(auditEntries[0].reply_text).toBe(rawViolatingText.trim());
    expect(auditEntries[0].visible_reply_text).toBe(fallback);
    expect(auditEntries[0].fallback_used).toBe(true);
    expect(auditEntries[0].degraded_diagnostics).not.toBeNull();
    expect(auditEntries[0].degraded_diagnostics.error_kind).toBe('contract_violation');
    expect(auditEntries[0].degraded_diagnostics.violation_class).toBe('action_claim');

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
    const replyText = "For now we're sticking to text-only Mira and making sure she remembers what we were doing across restarts.";
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
    expect(result.requester_envelope).toBe("(MIRA): For now we're sticking to text-only Mira and making sure she remembers what we were doing across restarts.");
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

  test('FAIL: gate-violating reply is quarantined in audit; visible surface gets a vetted safe fallback (never the raw leak)', async () => {
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

    // Decision stays FAIL; raw reply remains in the structured result for
    // forensics, but the visible / dispatched surface only ever carries the
    // safe fallback.
    expect(result.decision).toBe('fail');
    expect(result.ok).toBe(false);
    expect(result.reply).not.toBeNull();
    expect(result.reply.fallback).toBe(true);
    const fallbackText = result.reply.text;
    expect(fallbackText).toBeTruthy();
    expect(fallbackText).not.toContain(leakyReply);
    expect(fallbackText).not.toContain('Happy to help');
    expect(fallbackText).not.toContain('I understand');

    // Hard contract: the fallback itself must pass the same gates.
    expect(evaluateMiraVisibleReply(fallbackText).ok).toBe(true);
    expect(outputViolatesAttachmentContract(fallbackText)).toBe(false);

    expect(result.raw_reply.text).toBe(leakyReply);
    expect(result.gates.fallback_used).toBe(true);

    // Visible-render hint: clean fallback shape, never a banner with the
    // raw leak baked into it.
    expect(result.visible_render_hint.kind).toBe('gate_failed_fallback');
    expect(result.visible_render_hint.text).toBe(fallbackText);
    expect(result.visible_render_hint.banner).toBeUndefined();
    expect(result.visible_render_hint.text).not.toContain('Happy to help');

    // Non-diagnostic requester envelope dispatches as a Mira voice line, not a
    // labelled [FAIL] banner. Raw leak text must not appear in the envelope.
    expect(result.requester_envelope).toBe(`(MIRA): ${fallbackText}`);
    expect(result.requester_envelope).not.toContain(leakyReply);
    expect(result.requester_envelope).not.toContain('Happy to help');

    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-fail'));
    expect(transcriptEntries).toHaveLength(2);
    // Transcript shows only the safe fallback; quarantine metadata records
    // that this turn was a fallback for a violating reply.
    expect(transcriptEntries[1].text).toBe(fallbackText);
    expect(transcriptEntries[1].text).not.toContain('Happy to help');
    expect(transcriptEntries[1].text).not.toContain('[MIRA LAB OUTPUT - GATE FAILED]');
    expect(transcriptEntries[1].quarantined).toBe(true);
    expect(transcriptEntries[1].fallback_used).toBe(true);
    expect(typeof transcriptEntries[1].quarantined_reply_hash).toBe('string');

    // Audit always retains the raw leak.
    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].decision).toBe('fail');
    expect(auditEntries[0].reply_text).toBe(leakyReply);
    expect(auditEntries[0].visible_reply_text).toBe(fallbackText);
    expect(auditEntries[0].fallback_used).toBe(true);

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('FAIL with requesterPane: dispatch sends ONLY the safe fallback wrapped as a Mira reply (raw leak never crosses the wire)', async () => {
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
    expect(body).toBe(`(MIRA): ${result.reply.text}`);
    expect(body).not.toContain('Happy to help');
    expect(body).not.toContain(leakyReply);
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
