const fs = require('fs');
const os = require('os');
const path = require('path');

describe('codex-attention-bridge', () => {
  let tempRoot;
  let bridgeRoot;
  let workItemRoot;
  let bridge;
  let ledger;
  let cli;

  beforeEach(() => {
    jest.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-codex-attention-'));
    bridgeRoot = path.join(tempRoot, '.squidrun', 'runtime', 'codex-attention-bridge');
    workItemRoot = path.join(tempRoot, '.squidrun', 'runtime', 'work-items');
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
    bridge = require('../modules/main/codex-attention-bridge');
    ledger = require('../modules/main/work-item-ledger');
    cli = require('../scripts/hm-codex-attention');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.dontMock('../config');
  });

  test('creates durable Codex attention requests and bridges to work-item visual packets', () => {
    ledger.openWorkItem({
      id: 'wi-needs-eyes',
      session: 'app-session-389',
      profile: 'main',
      window: 'main',
      projectName: 'squidrun',
      projectPath: tempRoot,
      objective: 'Need Codex visual proof',
      ownerRoles: ['builder'],
      requiredProof: ['builder_code', 'codex_browser'],
    }, {
      workItemRoot,
      now: '2026-05-30T22:30:00.000Z',
    });

    const created = bridge.createCodexAttentionRequest({
      id: 'codex-queue-1',
      work_item_id: 'wi-needs-eyes',
      requested_by: 'architect',
      reason: 'Check Task Audit preview in browser',
      url: 'http://127.0.0.1:8787/task-audit-preview',
      checklist: ['preview label visible', 'no horizontal overflow'],
      proof_role: 'codex_browser',
      priority: 'high',
      correlation_id: 'codex-proof-1',
      requested_artifact_refs: ['screenshot', 'console'],
      no_side_effect_caps: ['GET only', 'no writes'],
    }, {
      bridgeRoot,
      workItemRoot,
      now: '2026-05-30T22:31:00.000Z',
    });

    expect(created).toEqual(expect.objectContaining({
      ok: true,
      request: expect.objectContaining({
        schema: bridge.REQUEST_SCHEMA,
        id: 'codex-queue-1',
        work_item_id: 'wi-needs-eyes',
        requested_by: 'architect',
        proof_role: 'codex_browser',
        priority: 'high',
        status: 'requested',
        correlation_id: 'codex-proof-1',
        checklist: ['preview label visible', 'no horizontal overflow'],
        visual_request: expect.objectContaining({
          status: 'requested',
          id: 'codex-proof-1',
          expected_response_schema: ledger.CODEX_VISUAL_RESPONSE_SCHEMA,
        }),
      }),
    }));
    expect(fs.existsSync(created.request_path)).toBe(true);
    expect(fs.existsSync(path.join(bridgeRoot, 'index.json'))).toBe(true);
    expect(fs.existsSync(created.request.visual_request.path)).toBe(true);

    const workItem = ledger.loadWorkItem('wi-needs-eyes', { workItemRoot }).item;
    expect(workItem.state).toBe('waiting_codex_visual');
    expect(workItem.visualRequests).toEqual([
      expect.objectContaining({
        id: 'codex-proof-1',
        status: 'requested',
      }),
    ]);
  });

  test('listing is read-only and preserves active requests until completion', () => {
    bridge.createCodexAttentionRequest({
      id: 'codex-queue-readonly',
      requested_by: 'builder',
      reason: 'Inspect a local window',
      window: 'main',
      priority: 'normal',
    }, {
      bridgeRoot,
      now: '2026-05-30T22:32:00.000Z',
    });
    const requestPath = bridge.resolveRequestPath('codex-queue-readonly', { bridgeRoot });
    const before = fs.readFileSync(requestPath, 'utf8');

    const listed = bridge.listCodexAttentionRequests({}, { bridgeRoot });
    const after = fs.readFileSync(requestPath, 'utf8');

    expect(listed).toEqual(expect.objectContaining({
      ok: true,
      active_request_ids: ['codex-queue-readonly'],
      active_count: 1,
      request_count: 1,
      requests: [
        expect.objectContaining({
          id: 'codex-queue-readonly',
          status: 'requested',
          target: expect.objectContaining({ window_key: 'main' }),
        }),
      ],
    }));
    expect(after).toBe(before);
  });

  test('ack and complete record lifecycle and attach Codex proof to the work item', () => {
    ledger.openWorkItem({
      id: 'wi-proof-target',
      session: 'app-session-389',
      profile: 'main',
      window: 'main',
      objective: 'Need Codex completion',
      ownerRoles: ['builder'],
      requiredProof: ['codex_browser'],
    }, {
      workItemRoot,
      now: '2026-05-30T22:33:00.000Z',
    });
    bridge.createCodexAttentionRequest({
      id: 'codex-queue-complete',
      work_item_id: 'wi-proof-target',
      requested_by: 'oracle',
      reason: 'Verify preview pass',
      route: '/task-audit-preview',
      checklist: ['Active and Future separated'],
      correlation_id: 'codex-proof-complete',
    }, {
      bridgeRoot,
      workItemRoot,
      now: '2026-05-30T22:34:00.000Z',
    });

    const acked = bridge.ackCodexAttentionRequest({
      id: 'codex-queue-complete',
      acknowledged_by: 'codex',
    }, {
      bridgeRoot,
      now: '2026-05-30T22:35:00.000Z',
    });

    expect(acked.request).toEqual(expect.objectContaining({
      status: 'acknowledged',
      acknowledged_by: 'codex',
      acknowledged_at: '2026-05-30T22:35:00.000Z',
    }));

    const completed = bridge.completeCodexAttentionRequest({
      id: 'codex-queue-complete',
      completed_by: 'codex',
      result: 'pass',
      proof_ref: 'codex-browser-proof:preview-pass',
      summary: 'Codex browser proof passed',
      notes: 'No side effects observed',
    }, {
      bridgeRoot,
      workItemRoot,
      now: '2026-05-30T22:36:00.000Z',
    });

    expect(completed).toEqual(expect.objectContaining({
      ok: true,
      request: expect.objectContaining({
        status: 'completed',
        completion: expect.objectContaining({
          result: 'pass',
          work_item_proof_attached: true,
        }),
      }),
      completion: expect.objectContaining({
        schema: bridge.COMPLETION_SCHEMA,
        request_id: 'codex-queue-complete',
        work_item_id: 'wi-proof-target',
        result: 'pass',
        expected_codex_response_schema: ledger.CODEX_VISUAL_RESPONSE_SCHEMA,
      }),
      work_item_proof: expect.objectContaining({ ok: true }),
    }));
    expect(fs.existsSync(completed.completion_path)).toBe(true);

    const workItem = ledger.loadWorkItem('wi-proof-target', { workItemRoot }).item;
    expect(workItem.proofs.find((proof) => proof.role === 'codex_browser')).toEqual(expect.objectContaining({
      artifact: expect.objectContaining({
        ref: 'codex-browser-proof:preview-pass',
      }),
      metadata: expect.objectContaining({
        codexAttentionBridge: expect.objectContaining({
          request_id: 'codex-queue-complete',
          correlation_id: 'codex-proof-complete',
          result: 'pass',
        }),
        codexVisual: expect.objectContaining({
          requestId: 'codex-proof-complete',
          expectedResponseSchema: ledger.CODEX_VISUAL_RESPONSE_SCHEMA,
        }),
      }),
    }));

    const active = bridge.listCodexAttentionRequests({}, { bridgeRoot });
    const all = bridge.listCodexAttentionRequests({ all: true }, { bridgeRoot });
    expect(active.active_count).toBe(0);
    expect(active.requests).toEqual([]);
    expect(all.requests.map((request) => request.id)).toEqual(['codex-queue-complete']);
  });

  test('CLI emits deterministic JSON for create/list/ack/complete', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(cli.main([
        'create',
        '--bridge-root', bridgeRoot,
        '--id', 'codex-cli',
        '--requested-by', 'architect',
        '--reason', 'CLI eyes',
        '--url', 'http://127.0.0.1:8787/task-audit-preview',
        '--check', 'preview visible',
        '--priority', 'urgent',
        '--now', '2026-05-30T22:37:00.000Z',
      ])).toBe(0);
      expect(JSON.parse(logSpy.mock.calls.at(-1)[0])).toEqual(expect.objectContaining({
        ok: true,
        request: expect.objectContaining({
          id: 'codex-cli',
          requested_by: 'architect',
          priority: 'urgent',
          checklist: ['preview visible'],
        }),
      }));

      expect(cli.main(['list', '--bridge-root', bridgeRoot])).toBe(0);
      expect(JSON.parse(logSpy.mock.calls.at(-1)[0])).toEqual(expect.objectContaining({
        active_request_ids: ['codex-cli'],
        active_count: 1,
      }));

      expect(cli.main([
        'ack',
        '--bridge-root', bridgeRoot,
        '--id', 'codex-cli',
        '--by', 'codex',
        '--now', '2026-05-30T22:38:00.000Z',
      ])).toBe(0);
      expect(JSON.parse(logSpy.mock.calls.at(-1)[0]).request.status).toBe('acknowledged');

      expect(cli.main([
        'complete',
        '--bridge-root', bridgeRoot,
        '--id', 'codex-cli',
        '--result', 'blocked',
        '--proof-ref', 'codex-cli:blocker',
        '--summary', 'Browser unavailable',
        '--no-attach-work-item-proof',
        '--now', '2026-05-30T22:39:00.000Z',
      ])).toBe(0);
      expect(JSON.parse(logSpy.mock.calls.at(-1)[0])).toEqual(expect.objectContaining({
        request: expect.objectContaining({
          status: 'blocked',
          completion: expect.objectContaining({
            result: 'blocked',
          }),
        }),
      }));
    } finally {
      logSpy.mockRestore();
    }
  });
});
