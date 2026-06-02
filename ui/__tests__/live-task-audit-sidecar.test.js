const fs = require('fs');
const os = require('os');
const path = require('path');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

describe('live-task-audit-sidecar', () => {
  let tempRoot;
  let workItemRoot;
  let taskAuditItemsPath;
  let currentLanePath;
  let queuePath;
  let ledger;
  let sidecar;

  beforeEach(() => {
    jest.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-task-audit-sidecar-'));
    workItemRoot = path.join(tempRoot, '.squidrun', 'runtime', 'work-items');
    taskAuditItemsPath = path.join(tempRoot, '.squidrun', 'runtime', 'live-task-audit-sidecar', 'task-audit-items.json');
    currentLanePath = path.join(tempRoot, '.squidrun', 'handoffs', 'current-lane.json');
    queuePath = path.join(tempRoot, '.squidrun', 'runtime', 'agent-task-queue.json');
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
    sidecar = require('../modules/main/live-task-audit-sidecar');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.dontMock('../config');
  });

  test('separates typed active work items from manual audit items', () => {
    ledger.openWorkItem({
      id: 'wi-sidecar-active',
      session: 'app-session-389',
      profile: 'main',
      window: 'main',
      projectName: 'squidrun',
      projectPath: tempRoot,
      sourceMessageIds: ['architect#149'],
      objective: 'Build the live task audit sidecar',
      ownerRoles: ['builder'],
      requiredProof: ['builder_code', 'oracle_verify'],
    }, {
      workItemRoot,
      now: '2026-05-30T18:00:00.000Z',
    });
    writeJson(taskAuditItemsPath, {
      items: [{
        id: 'debt-mobile-dev-badge',
        title: 'Review mobile loading/dev-badge flags',
        status: 'deferred',
        kind: 'browser_cleanup',
        ownerRoles: ['codex'],
        sessionId: 'app-session-389',
        updatedAt: '2026-05-30T18:01:00.000Z',
        sourceRef: 'architect#129',
      }],
    });

    const snapshot = sidecar.buildLiveTaskAuditSnapshot({
      workItemRoot,
      taskAuditItemsPath,
      now: '2026-05-30T18:02:00.000Z',
    });

    expect(snapshot).toEqual(expect.objectContaining({
      schema: sidecar.SNAPSHOT_SCHEMA,
      session: { id: 'app-session-389', number: 389 },
    }));
    expect(snapshot.active.items).toHaveLength(1);
    expect(snapshot.active.items[0]).toEqual(expect.objectContaining({
      id: 'wi-sidecar-active',
      title: 'Build the live task audit sidecar',
      ownerRoles: ['builder'],
      sessionNumber: 389,
      source: expect.objectContaining({ kind: 'work_item', label: 'architect#149' }),
      proofState: expect.objectContaining({
        missingRoles: ['builder_code', 'oracle_verify'],
      }),
    }));
    expect(snapshot.future.items).toEqual([
      expect.objectContaining({
        id: 'debt-mobile-dev-badge',
        title: 'Review mobile loading/dev-badge flags',
        kind: 'browser_cleanup',
        sessionNumber: 389,
        section: 'SquidRun',
      }),
    ]);
    expect(snapshot.active.items.map((item) => item.title)).not.toContain('Review mobile loading/dev-badge flags');
    expect(snapshot.future.items.map((item) => item.title)).not.toContain('Build the live task audit sidecar');
  });

  test('adds closed work items to History with what happened and why', () => {
    ledger.openWorkItem({
      id: 'wi-sidecar-history',
      session: 'app-session-390',
      profile: 'main',
      window: 'main',
      projectName: 'squidrun',
      projectPath: tempRoot,
      sourceMessageIds: ['architect#88'],
      objective: 'Close a finished Task Audit cleanup lane',
      ownerRoles: ['builder', 'oracle'],
      requiredProof: ['builder_code'],
    }, {
      workItemRoot,
      now: '2026-05-30T19:00:00.000Z',
    });
    ledger.attachProof({
      id: 'wi-sidecar-history',
      role: 'builder_code',
      ref: 'jest:history-proof',
      hash: 'sha256:history',
      summary: 'History proof attached',
    }, {
      workItemRoot,
      now: '2026-05-30T19:01:00.000Z',
    });
    ledger.closeWorkItem({
      id: 'wi-sidecar-history',
      verdict: 'passed',
      reason: 'Cleanup finished and proof attached.',
    }, {
      workItemRoot,
      now: '2026-05-30T19:02:00.000Z',
    });

    const snapshot = sidecar.buildLiveTaskAuditSnapshot({
      workItemRoot,
      now: '2026-05-30T19:03:00.000Z',
    });

    expect(snapshot.history.items).toEqual([
      expect.objectContaining({
        id: 'wi-sidecar-history',
        title: 'Close a finished Task Audit cleanup lane',
        verdict: 'passed',
        section: 'SquidRun',
        closedAt: '2026-05-30T19:02:00.000Z',
        whatHappened: 'Cleanup finished and proof attached.',
        why: 'Proof: 1/1 roles present.',
        source: expect.objectContaining({ kind: 'work_item_history', label: 'architect#88' }),
      }),
    ]);
    expect(snapshot.active.items.map((item) => item.id)).not.toContain('wi-sidecar-history');
    expect(snapshot.future.items.map((item) => item.id)).not.toContain('wi-sidecar-history');
  });

  test('surfaces source-truth risk rows in Needs Doing without changing work-item authority', () => {
    ledger.openWorkItem({
      id: 'wi-sidecar-current',
      session: 'app-session-391',
      profile: 'main',
      window: 'main',
      projectName: 'squidrun',
      projectPath: tempRoot,
      sourceMessageIds: ['architect#11'],
      objective: 'Make Task Audit the mandatory source-of-truth window',
      ownerRoles: ['builder', 'oracle'],
      requiredProof: ['builder_code', 'oracle_verify', 'codex_browser'],
    }, {
      workItemRoot,
      now: '2026-05-31T19:00:00.000Z',
    });
    writeJson(taskAuditItemsPath, {
      items: [
        {
          id: 'restart-readiness-uncommitted-work-391',
          partition: 'active',
          title: 'Restart-readiness policy violation: shipped work is uncommitted',
          status: 'needs_review',
          kind: 'restart_readiness_policy',
          ownerRoles: ['builder'],
          sessionId: 'app-session-391',
          updatedAt: '2026-05-31T19:01:00.000Z',
          rationale: 'ROLES.md restart-readiness policy requires commit/review before declaring restart-ready.',
          nextAction: 'Review/stage/commit or explicitly leave dirty before restart-ready.',
        },
        {
          id: 'cleanup-scratch-logs-391',
          title: 'Delete scratch preview logs after proof artifacts are preserved',
          status: 'ready_to_delete_after_proof_check',
          kind: 'cleanup_action',
          ownerRoles: ['builder'],
          sessionId: 'app-session-391',
          updatedAt: '2026-05-31T19:02:00.000Z',
        },
      ],
    });

    const snapshot = sidecar.buildLiveTaskAuditSnapshot({
      workItemRoot,
      taskAuditItemsPath,
      now: '2026-05-31T19:03:00.000Z',
    });

    expect(snapshot.reconciliation.activeWorkItemIds).toEqual(['wi-sidecar-current']);
    expect(snapshot.active.items.map((item) => item.id)).toEqual([
      'restart-readiness-uncommitted-work-391',
      'wi-sidecar-current',
    ]);
    expect(snapshot.active.items[0]).toEqual(expect.objectContaining({
      source: expect.objectContaining({
        kind: 'task_audit_item_store',
        label: 'task_audit_items',
      }),
      nextAction: 'Review/stage/commit or explicitly leave dirty before restart-ready.',
    }));
    expect(snapshot.future.items.map((item) => item.id)).toEqual([
      'cleanup-scratch-logs-391',
    ]);
  });

  test('moves active dead-file manual items to History when their source file is gone', () => {
    const deletedStatePath = path.join(tempRoot, '.squidrun', 'coord', 'current-objective-state.json');
    writeJson(taskAuditItemsPath, {
      items: [
        {
          id: 'current-objective-state-stale-dead-398',
          partition: 'active',
          section: 'SquidRun',
          title: 'Delete stale current-objective-state.json',
          status: 'needs_review',
          kind: 'delete_candidate',
          ownerRoles: ['builder', 'oracle'],
          sessionId: 'app-session-398',
          sourceKind: 'coordination_state',
          sourceRef: '.squidrun/coord/current-objective-state.json',
          updatedAt: '2026-06-02T10:31:07.097Z',
        },
      ],
    });

    const snapshot = sidecar.buildLiveTaskAuditSnapshot({
      workItemRoot,
      taskAuditItemsPath,
      now: '2026-06-02T11:00:00.000Z',
    });

    expect(fs.existsSync(deletedStatePath)).toBe(false);
    expect(snapshot.active.items.map((item) => item.id)).not.toContain('current-objective-state-stale-dead-398');
    expect(snapshot.history.items).toEqual([
      expect.objectContaining({
        id: 'current-objective-state-stale-dead-398',
        status: 'resolved_by_absence',
        verdict: 'resolved_by_absence',
        section: 'SquidRun',
        whatHappened: expect.stringContaining('current-objective-state.json is absent'),
      }),
    ]);
  });

  test('classifies manual items into plain sections and moves resolved DGcSGf52 cleanup to History', () => {
    const proofPath = path.join(tempRoot, '.squidrun', 'runtime', 'builder-task-audit-cleanup-392-proof.md');
    writeJson(path.join(tempRoot, '.squidrun', 'app-status.json'), { session: 393 });
    fs.mkdirSync(path.dirname(proofPath), { recursive: true });
    fs.writeFileSync(proofPath, [
      '## #2 ui/main-DGcSGf52.js provenance',
      'Resolved by absence / no-op.',
      '',
      'Evidence:',
      '- `ui/main-DGcSGf52.js` does not exist.',
    ].join('\n'), 'utf8');
    writeJson(taskAuditItemsPath, {
      items: [
        {
          id: 'verify-stray-electron-main-bundle-391',
          title: 'Verify whether ui/main-DGcSGf52.js is stray build output',
          status: 'ask_verify',
          kind: 'cleanup_ask_verify',
          ownerRoles: ['builder'],
          updatedAt: '2026-05-31T19:09:39.224Z',
          sourceRef: '.squidrun/runtime/oracle-task-audit-inventory-391.md',
        },
        {
          id: 'mira-live-vs-prototype-debt-393',
          title: 'Separate live Mira wiring from parked prototype work',
          status: 'needs_review',
          kind: 'architecture_debt',
          section: 'Mira',
          updatedAt: '2026-06-01T07:30:00.000Z',
        },
        {
          id: 'trustquote-prod-local-only-debt-393',
          title: 'Track TrustQuote local-only deploy debt read-only',
          status: 'watch',
          kind: 'cross_project_read_only',
          updatedAt: '2026-06-01T07:31:00.000Z',
          profile: 'trustquote',
        },
      ],
    });

    const snapshot = sidecar.buildLiveTaskAuditSnapshot({
      workItemRoot,
      taskAuditItemsPath,
      now: '2026-06-01T07:32:00.000Z',
    });

    expect(snapshot.future.items.map((item) => item.id)).toEqual([
      'trustquote-prod-local-only-debt-393',
      'mira-live-vs-prototype-debt-393',
    ]);
    expect(snapshot.future.items.map((item) => item.section)).toEqual(['TrustQuote', 'Mira']);
    expect(snapshot.history.items).toEqual([
      expect.objectContaining({
        id: 'verify-stray-electron-main-bundle-391',
        status: 'resolved',
        verdict: 'resolved',
        section: 'SquidRun',
        whatHappened: expect.stringContaining('resolved by absence'),
        why: expect.stringContaining('builder-task-audit-cleanup-392-proof.md'),
      }),
    ]);
  });

  test('falls back to current-lane and queue while keeping stale markers in future audit', () => {
    writeJson(currentLanePath, {
      source: 'comms_fallback',
      status: 'active',
      generatedAt: '2026-05-30T18:03:00.000Z',
      sessionId: 'app-session-389',
      activeLane: {
        laneId: 'architect-149',
        sourceRef: 'architect#149',
        sourceMessageId: 'm-architect-149',
        objective: 'Fallback active task from current-lane',
        ownerRoles: ['builder'],
      },
    });
    writeJson(queuePath, {
      agents: {
        oracle: {
          active: {
            taskId: 'oracle-static-verify',
            title: 'Verify sidecar snapshot shape',
            status: 'active',
            source: 'agent-task-queue',
            updatedAt: '2026-05-30T18:04:00.000Z',
          },
        },
      },
    });

    const snapshot = sidecar.buildLiveTaskAuditSnapshot({
      workItemRoot,
      currentLanePath,
      queuePath,
      now: '2026-05-30T18:05:00.000Z',
    });

    expect(snapshot.active.items.map((item) => item.title)).toEqual([
      'Verify sidecar snapshot shape',
      'Fallback active task from current-lane',
    ]);
    expect(snapshot.future.items.map((item) => item.title)).toEqual(expect.arrayContaining([
      'Agent queue has active work without typed work-item proof',
      'Current-lane store shows an unverified active entry',
    ]));
    expect(snapshot.reconciliation.status).toBe('STALE');
  });

  test('keeps unsequenced comms-journal current-lane fragments out of Needs Doing', () => {
    writeJson(currentLanePath, {
      source: 'comms_journal',
      status: 'active',
      generatedAt: '2026-06-01T07:39:38.470Z',
      sessionId: 'app-session-393',
      activeLane: {
        laneId: 'app-session-393:unsequenced:hm-1780299003902-hkqn7i',
        sourceRef: null,
        sourceMessageId: 'hm-1780299003902-hkqn7i',
        objective: 'History (closed) <-- ADD this tab.',
        ownerRoles: ['builder'],
      },
    });

    const snapshot = sidecar.buildLiveTaskAuditSnapshot({
      workItemRoot,
      currentLanePath,
      now: '2026-06-01T07:40:00.000Z',
    });

    expect(snapshot.active.items).toEqual([]);
    expect(snapshot.future.items.map((item) => item.title)).toEqual(expect.arrayContaining([
      'Current-lane store shows an unverified active entry',
    ]));
  });

});
