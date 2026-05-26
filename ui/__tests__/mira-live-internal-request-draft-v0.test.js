'use strict';

const {
  buildMiraLiveInternalRequestDraftV0,
  countJamesActionLines,
  isMiraLiveInternalRequestDraftPrompt,
} = require('../modules/mira-core/live-internal-request-draft-v0');

const ARCHITECT_98_BODY = '(ARCHITECT #98): New current-session task: A2 Mira internal-request draft lane. Objective: make Mira produce reviewable internal Builder/Oracle request drafts from live SquidRun evidence without dispatching them. Requirements: draft only, no hm-send, no runtime POST, no external action, no model call unless already allowed by the local text surface contract; answer must identify source evidence, target agent, proposed message body, reason/trigger, blocked/parked exclusions, and exactly one `JAMES ACTION:` line. Use current live evidence after `8223186c`, not parked New Mira/voice/phase scaffolds. Return smallest implementation/proof packet or blocker.';

function row(overrides = {}) {
  return {
    messageId: overrides.messageId || 'm-row',
    sessionId: 'app-session-382',
    senderRole: overrides.senderRole || 'architect',
    targetRole: overrides.targetRole || 'builder',
    direction: 'outbound',
    status: 'routed',
    ackStatus: 'routed_unverified_timeout',
    brokeredAtMs: overrides.brokeredAtMs || Date.parse('2026-05-26T15:00:00.000Z'),
    rawBody: overrides.rawBody || '',
    metadata: { windowKey: 'main' },
  };
}

function draftRows() {
  return [
    row({
      messageId: 'architect-95',
      brokeredAtMs: Date.parse('2026-05-26T14:55:41.607Z'),
      rawBody: '(ARCHITECT #95): HEAD `8223186c Fix handoff current-lane proof pollution`; committed scope is exactly the four reviewed files; git status clean; targeted Jest PASS 3 suites / 78 tests; codebase:index:check PASS.',
    }),
    row({
      messageId: 'architect-96',
      brokeredAtMs: Date.parse('2026-05-26T14:55:41.773Z'),
      rawBody: '(ARCHITECT #96): HEAD/scope/clean tree/tests/index all match; current-lane artifact is closed/none and no builder#22 authority. No further Builder action pending unless Oracle objects.',
    }),
    row({
      messageId: 'architect-98',
      brokeredAtMs: Date.parse('2026-05-26T15:20:58.559Z'),
      rawBody: ARCHITECT_98_BODY,
    }),
  ];
}

describe('Mira live internal request draft v0', () => {
  test('recognizes narrow internal-request draft prompt shapes', () => {
    expect(isMiraLiveInternalRequestDraftPrompt('draft internal request')).toBe(true);
    expect(isMiraLiveInternalRequestDraftPrompt('Mira, prepare a Builder request draft')).toBe(true);
    expect(isMiraLiveInternalRequestDraftPrompt('what now?')).toBe(false);
  });

  test('drafts from live A2 evidence over closed current-lane JSON without effects', () => {
    const draft = buildMiraLiveInternalRequestDraftV0({
      promptText: 'draft internal request',
      metadata: { sessionId: 'app-session-382' },
    }, {
      nowMs: Date.parse('2026-05-26T15:22:00.000Z'),
      currentLaneSnapshot: {
        version: 1,
        generatedAt: '2026-05-26T14:56:00.000Z',
        sessionId: 'app-session-382',
        status: 'none',
        activeLane: null,
      },
      commsRows: draftRows(),
    });

    expect(draft).toEqual(expect.objectContaining({
      ok: true,
      decision: 'drafted_from_live_evidence',
      target_agent: 'builder',
      james_action_line_count: 1,
    }));
    expect(draft.source_status.authority_source).toBe('live_comms_journal');
    expect(draft.source_status.current_lane_json.status).toBe('none');
    expect(draft.source_status.live_comms_journal.source_ref).toBe('architect#98');
    expect(draft.current_lane.source_ref).toBe('architect#98');
    expect(draft.current_lane.objective).toContain('A2 Mira internal-request draft lane');
    expect(draft.source_evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'active_current_session_lane',
        source_ref: 'architect#98',
      }),
      expect.objectContaining({
        kind: 'recent_completed_change',
        source_ref: 'architect#96',
      }),
    ]));
    expect(draft.proposed_message_body).toContain('(DRAFT TO BUILDER)');
    expect(draft.proposed_message_body).toContain('no hm-send');
    expect(draft.proposed_message_body).not.toContain('JAMES ACTION:');
    expect(draft.answer_text).toContain('Source evidence:');
    expect(draft.answer_text).toContain('Target agent: Builder.');
    expect(draft.answer_text).toContain('Proposed message body:');
    expect(draft.answer_text).toContain('Blocked/parked exclusions:');
    expect(draft.answer_text).toContain('parked/prototype/archive');
    expect(countJamesActionLines(draft.answer_text)).toBe(1);
    expect(draft.no_effects).toEqual(expect.objectContaining({
      no_hm_send: true,
      no_sends: true,
      no_runtime_post: true,
      no_external_action: true,
      no_model_call: true,
      no_writes: true,
      draft_only: true,
    }));
  });

  test('prompt can explicitly target Oracle while keeping the same live evidence', () => {
    const draft = buildMiraLiveInternalRequestDraftV0({
      promptText: 'draft an Oracle request message',
      metadata: { sessionId: 'app-session-382' },
    }, {
      nowMs: Date.parse('2026-05-26T15:22:00.000Z'),
      commsRows: draftRows(),
    });

    expect(draft.target_agent).toBe('oracle');
    expect(draft.proposed_message_body).toContain('(DRAFT TO ORACLE)');
    expect(draft.current_lane.source_ref).toBe('architect#98');
    expect(draft.no_effects.no_hm_send).toBe(true);
  });
});
