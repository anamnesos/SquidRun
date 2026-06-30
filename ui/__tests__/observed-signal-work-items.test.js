const fs = require('fs');
const os = require('os');
const path = require('path');

describe('observed-signal-work-items', () => {
  let tempRoot;
  let workItemRoot;
  let currentLanePath;
  let adapter;
  let ledger;
  let cli;

  beforeEach(() => {
    jest.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-observed-signal-'));
    workItemRoot = path.join(tempRoot, 'runtime', 'work-items');
    currentLanePath = path.join(tempRoot, '.squidrun', 'handoffs', 'current-lane.json');
    jest.doMock('../config', () => ({
      ...require('./helpers/mock-config').mockDefaultConfig,
      WORKSPACE_PATH: path.join(tempRoot, '.squidrun'),
      PROJECT_ROOT: tempRoot,
      getActiveProfile: () => 'main',
      getProjectRoot: () => tempRoot,
      resolveCoordPath: (relPath) => path.join(
        tempRoot,
        '.squidrun',
        String(relPath || '')
          .replace(/^[/\\]+/, '')
          .replace(/[/\\]+/g, path.sep),
      ),
    }));
    adapter = require('../modules/main/observed-signal-work-items');
    ledger = require('../modules/main/work-item-ledger');
    cli = require('../scripts/hm-work-item');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.dontMock('../config');
  });

  function commonOptions() {
    return {
      workItemRoot,
      currentLanePath,
      sessionId: 'app-session-462',
      profileName: 'main',
      windowKey: 'main',
      projectName: 'squidrun',
      projectPath: tempRoot,
      now: '2026-06-30T23:40:00.000Z',
    };
  }

  test('replays March stale initiative into a durable proof-bound WorkItem', () => {
    const result = adapter.openWorkItemFromObservedSignal({
      type: 'initiative_proposed',
      initiativeId: 'initiative-1774310103-430c6d',
      title: 'Agency Layer: Wire initiative surfacing into session-start hook',
      status: 'proposed',
      createdAt: '2026-03-23T23:55:03.043Z',
    }, commonOptions());

    expect(result.status).toBe('created');
    expect(result.item).toEqual(expect.objectContaining({
      state: 'active',
      profile: 'main',
      riskClass: 'caution',
      ownerRoles: ['builder'],
      jamesCheckpoint: null,
      suggestedNextCommand: expect.stringContaining('proof-bound implementation slice'),
      observedSignal: expect.objectContaining({
        type: 'initiative_proposed',
        key: 'initiative_proposed:initiative-1774310103-430c6d',
        source: expect.objectContaining({
          id: 'initiative-1774310103-430c6d',
        }),
        status: 'proposed',
      }),
    }));
    expect(result.item.objective).toContain('Agency Layer: Wire initiative surfacing into session-start hook');
    expect(result.item.requiredProofs.map((proof) => proof.role)).toEqual(['builder_code', 'oracle_verify']);
    expect(result.item.sourceMessageIds).toContain('initiative-1774310103-430c6d');

    const status = ledger.statusWorkItems({}, commonOptions());
    expect(status.activeWorkItemId).toBe(result.item.id);
    expect(status.activeWorkReconciliation).toEqual(expect.objectContaining({
      authority: 'work_item',
      activeWorkItemId: result.item.id,
    }));
    const snapshot = ledger.deriveWorkItemCurrentLaneSnapshot(commonOptions());
    expect(snapshot.activeLane).toEqual(expect.objectContaining({
      workItemId: result.item.id,
      objective: expect.stringContaining('Agency Layer'),
      observedSignal: expect.objectContaining({ type: 'initiative_proposed' }),
    }));
  });

  test('replays truncation/materialization incident into a builder-owned regression WorkItem', () => {
    const result = adapter.openWorkItemFromObservedSignal({
      type: 'full_message_materialization',
      title: 'body-before-recall full-message materialization failure class',
      sourceFile: '.squidrun/coord/full-agent-messages/hm-long-inbound.txt',
      sourceMessageId: 'hm-long-inbound',
      commit: '3a06520a',
      description: 'Long inbound payload must be materialized and read before recall/context injection.',
    }, commonOptions());

    expect(result.status).toBe('created');
    expect(result.item.ownerRoles).toEqual(['builder']);
    expect(result.item.riskClass).toBe('caution');
    expect(result.item.jamesCheckpoint).toBeNull();
    expect(result.item.requiredProofs.map((proof) => proof.role)).toEqual([
      'builder_code',
      'builder_regression_test',
      'oracle_verify',
    ]);
    expect(result.item.observedSignal).toEqual(expect.objectContaining({
      type: 'full_message_materialization',
      source: expect.objectContaining({
        messageId: 'hm-long-inbound',
        file: '.squidrun/coord/full-agent-messages/hm-long-inbound.txt',
        commit: '3a06520a',
      }),
      suggestedNextCommand: expect.stringContaining('full-message materialization regression suite'),
    }));
    expect(result.item.suggestedNextCommand).toContain('full-message materialization regression suite');
    expect(result.item.sourceMessageIds).toEqual(expect.arrayContaining([
      'hm-long-inbound',
      'file:.squidrun/coord/full-agent-messages/hm-long-inbound.txt',
      'commit:3a06520a',
    ]));
  });

  test.each([
    ['repeated_user_correction', 'Extract the repeated correction'],
    ['memory_drift_detected', 'Compare memory claim'],
    ['empty_wake_queue_high_value_issue', 'Materialize the high-value issue'],
    ['failed_route_proof', 'Run hm-comms history'],
    ['test_failure', 'Reproduce the failing test'],
    ['full_message_clipping', 'clipped previews cannot become authority'],
    ['watchdog_intentional_autonomy_false_positive', 'Verify response-watchdog suppression'],
  ])('maps %s with owner, proof, evidence, and next command', (type, expectedCommandText) => {
    const mapped = adapter.mapObservedSignalToWorkItemInput({
      type,
      title: `${type} title`,
      sourceId: `${type}-source`,
      sourceRowId: '73324',
      sessionId: 'app-session-462',
    }, commonOptions());

    expect(mapped.workItemInput).toEqual(expect.objectContaining({
      riskClass: expect.stringMatching(/safe|caution/),
      observedSignal: expect.objectContaining({
        type,
        source: expect.objectContaining({
          id: `${type}-source`,
          rowId: '73324',
        }),
      }),
      suggestedNextCommand: expect.stringContaining(expectedCommandText),
      jamesCheckpoint: null,
    }));
    expect(mapped.workItemInput.ownerRoles.length).toBeGreaterThan(0);
    expect(mapped.workItemInput.requiredProof.length).toBeGreaterThan(0);
    expect(mapped.workItemInput.artifactRefs[0]).toEqual(expect.objectContaining({
      ref: `observed-signal:${mapped.signalKey}`,
      kind: 'observed_signal',
    }));
  });

  test.each([
    ['drift_detected', 'memory_drift_detected'],
    ['empty_wake_queue_high_value_issues', 'empty_wake_queue_high_value_issue'],
    ['route_proof_failed', 'failed_route_proof'],
    ['test_failed', 'test_failure'],
    ['message_truncation', 'full_message_clipping'],
    ['full_message_clipping_materialization', 'full_message_materialization'],
    ['watchdog_false_positive', 'watchdog_intentional_autonomy_false_positive'],
  ])('normalizes checklist alias %s to %s', (inputType, expectedType) => {
    const mapped = adapter.mapObservedSignalToWorkItemInput({
      type: inputType,
      sourceId: `${inputType}-source`,
    }, commonOptions());

    expect(mapped.signal.type).toBe(expectedType);
    expect(mapped.workItemInput.observedSignal.type).toBe(expectedType);
  });

  test('dedupes semantically repeated source signals without opening duplicate work', () => {
    const first = adapter.openWorkItemFromObservedSignal({
      type: 'failed_route_proof',
      sourceRowId: '73318',
      title: 'long proof packet recorded only',
    }, commonOptions());
    const second = adapter.openWorkItemFromObservedSignal({
      type: 'failed_route_proof',
      sourceRowId: '73318',
      title: 'same route proof failure with slightly different wording',
    }, {
      ...commonOptions(),
      now: '2026-06-30T23:41:00.000Z',
    });

    expect(first.status).toBe('created');
    expect(second.status).toBe('deduped');
    expect(second.item.id).toBe(first.item.id);
    const listed = ledger.listWorkItems(commonOptions());
    expect(listed.items).toHaveLength(1);
  });

  test('safe and caution signals do not require James, approval-required signals are held with a checkpoint', () => {
    const safe = adapter.mapObservedSignalToWorkItemInput({
      type: 'test_failure',
      riskClass: 'safe',
      sourceId: 'safe-test-failure',
    }, commonOptions());
    expect(safe.workItemInput.riskClass).toBe('safe');
    expect(safe.workItemInput.state).toBe('active');
    expect(safe.workItemInput.jamesCheckpoint).toBeNull();

    const approval = adapter.openWorkItemFromObservedSignal({
      type: 'approval_required_change',
      sourceId: 'prod-webhook-change',
      title: 'Change production webhook destination',
      checkpointReason: 'Production webhook mutation requires James approval.',
    }, commonOptions());

    expect(approval.status).toBe('held_for_james_checkpoint');
    expect(approval.item).toEqual(expect.objectContaining({
      state: 'blocked',
      riskClass: 'approval_required',
      jamesCheckpoint: {
        required: true,
        reason: 'Production webhook mutation requires James approval.',
        policy: 'approval_required',
      },
    }));
  });

  test('hm-work-item status surfaces the active observed-signal WorkItem as authority', () => {
    const opened = adapter.openWorkItemFromObservedSignal({
      type: 'watchdog_intentional_autonomy_false_positive',
      sourceRowId: '73276',
      title: 'No-response watchdog fired during intentional autonomy hold',
    }, commonOptions());
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      cli.main([
        'status',
        '--root', workItemRoot,
        '--session', 'app-session-462',
        '--profile', 'main',
        '--window', 'main',
        '--project-path', tempRoot,
        '--current-lane-path', currentLanePath,
      ]);
      const payload = JSON.parse(logSpy.mock.calls.at(-1)[0]);
      expect(payload.activeWorkItemId).toBe(opened.item.id);
      expect(payload.activeWorkReconciliation).toEqual(expect.objectContaining({
        authority: 'work_item',
        activeWorkItemId: opened.item.id,
      }));
      expect(payload.items[0]).toEqual(expect.objectContaining({
        observedSignal: expect.objectContaining({
          type: 'watchdog_intentional_autonomy_false_positive',
        }),
      }));
    } finally {
      logSpy.mockRestore();
    }
  });
});
