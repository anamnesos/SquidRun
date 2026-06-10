'use strict';

const {
  EVIDENCE_SOURCE_REFS,
  buildMiraLiveWhatNowAnswerV0,
  countJamesActionLines,
  isMiraLiveWhatNowPrompt,
  validateLiveWhatNowAnswer,
} = require('../modules/mira-core/live-what-now-answer-v0');
const {
  extractCurrentLaneDirective,
} = require('../modules/main/agent-task-resolution');

const NOW_MS = Date.parse('2026-05-26T08:53:00.000Z');

// Deterministic 7-source evidence overrides, all dates RELATIVE to NOW_MS so
// the fixtures cannot rot as the real clock advances (3b2f38c6 lesson).
function freshIso(offsetMs = 60_000) {
  return new Date(NOW_MS - offsetMs).toISOString();
}

function evidenceOverrides(overrides = {}) {
  return {
    app_status: {
      lastUpdated: freshIso(),
      session: 382,
      paneHost: { degraded: false, missingPanes: [] },
    },
    task_queue: null,
    work_items: null,
    workItemReconciliation: null,
    restart_resume: null,
    startup_health: { overall: 'PASS', score: 100, warnings: [] },
    ...overrides,
  };
}

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
      nowMs: NOW_MS,
      evidenceOverrides: evidenceOverrides(),
      currentLaneSnapshot: {
        version: 1,
        generatedAt: freshIso(25_000),
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
    expect(answer.answer_text).toContain('Session 382');
    expect(answer.answer_text).toContain('Lane: A1/A2 visible Mira movement lane');
    expect(answer.answer_text).toContain('Next:');
    expect(countJamesActionLines(answer.answer_text)).toBe(1);
    expect(answer.shape_check).toEqual({ ok: true, violations: [] });
    expect(answer.source_refs).toHaveLength(7);
    expect(answer.no_effects).toEqual(expect.objectContaining({
      no_sends: true,
      no_runtime_post: true,
      no_external_action: true,
      no_writes: true,
    }));
  });

  test('evidence bundle reports every missing source as present:false without throwing', () => {
    const answer = buildMiraLiveWhatNowAnswerV0({
      promptText: 'what now?',
    }, {
      nowMs: NOW_MS,
      currentLaneSnapshot: null,
      commsRows: [],
      evidenceOverrides: {
        app_status: null,
        task_queue: null,
        work_items: null,
        workItemReconciliation: null,
        restart_resume: null,
        startup_health: null,
      },
    });

    expect(answer.ok).toBe(true);
    expect(answer.decision).toBe('answered_no_active_lane');
    expect(answer.source_refs).toHaveLength(7);
    for (const ref of answer.source_refs) {
      expect(ref.present).toBe(false);
    }
    expect(answer.next.kind).toBe('none');
    expect(countJamesActionLines(answer.answer_text)).toBe(1);
  });

  test('per-source staleness is classified and listed in stale markers', () => {
    const answer = buildMiraLiveWhatNowAnswerV0({
      promptText: 'what now?',
    }, {
      nowMs: NOW_MS,
      currentLaneSnapshot: null,
      commsRows: [],
      evidenceOverrides: evidenceOverrides({
        app_status: {
          lastUpdated: freshIso(31 * 60 * 1000), // older than the 30-min default
          session: 382,
          paneHost: { degraded: false, missingPanes: [] },
        },
      }),
    });

    expect(answer.stale_markers).toEqual(expect.arrayContaining([
      'source_stale:app_status:older_than_stale_after_ms',
    ]));
    expect(answer.answer_text).toContain('Stale:');
  });

  test('queue candidates are offered as labeled next moves but never create lane authority', () => {
    const answer = buildMiraLiveWhatNowAnswerV0({
      promptText: 'what now?',
    }, {
      nowMs: NOW_MS,
      currentLaneSnapshot: {
        version: 1,
        generatedAt: freshIso(20_000),
        sessionId: 'app-session-382',
        status: 'none',
        activeLane: null,
      },
      commsRows: [],
      evidenceOverrides: evidenceOverrides({
        task_queue: {
          updatedAt: freshIso(30_000),
          agents: {
            architect: { active: null, pending: [], history: [] },
            builder: {
              active: null,
              pending: [{ taskId: 'builder-queued-1', title: 'Wire the next surface', state: 'queued' }],
              history: [],
            },
            oracle: { active: null, pending: [], history: [] },
          },
        },
      }),
    });

    expect(answer.decision).toBe('answered_no_active_lane');
    expect(answer.current_lane).toBeNull();
    expect(answer.next).toEqual(expect.objectContaining({
      kind: 'queue_candidate',
      whose_move: 'builder',
      source_ref: EVIDENCE_SOURCE_REFS.task_queue,
      creates_lane_authority: false,
    }));
    expect(answer.source_status.queue_candidates_create_current_lane).toBe(false);
    expect(answer.answer_text).toContain('Next: builder:');
  });

  test('a standing health warning must surface in the visible answer', () => {
    const answer = buildMiraLiveWhatNowAnswerV0({
      promptText: 'what now?',
    }, {
      nowMs: NOW_MS,
      currentLaneSnapshot: null,
      commsRows: [],
      evidenceOverrides: evidenceOverrides({
        startup_health: {
          overall: 'WARN',
          score: 72,
          warnings: ['daemon heartbeat degraded'],
        },
      }),
    });

    expect(answer.answer_text).toContain('Health: WARN 72/100 - daemon heartbeat degraded');
    expect(answer.shape_check).toEqual({ ok: true, violations: [] });
  });

  describe('answer-shape failing cases (validator)', () => {
    function goodAnswerAndEvidence() {
      const evidence = {
        sources: {
          current_lane: { source_ref: EVIDENCE_SOURCE_REFS.current_lane, present: true, stale: false },
          app_status: { source_ref: EVIDENCE_SOURCE_REFS.app_status, present: true, stale: false },
          task_queue: { source_ref: EVIDENCE_SOURCE_REFS.task_queue, present: true, stale: false },
          startup_health: { source_ref: EVIDENCE_SOURCE_REFS.startup_health, present: true, stale: false, overall: 'PASS', warnings: [] },
        },
      };
      const answer = {
        happening: [
          { text: 'Session 425, panes ready', source_ref: EVIDENCE_SOURCE_REFS.app_status },
          { text: 'Lane: restart-storm follow-up', source_ref: EVIDENCE_SOURCE_REFS.current_lane },
        ],
        next: { kind: 'lane_continuity', text: 'Land the follow-up commit', source_ref: EVIDENCE_SOURCE_REFS.current_lane },
        answer_text: 'Session 425, panes ready\nLane: restart-storm follow-up\nNext: Land the follow-up commit\nJAMES ACTION: NONE',
      };
      return { answer, evidence };
    }

    test('the baseline answer passes', () => {
      const { answer, evidence } = goodAnswerAndEvidence();
      expect(validateLiveWhatNowAnswer(answer, evidence)).toEqual({ ok: true, violations: [] });
    });

    test('FAIL: a happening claim without a known source ref', () => {
      const { answer, evidence } = goodAnswerAndEvidence();
      answer.happening[1] = { text: 'Everything is on track', source_ref: null };
      const verdict = validateLiveWhatNowAnswer(answer, evidence);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.some((v) => v.startsWith('unsourced_claim'))).toBe(true);
    });

    test('FAIL: an invented next action no source names', () => {
      const { answer, evidence } = goodAnswerAndEvidence();
      answer.next = { kind: 'lane_continuity', text: 'Refactor the daemon for fun', source_ref: null };
      const verdict = validateLiveWhatNowAnswer(answer, evidence);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations).toContain('invented_next_action');
    });

    test('FAIL: two JAMES ACTION lines', () => {
      const { answer, evidence } = goodAnswerAndEvidence();
      answer.answer_text += '\nJAMES ACTION: also restart the app';
      const verdict = validateLiveWhatNowAnswer(answer, evidence);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations).toContain('james_action_line_count:2');
    });

    test('FAIL: a stale source used as authority for next', () => {
      const { answer, evidence } = goodAnswerAndEvidence();
      evidence.sources.current_lane.stale = true;
      const verdict = validateLiveWhatNowAnswer(answer, evidence);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.some((v) => v.startsWith('stale_source_as_authority'))).toBe(true);
    });

    test('FAIL: a standing health warning suppressed from the visible text', () => {
      const { answer, evidence } = goodAnswerAndEvidence();
      evidence.sources.startup_health.overall = 'WARN';
      evidence.sources.startup_health.warnings = ['daemon heartbeat degraded'];
      const verdict = validateLiveWhatNowAnswer(answer, evidence);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations).toContain('health_warning_suppressed');
    });
  });
});
