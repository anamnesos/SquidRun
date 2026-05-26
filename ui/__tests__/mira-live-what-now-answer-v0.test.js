'use strict';

const {
  buildMiraLiveWhatNowAnswerV0,
  countJamesActionLines,
  isMiraLiveWhatNowPrompt,
} = require('../modules/mira-core/live-what-now-answer-v0');
const {
  extractCurrentLaneDirective,
} = require('../modules/main/agent-task-resolution');

const ARCHITECT_63_BODY = '(ARCHITECT #63): Generator fix commit proof accepted. Cleanup checkpoint closed: `1f75cc5f Remove stale Mira local text tab shell` and `2a549a26 Stabilize codebase index freshness check`, clean tree, codebase:index:check PASS. New current-session task: A1/A2 visible Mira movement lane. Objective: implement/propose the smallest user-visible `what now?` answer from live local evidence. Requirements: answer current lane/status, recent concrete changes, stale/parked evidence excluded from authority, next Builder/Oracle/internal move, exactly one `JAMES ACTION:` line; no sends, no runtime POST, no external action. Use live SquidRun evidence/current lane, not parked prototype/phase scaffold. Return implementation/proof packet or blocker.';
const BUILDER_21_PROOF_BODY = [
  '(BUILDER #21): A1/A2 visible Mira movement patch is staged for review, no commit.',
  '',
  'Implemented:',
  '- Added `ui/modules/mira-core/live-what-now-answer-v0.js`: read-only live-evidence renderer for narrow `what now?` prompts.',
  '- Wired it into `ui/modules/mira-local-text-ui-surface.js` after the local session gate. It bypasses model attachment for the deterministic what-now path.',
  '- Tightened `ui/modules/main/agent-task-resolution.js` so Architect #63 is recognized even though "New current-session task:" appears mid-message, and unrelated later target rows do not close it.',
  '',
  'Recommend Oracle review; execute commit after PASS. No sends/runtime POST/external action were added to the Mira surface.',
].join('\n');
const ORACLE_PROOF_BODY = [
  '(ORACLE #8): PASS on Builder packet.',
  'Finding checked: quoted "New current-session task:" text appears only as parser explanation, not a live lane directive.',
  'Verdict: no send/runtime POST/external action.',
].join('\n');

function row(overrides = {}) {
  return {
    messageId: overrides.messageId || 'm-row',
    sessionId: 'app-session-382',
    senderRole: overrides.senderRole || 'architect',
    targetRole: overrides.targetRole || 'builder',
    direction: 'outbound',
    status: 'routed',
    ackStatus: 'routed_unverified_timeout',
    brokeredAtMs: overrides.brokeredAtMs || Date.parse('2026-05-26T08:52:00.000Z'),
    rawBody: overrides.rawBody || '',
    metadata: { windowKey: 'main' },
  };
}

describe('Mira live what-now answer v0', () => {
  test('recognizes the narrow what-now prompt shape', () => {
    expect(isMiraLiveWhatNowPrompt('what now?')).toBe(true);
    expect(isMiraLiveWhatNowPrompt('Mira, what now?')).toBe(true);
    expect(isMiraLiveWhatNowPrompt('what are we doing with billing?')).toBe(false);
  });

  test('extracts mid-message new current-session tasks from live Architect rows', () => {
    const directive = extractCurrentLaneDirective(ARCHITECT_63_BODY);

    expect(directive).toEqual(expect.objectContaining({
      kind: 'current_session_task',
      objective: expect.stringContaining('A1/A2 visible Mira movement lane'),
    }));
  });

  test('ignores Builder proof packets that quote current-session task syntax', () => {
    expect(extractCurrentLaneDirective(BUILDER_21_PROOF_BODY)).toBeNull();
    expect(extractCurrentLaneDirective(ORACLE_PROOF_BODY)).toBeNull();
  });

  test('answers from live comms over inactive current-lane JSON without effects', () => {
    const answer = buildMiraLiveWhatNowAnswerV0({
      promptText: 'what now?',
      metadata: { sessionId: 'app-session-382' },
    }, {
      nowMs: Date.parse('2026-05-26T08:53:00.000Z'),
      currentLaneSnapshot: {
        version: 1,
        generatedAt: '2026-05-26T08:52:35.009Z',
        sessionId: 'app-session-382',
        status: 'none',
        activeLane: null,
        continuity: {
          recent_completed_fixes: [{
            source_ref: 'architect#63',
            summary: 'Cleanup checkpoint closed.',
          }],
          stale_backlog_markers: ['delivery-uncertain rows are restart context, not live blockers.'],
        },
      },
      commsRows: [
        row({
          messageId: 'builder-20',
          senderRole: 'builder',
          targetRole: 'architect',
          brokeredAtMs: Date.parse('2026-05-26T08:52:14.177Z'),
          rawBody: '(BUILDER #20): Commit proof for generator freshness fix. Commit landed: - 2a549a26 Stabilize codebase index freshness check.',
        }),
        row({
          messageId: 'architect-63',
          brokeredAtMs: Date.parse('2026-05-26T08:52:32.711Z'),
          rawBody: ARCHITECT_63_BODY,
        }),
        row({
          messageId: 'architect-64',
          targetRole: 'oracle',
          brokeredAtMs: Date.parse('2026-05-26T08:52:32.859Z'),
          rawBody: '(ARCHITECT #64): Cleanup checkpoint closed. Commits: `1f75cc5f Remove stale Mira local text tab shell` and `2a549a26 Stabilize codebase index freshness check`; clean tree and post-commit codebase:index:check PASS. New sidecar task: A1/A2 visible Mira movement lane. Builder owns implementation/proposal. Your gate: visible what-now answer must use live evidence, exclude parked/prototype/archive authority, contain exactly one JAMES ACTION line, and prove no send/runtime POST/external action. Return PASS/MODIFY/BLOCK on Builder packet.',
        }),
        row({
          messageId: 'builder-21',
          senderRole: 'builder',
          targetRole: 'architect',
          brokeredAtMs: Date.parse('2026-05-26T09:05:18.049Z'),
          rawBody: BUILDER_21_PROOF_BODY,
        }),
      ],
    });

    expect(answer).toEqual(expect.objectContaining({
      ok: true,
      decision: 'answered_from_live_evidence',
      james_action_line_count: 1,
    }));
    expect(answer.source_status.authority_source).toBe('live_comms_journal');
    expect(answer.source_status.live_comms_journal.source_ref).toBe('architect#63');
    expect(answer.current_lane.objective).toContain('A1/A2 visible Mira movement lane');
    expect(answer.answer_text).toContain('Current lane: A1/A2 visible Mira movement lane');
    expect(answer.answer_text).toContain('Recent changes:');
    expect(answer.answer_text).toContain('parked, prototype, archive');
    expect(answer.answer_text).toContain('Next internal move: Builder proves this read-only what-now surface, then Oracle reviews it');
    expect(countJamesActionLines(answer.answer_text)).toBe(1);
    expect(answer.no_effects).toEqual(expect.objectContaining({
      no_sends: true,
      no_runtime_post: true,
      no_external_action: true,
      no_writes: true,
    }));
  });
});
