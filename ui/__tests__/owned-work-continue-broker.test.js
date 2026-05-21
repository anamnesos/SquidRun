/* global afterEach, beforeEach, describe, expect, jest, test */

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('owned-work-continue-broker', () => {
  let tempRoot;
  let queuePath;
  let queue;
  let broker;

  beforeEach(() => {
    jest.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-work-continue-'));
    queuePath = path.join(tempRoot, 'runtime', 'agent-task-queue.json');
    jest.doMock('../config', () => ({
      ...require('./helpers/mock-config').mockDefaultConfig,
      resolveCoordPath: (relPath) => path.join(
        tempRoot,
        String(relPath || '').replace(/^[/\\]+/, '').replace(/[/\\]+/g, path.sep),
      ),
    }));
    queue = require('../scripts/hm-task-queue');
    broker = require('../modules/owned-work-continue-broker');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.dontMock('../config');
  });

  test('returns one safe/caution next-action card from due owned work', () => {
    const nowMs = Date.parse('2026-05-04T12:00:00Z');
    queue.writeQueue({
      agents: {
        builder: {
          pending: [
            {
              taskId: 'builder-safe-1',
              owner: 'builder',
              state: 'queued',
              riskClass: 'safe',
              title: 'Docs pass',
              message: 'Update docs and tests',
              nextStep: 'Write the missing workflow note.',
              wakeTrigger: 'post-wake',
              lastAdvancedAt: nowMs - 1000,
            },
          ],
          active: null,
          history: [],
        },
      },
    }, queuePath);

    const result = broker.buildOwnedWorkContinueCard({
      queuePath,
      nowMs,
      wakeTrigger: 'post-wake',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      hasNextAction: true,
      queuePath,
    }));
    expect(result.nextAction).toEqual(expect.objectContaining({
      action: 'continue_owned_work',
      agent: 'builder',
      taskId: 'builder-safe-1',
      riskClass: 'safe',
      nextStep: 'Write the missing workflow note.',
      resumeCommand: 'node ui/scripts/hm-task-queue.js wake --dispatch --agent builder --trigger post-wake',
    }));
    expect(result.nextAction.prompt).toContain('[OWNED-WORK CONTINUE]');
  });

  test('does not offer approval-required work as the next action', () => {
    const nowMs = Date.parse('2026-05-04T12:00:00Z');
    queue.writeQueue({
      agents: {
        builder: {
          pending: [
            {
              taskId: 'builder-invoice-1',
              owner: 'builder',
              state: 'queued',
              riskClass: 'approval_required',
              message: 'Send customer invoice email',
              wakeTrigger: 'post-wake',
              lastAdvancedAt: nowMs - 1000,
            },
          ],
          active: null,
          history: [],
        },
      },
    }, queuePath);

    const result = broker.buildOwnedWorkContinueCard({
      queuePath,
      nowMs,
      wakeTrigger: 'post-wake',
    });

    expect(result.hasNextAction).toBe(false);
    expect(result.reason).toBe('no_dispatch_ready_owned_work');
    expect(result.counts.approvalRequired).toBe(1);
    expect(result.held[0]).toEqual(expect.objectContaining({
      riskClass: 'approval_required',
      dispatchReady: false,
    }));
  });

  test('turns JAMES ACTION NONE into auto-continue after internal gates', () => {
    const nowMs = Date.parse('2026-05-21T15:10:00Z');
    queue.writeQueue({
      agents: {
        builder: {
          pending: [
            {
              taskId: 'builder-next-product-1',
              owner: 'builder',
              state: 'queued',
              riskClass: 'safe',
              title: 'Next product lane',
              message: 'Continue the next product lane.',
              nextStep: 'Patch the smallest workflow continuation seam.',
              wakeTrigger: 'post-commit',
              lastAdvancedAt: nowMs - 1000,
            },
          ],
          active: null,
          history: [],
        },
      },
    }, queuePath);

    const continueCard = broker.buildOwnedWorkContinueCard({
      queuePath,
      nowMs,
      wakeTrigger: 'post-commit',
    });
    const decision = broker.buildWorkflowContinuationDecision({
      reportText: [
        'Internal gate: Oracle review before commit.',
        'JAMES ACTION: NONE',
      ].join('\n'),
      continueCard,
      trigger: 'post-commit',
      generatedAtMs: nowMs,
    });

    expect(decision).toEqual(expect.objectContaining({
      ok: true,
      decision: 'auto_continue_after_internal_gate',
      autoContinue: true,
      jamesActionRequired: false,
      jamesActionLine: 'JAMES ACTION: NONE',
      internalReviewGateStopsJames: false,
      internalCommitGateStopsJames: false,
    }));
    expect(decision.nextAction).toEqual(expect.objectContaining({
      action: 'continue_owned_work',
      taskId: 'builder-next-product-1',
      nextStep: 'Patch the smallest workflow continuation seam.',
    }));
  });

  test('stops for James only when the action line says DO THIS', () => {
    const decision = broker.buildWorkflowContinuationDecision({
      reportText: [
        'Internal gate is clear.',
        'JAMES ACTION: DO THIS: test the new channel on your phone',
      ].join('\n'),
      generatedAtMs: Date.parse('2026-05-21T15:15:00Z'),
    });

    expect(decision).toEqual(expect.objectContaining({
      ok: true,
      decision: 'james_action_required',
      autoContinue: false,
      jamesActionRequired: true,
      jamesActionLine: 'JAMES ACTION: DO THIS: test the new channel on your phone',
      requiredAction: 'test the new channel on your phone',
    }));
    expect(decision.nextAction).toBeUndefined();
  });

  test('uses the map-backed next step when no owned-work card is due', () => {
    const decision = broker.buildWorkflowContinuationDecision({
      reportText: 'JAMES ACTION: NONE',
      continueCard: { hasNextAction: false, counts: { due: 0 } },
      nextMapBackedStep: 'Open the next product-usefulness lane.',
      trigger: 'post-commit',
    });

    expect(decision).toEqual(expect.objectContaining({
      ok: true,
      decision: 'auto_continue_after_internal_gate',
      autoContinue: true,
      jamesActionRequired: false,
    }));
    expect(decision.nextAction).toEqual({
      action: 'continue_map_backed_step',
      title: 'Next map-backed step',
      nextStep: 'Open the next product-usefulness lane.',
      wakeTrigger: 'post-commit',
      source: 'mira-system-map',
    });
  });

  test('treats missing or duplicate action lines as an internal report fix', () => {
    const missing = broker.buildWorkflowContinuationDecision({
      reportText: 'Internal gate is clear.',
    });
    const duplicate = broker.buildWorkflowContinuationDecision({
      reportText: [
        'JAMES ACTION: NONE',
        'JAMES ACTION: NONE',
      ].join('\n'),
    });

    expect(missing).toEqual(expect.objectContaining({
      ok: false,
      decision: 'internal_report_needs_action_line_fix',
      autoContinue: false,
      jamesActionRequired: false,
      reason: 'missing_james_action_line',
    }));
    expect(duplicate).toEqual(expect.objectContaining({
      ok: false,
      decision: 'internal_report_needs_action_line_fix',
      autoContinue: false,
      jamesActionRequired: false,
      reason: 'multiple_james_action_lines',
    }));
  });
});
