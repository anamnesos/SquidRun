const fs = require('fs');
const os = require('os');
const path = require('path');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

describe('work-item-ledger', () => {
  let tempRoot;
  let workItemRoot;
  let ledger;
  let cli;

  beforeEach(() => {
    jest.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-work-item-'));
    workItemRoot = path.join(tempRoot, 'runtime', 'work-items');
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
    ledger = require('../modules/main/work-item-ledger');
    cli = require('../scripts/hm-work-item');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.dontMock('../config');
  });

  test('opens typed work items, requests Codex visual packets, attaches proof, and blocks fake closure', () => {
    const opened = ledger.openWorkItem({
      id: 'wi-test-platform',
      session: 'app-session-501',
      profile: 'main',
      window: 'main',
      projectName: 'squidrun',
      projectPath: tempRoot,
      sourceMessageIds: ['architect#95'],
      objective: 'Implement proof-bound work items v0',
      ownerRoles: ['builder'],
      scopeIn: ['SquidRun platform plumbing'],
      scopeOut: ['TrustQuote product code'],
      sideEffectCaps: ['no_deploy', 'no_customer_send'],
      riskClass: 'caution',
      prodGateProfile: 'local_no_effects',
      routeHealthRequirement: { required: true, profile: 'trustquote' },
      requiredProof: ['builder_code', 'oracle_verify', 'codex_browser', 'prod_gate'],
    }, {
      workItemRoot,
      now: '2026-05-30T09:00:00.000Z',
    });

    expect(opened.item).toEqual(expect.objectContaining({
      schema: ledger.WORK_ITEM_SCHEMA,
      id: 'wi-test-platform',
      state: 'active',
      objective: 'Implement proof-bound work items v0',
      riskClass: 'caution',
      prodGateProfile: 'local_no_effects',
      sourceMessageIds: ['architect#95'],
      ownerRoles: ['builder'],
      sideEffectCaps: ['no_deploy', 'no_customer_send'],
      proofState: expect.objectContaining({
        complete: false,
        missingRoles: ['builder_code', 'oracle_verify', 'codex_browser', 'prod_gate'],
      }),
    }));
    expect(fs.existsSync(path.join(workItemRoot, 'wi-test-platform.json'))).toBe(true);
    expect(fs.existsSync(path.join(workItemRoot, 'index.json'))).toBe(true);

    const visual = ledger.requestCodexVisual({
      id: 'wi-test-platform',
      route: '/dashboard',
      viewport: ['desktop:1440x900', 'mobile:390x844'],
      invariant: ['dashboard rows visible', 'no horizontal overflow'],
      consoleExpectation: 'no new errors',
      devBadgeExpectation: 'not visible',
      overflowExpectation: 'scrollWidth equals clientWidth',
      noSideEffectCaps: ['no POST', 'no writes'],
      requestedArtifactRefs: ['screenshot', 'trace', 'console'],
    }, {
      workItemRoot,
      now: '2026-05-30T09:01:00.000Z',
    });

    expect(visual.visualRequest).toEqual(expect.objectContaining({
      schema: ledger.CODEX_VISUAL_REQUEST_SCHEMA,
      workItemId: 'wi-test-platform',
      route: '/dashboard',
      url: null,
      viewportMatrix: [
        { name: 'desktop', width: 1440, height: 900 },
        { name: 'mobile', width: 390, height: 844 },
      ],
      invariants: ['dashboard rows visible', 'no horizontal overflow'],
      expectations: {
        console: 'no new errors',
        devBadge: 'not visible',
        overflow: 'scrollWidth equals clientWidth',
      },
      noSideEffectCaps: ['no POST', 'no writes'],
      requestedArtifactRefs: ['screenshot', 'trace', 'console'],
    }));
    expect(visual.visualRequest.expectedCodexResponse).toEqual(expect.objectContaining({
      schema: ledger.CODEX_VISUAL_RESPONSE_SCHEMA,
      requestId: visual.visualRequest.id,
      workItemId: 'wi-test-platform',
      route: '/dashboard',
      result: 'pass|fail|blocked',
      noSideEffectsObserved: true,
      viewportResults: [
        expect.objectContaining({
          name: 'desktop',
          console: { errors: [], warnings: [] },
          devBadge: expect.objectContaining({ visible: false }),
          overflow: expect.objectContaining({ horizontal: false }),
        }),
        expect.objectContaining({ name: 'mobile' }),
      ],
    }));
    expect(visual.visualRequest.attachProofShape).toEqual(expect.objectContaining({
      command: 'hm-work-item attach-proof',
      role: 'codex_browser',
      example: expect.objectContaining({
        visualRequestId: visual.visualRequest.id,
        responseRef: `${visual.visualRequest.id}:response-json`,
      }),
    }));
    expect(fs.existsSync(visual.visualRequestPath)).toBe(true);
    expect(visual.item.state).toBe('waiting_codex_visual');

    const fakeClose = ledger.closeWorkItem({
      id: 'wi-test-platform',
      verdict: 'passed',
      reason: 'trying to close without proof',
    }, {
      workItemRoot,
      now: '2026-05-30T09:02:00.000Z',
    });
    expect(fakeClose).toEqual(expect.objectContaining({
      ok: false,
      reason: 'missing_required_proofs',
      missingRequiredProofs: ['builder_code', 'oracle_verify', 'codex_browser', 'prod_gate'],
    }));

    const blocked = ledger.closeWorkItem({
      id: 'wi-test-platform',
      verdict: 'blocked',
      reason: 'Codex browser proof still missing',
    }, {
      workItemRoot,
      now: '2026-05-30T09:03:00.000Z',
    });
    expect(blocked).toEqual(expect.objectContaining({
      ok: true,
      closed: false,
      item: expect.objectContaining({
        state: 'blocked',
        verdict: 'blocked',
      }),
    }));

    for (const role of ['builder_code', 'oracle_verify', 'prod_gate']) {
      const attached = ledger.attachProof({
        id: 'wi-test-platform',
        role,
        ref: `${role}:artifact`,
        hash: `sha256:${role}`,
        summary: `${role} proof`,
      }, {
        workItemRoot,
        now: '2026-05-30T09:04:00.000Z',
      });
      expect(attached.ok).toBe(true);
    }
    const codexAttached = ledger.attachProof({
      id: 'wi-test-platform',
      role: 'codex_browser',
      ref: 'codex_browser:artifact',
      hash: 'sha256:codex_browser',
      summary: 'codex_browser proof',
      visualRequestId: visual.visualRequest.id,
      responseRef: `${visual.visualRequest.id}:response-json`,
      responseHash: 'sha256:codex-response',
      responseSummary: 'Codex visual response JSON',
    }, {
      workItemRoot,
      now: '2026-05-30T09:04:30.000Z',
    });
    expect(codexAttached.ok).toBe(true);
    expect(codexAttached.item.proofs.find((proof) => proof.role === 'codex_browser')).toEqual(expect.objectContaining({
      metadata: {
        codexVisual: expect.objectContaining({
          requestId: visual.visualRequest.id,
          requestPath: visual.visualRequestPath,
          expectedResponseSchema: ledger.CODEX_VISUAL_RESPONSE_SCHEMA,
          responseArtifact: expect.objectContaining({
            ref: `${visual.visualRequest.id}:response-json`,
            hash: 'sha256:codex-response',
          }),
        }),
      },
    }));
    expect(codexAttached.item.visualRequests.find((request) => request.id === visual.visualRequest.id)).toEqual(expect.objectContaining({
      status: 'proof_attached',
      responseRef: `${visual.visualRequest.id}:response-json`,
      responseHash: 'sha256:codex-response',
    }));

    const closed = ledger.closeWorkItem({
      id: 'wi-test-platform',
      verdict: 'passed',
      reason: 'all required proofs attached',
    }, {
      workItemRoot,
      now: '2026-05-30T09:05:00.000Z',
    });
    expect(closed).toEqual(expect.objectContaining({
      ok: true,
      closed: true,
      missingRequiredProofs: [],
      item: expect.objectContaining({
        state: 'closed',
        verdict: 'passed',
        proofState: expect.objectContaining({
          complete: true,
          presentRoles: ['builder_code', 'codex_browser', 'oracle_verify', 'prod_gate'],
        }),
      }),
    }));
  });

  test('CLI emits deterministic JSON for open/status/attach-proof/request-codex-visual/close', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      expect(cli.main([
        'open',
        '--work-item-root', workItemRoot,
        '--id', 'wi-cli',
        '--session', 'app-session-502',
        '--objective', 'CLI item',
        '--owner-role', 'builder',
        '--required-proof', 'builder_code',
        '--now', '2026-05-30T10:00:00.000Z',
      ])).toBe(0);
      expect(JSON.parse(logSpy.mock.calls.at(-1)[0])).toEqual(expect.objectContaining({
        ok: true,
        item: expect.objectContaining({
          id: 'wi-cli',
          objective: 'CLI item',
          requiredProofs: [{ role: 'builder_code', required: true }],
        }),
      }));

      expect(cli.main([
        'status',
        '--work-item-root', workItemRoot,
        '--id', 'wi-cli',
      ])).toBe(0);
      expect(JSON.parse(logSpy.mock.calls.at(-1)[0])).toEqual(expect.objectContaining({
        ok: true,
        item: expect.objectContaining({ id: 'wi-cli' }),
      }));

      expect(cli.main([
        'request-codex-visual',
        '--work-item-root', workItemRoot,
        '--id', 'wi-cli',
        '--route', '/calendar',
        '--viewport', 'mobile:390x844',
        '--invariant', 'no overlap',
        '--requested-artifact', 'screenshot',
        '--now', '2026-05-30T10:01:00.000Z',
      ])).toBe(0);
      const visualPacket = JSON.parse(logSpy.mock.calls.at(-1)[0]);
      expect(visualPacket).toEqual(expect.objectContaining({
        ok: true,
        visualRequest: expect.objectContaining({
          route: '/calendar',
          viewportMatrix: [{ name: 'mobile', width: 390, height: 844 }],
          expectedCodexResponse: expect.objectContaining({
            workItemId: 'wi-cli',
            result: 'pass|fail|blocked',
            noSideEffectsObserved: true,
          }),
        }),
      }));

      expect(cli.main([
        'close',
        '--work-item-root', workItemRoot,
        '--id', 'wi-cli',
        '--verdict', 'passed',
        '--reason', 'missing proof',
      ])).toBe(1);
      expect(JSON.parse(logSpy.mock.calls.at(-1)[0])).toEqual(expect.objectContaining({
        ok: false,
        reason: 'missing_required_proofs',
      }));

      expect(cli.main([
        'attach-proof',
        '--work-item-root', workItemRoot,
        '--id', 'wi-cli',
        '--role', 'builder_code',
        '--ref', 'jest:work-item-ledger',
        '--hash', 'sha256:abc123',
        '--summary', 'Focused Jest passed',
        '--now', '2026-05-30T10:02:00.000Z',
      ])).toBe(0);

      expect(cli.main([
        'close',
        '--work-item-root', workItemRoot,
        '--id', 'wi-cli',
        '--verdict', 'passed',
        '--reason', 'proof attached',
        '--now', '2026-05-30T10:03:00.000Z',
      ])).toBe(0);
      expect(JSON.parse(logSpy.mock.calls.at(-1)[0])).toEqual(expect.objectContaining({
        ok: true,
        closed: true,
        item: expect.objectContaining({
          state: 'closed',
          verdict: 'passed',
        }),
      }));
    } finally {
      logSpy.mockRestore();
    }
  });

  test('deriveWorkItemCurrentLaneSnapshot exposes the latest typed active item', () => {
    ledger.openWorkItem({
      id: 'wi-current',
      session: 'app-session-503',
      profile: 'main',
      window: 'main',
      objective: 'Typed current lane',
      ownerRoles: ['builder'],
      requiredProof: ['builder_code'],
    }, {
      workItemRoot,
      now: '2026-05-30T11:00:00.000Z',
    });

    const snapshot = ledger.deriveWorkItemCurrentLaneSnapshot({
      workItemRoot,
      sessionId: 'app-session-503',
      profileName: 'main',
      windowKey: 'main',
      nowMs: Date.parse('2026-05-30T11:01:00.000Z'),
    });

    expect(snapshot).toEqual(expect.objectContaining({
      source: 'work_item',
      status: 'active',
      activeLane: expect.objectContaining({
        workItemId: 'wi-current',
        objective: 'Typed current lane',
        kind: 'proof_bound_work_item',
        proofState: expect.objectContaining({
          missingRoles: ['builder_code'],
        }),
      }),
    }));
  });

  test('listWorkItems rebuilds from item files and surfaces broken index state', () => {
    ledger.openWorkItem({
      id: 'wi-broken-index-active',
      session: 'app-session-503',
      profile: 'main',
      window: 'main',
      objective: 'Do not hide active typed work',
      ownerRoles: ['builder'],
      requiredProof: ['builder_code'],
    }, {
      workItemRoot,
      now: '2026-05-30T11:00:00.000Z',
    });
    fs.writeFileSync(path.join(workItemRoot, 'index.json'), '{"items": [');

    const listed = ledger.listWorkItems({ workItemRoot });

    expect(listed).toEqual(expect.objectContaining({
      ok: true,
      activeWorkItemId: 'wi-broken-index-active',
      indexStatus: 'rebuilt_from_broken_index',
      brokenState: expect.objectContaining({
        code: 'BROKEN_JSON_STATE',
        reason: 'work_item_index_parse_error',
      }),
      staleMarkers: expect.arrayContaining([
        'work_item_index_parse_error',
        'work_item_index_rebuilt_from_item_files',
      ]),
      items: [
        expect.objectContaining({
          id: 'wi-broken-index-active',
          state: 'active',
          objective: 'Do not hide active typed work',
        }),
      ],
    }));
  });

  test('status carries broken index and broken queue markers instead of silently emptying stores', () => {
    const queuePath = path.join(tempRoot, 'runtime', 'agent-task-queue.json');
    ledger.openWorkItem({
      id: 'wi-broken-store-active',
      session: 'app-session-503',
      profile: 'main',
      window: 'main',
      objective: 'Surface broken store markers',
      ownerRoles: ['builder'],
      requiredProof: ['builder_code'],
    }, {
      workItemRoot,
      now: '2026-05-30T11:00:00.000Z',
    });
    fs.writeFileSync(path.join(workItemRoot, 'index.json'), '{"items": [');
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    fs.writeFileSync(queuePath, '{"agents": { "builder": ');

    const status = ledger.statusWorkItems({}, {
      workItemRoot,
      queuePath,
      sessionId: 'app-session-503',
      profileName: 'main',
      windowKey: 'main',
      now: '2026-05-30T11:01:00.000Z',
    });

    expect(status.activeWorkItemId).toBe('wi-broken-store-active');
    expect(status.activeWorkReconciliation).toEqual(expect.objectContaining({
      status: 'STALE',
      activeWorkItemId: 'wi-broken-store-active',
      staleMarkers: expect.arrayContaining([
        'work_item_index_parse_error',
        'work_item_index_rebuilt_from_item_files',
        'typed_work_item_index_broken:work_item_index_parse_error',
        'agent_task_queue_broken:agent_task_queue_parse_error',
      ]),
    }));
  });

  test('openWorkItem preserves a malformed index before replacing it', () => {
    fs.mkdirSync(workItemRoot, { recursive: true });
    const indexPath = path.join(workItemRoot, 'index.json');
    fs.writeFileSync(indexPath, '{"items": [');

    const opened = ledger.openWorkItem({
      id: 'wi-preserve-broken-index',
      session: 'app-session-503',
      profile: 'main',
      window: 'main',
      objective: 'Preserve broken index before rewrite',
      ownerRoles: ['builder'],
    }, {
      workItemRoot,
      now: '2026-05-30T11:00:00.000Z',
    });

    expect(opened.index.preservedBrokenState).toEqual(expect.objectContaining({
      store: 'work_item_index',
      reason: 'work_item_index_parse_error',
      backupPath: expect.stringContaining('index.json.broken-'),
    }));
    expect(fs.readFileSync(opened.index.preservedBrokenState.backupPath, 'utf8')).toBe('{"items": [');
    expect(JSON.parse(fs.readFileSync(indexPath, 'utf8')).activeWorkItemId).toBe('wi-preserve-broken-index');
  });

  test('status exposes typed authority plus inspectable queue and current-lane divergence', () => {
    const queuePath = path.join(tempRoot, 'runtime', 'agent-task-queue.json');
    const currentLanePath = path.join(tempRoot, 'handoffs', 'current-lane.json');
    ledger.openWorkItem({
      id: 'wi-authority-a',
      session: 'app-session-504',
      profile: 'main',
      window: 'main',
      objective: 'Typed authority A',
      ownerRoles: ['builder'],
      requiredProof: ['builder_code'],
    }, {
      workItemRoot,
      now: '2026-05-30T12:00:00.000Z',
    });
    writeJson(queuePath, {
      agents: {
        builder: {
          active: {
            taskId: 'wi-losing-queue-b',
            title: 'Queue losing active B',
            state: 'active',
            source: 'agent-task-queue',
            updatedAt: '2026-05-30T12:01:00.000Z',
          },
        },
      },
    });
    writeJson(currentLanePath, {
      source: 'comms_journal',
      status: 'active',
      activeLane: {
        laneId: 'wi-losing-current-lane-b',
        objective: 'Current-lane losing active B',
        kind: 'current_session_task',
        sourceRef: 'wi-losing-current-lane-b',
        sourceMessageId: 'architect#90',
      },
    });

    const status = ledger.statusWorkItems({}, {
      workItemRoot,
      queuePath,
      currentLanePath,
      sessionId: 'app-session-504',
      profileName: 'main',
      windowKey: 'main',
      now: '2026-05-30T12:02:00.000Z',
    });

    expect(status.activeWorkReconciliation).toEqual(expect.objectContaining({
      schema: ledger.ACTIVE_WORK_RECONCILIATION_SCHEMA,
      status: 'CONFLICT',
      authority: 'work_item',
      chosenAuthority: 'work_item',
      activeWorkItemId: 'wi-authority-a',
      queueActiveIds: ['builder:wi-losing-queue-b'],
      conflictMarkers: expect.arrayContaining([
        'queue_active_conflicts_with_work_item:builder:wi-losing-queue-b',
        'current_lane_conflicts_with_work_item:wi-losing-current-lane-b',
      ]),
      conflictingStores: expect.arrayContaining([
        expect.objectContaining({
          store: 'agent-task-queue',
          id: 'builder:wi-losing-queue-b',
          activeId: 'wi-losing-queue-b',
          conflictWithWorkItemId: 'wi-authority-a',
          active: expect.objectContaining({
            taskId: 'wi-losing-queue-b',
            title: 'Queue losing active B',
          }),
        }),
        expect.objectContaining({
          store: 'current-lane',
          id: 'wi-losing-current-lane-b',
          activeId: 'wi-losing-current-lane-b',
          conflictWithWorkItemId: 'wi-authority-a',
          active: expect.objectContaining({
            objective: 'Current-lane losing active B',
            sourceMessageId: 'architect#90',
          }),
        }),
      ]),
    }));
  });

  test('status treats matching comms current-lane and typed work item as agreement', () => {
    const currentLanePath = path.join(tempRoot, 'handoffs', 'current-lane.json');
    ledger.openWorkItem({
      id: 'task-audit-source-of-truth-391',
      session: 'app-session-391',
      profile: 'main',
      window: 'main',
      objective: 'Make Task Audit the mandatory SquidRun source-of-truth window: Needs Doing from evidence/history, Audit/Cleanup for messes and uncertain deletions, History for closed work with what happened and why.',
      ownerRoles: ['builder', 'oracle'],
      requiredProof: ['builder_code'],
    }, {
      workItemRoot,
      now: '2026-05-31T18:57:07.480Z',
    });
    writeJson(currentLanePath, {
      source: 'comms_journal',
      status: 'active',
      generatedAt: '2026-05-31T18:56:38.952Z',
      sessionId: 'app-session-391',
      activeLane: {
        laneId: 'app-session-391:architect-11:hm-1780253791855-v96e7k',
        sourceRef: 'architect#11',
        sourceMessageId: 'hm-1780253791855-v96e7k',
        objective: 'Make Task Audit the mandatory source-of-truth window for SquidRun: fill Needs Doing from current/history evidence, identify UI messes/disabled or unnecessary surfaces, add a simple History tab for closed work with what happened and why, and use this window to straighten active/cleanup truth.',
        kind: 'current_lane_tasking',
        status: 'active',
        ownerRoles: ['builder'],
      },
    });

    const status = ledger.statusWorkItems({}, {
      workItemRoot,
      currentLanePath,
      sessionId: 'app-session-391',
      profileName: 'main',
      windowKey: 'main',
      now: '2026-05-31T18:58:00.000Z',
    });

    expect(status.activeWorkReconciliation).toEqual(expect.objectContaining({
      status: 'OK',
      authority: 'work_item',
      activeWorkItemId: 'task-audit-source-of-truth-391',
      conflictMarkers: [],
      staleMarkers: [],
      warnings: [],
    }));
  });

  test('status reports both queue and current-lane stale markers when no typed work item is active', () => {
    const queuePath = path.join(tempRoot, 'runtime', 'agent-task-queue.json');
    const currentLanePath = path.join(tempRoot, 'handoffs', 'current-lane.json');
    writeJson(queuePath, {
      agents: {
        builder: {
          active: {
            taskId: 'queue-only-active',
            title: 'Queue-only active work',
            state: 'active',
          },
        },
      },
    });
    writeJson(currentLanePath, {
      source: 'comms_journal',
      status: 'active',
      activeLane: {
        laneId: 'current-lane-only-active',
        objective: 'Current-lane-only active work',
        kind: 'current_session_task',
        sourceRef: 'architect#107',
      },
    });

    const status = ledger.statusWorkItems({}, {
      workItemRoot,
      queuePath,
      currentLanePath,
      sessionId: 'app-session-505',
      profileName: 'main',
      windowKey: 'main',
      now: '2026-05-30T13:00:00.000Z',
    });

    expect(status.activeWorkReconciliation).toEqual(expect.objectContaining({
      status: 'STALE',
      authority: 'current_lane',
      chosenAuthority: 'current_lane',
      activeWorkItemId: null,
      queueActiveIds: ['builder:queue-only-active'],
      currentLaneActive: expect.objectContaining({
        activeLane: expect.objectContaining({
          laneId: 'current-lane-only-active',
          objective: 'Current-lane-only active work',
        }),
      }),
      staleMarkers: [
        'no_typed_active_work_item_queue_active',
        'no_typed_active_work_item_current_lane_active',
      ],
      conflictingStores: [],
    }));
  });
});
