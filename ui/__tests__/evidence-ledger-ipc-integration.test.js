const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  registerEvidenceLedgerHandlers,
  createEvidenceLedgerRuntime,
  closeSharedRuntime,
} = require('../modules/ipc/evidence-ledger-handlers');
const { createIpcHarness, createDefaultContext } = require('./helpers/ipc-harness');

function hasSqliteDriver() {
  try {
    // eslint-disable-next-line global-require
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') return true;
  } catch {
    // Continue to fallback.
  }
  try {
    // eslint-disable-next-line global-require
    require('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

const maybeDescribe = hasSqliteDriver() ? describe : describe.skip;

maybeDescribe('evidence-ledger IPC integration', () => {
  let tempDir;
  let dbPath;
  let harness;
  let ctx;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-ledger-ipc-'));
    dbPath = path.join(tempDir, 'evidence-ledger-ipc.db');

    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });

    registerEvidenceLedgerHandlers(ctx, {
      createEvidenceLedgerRuntime: () => createEvidenceLedgerRuntime({
        storeOptions: {
          dbPath,
          maxRows: 5000,
          retentionMs: 7 * 24 * 60 * 60 * 1000,
          sessionId: 'ipc-integration-session',
        },
      }),
    });
  });

  afterEach(() => {
    closeSharedRuntime();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('full flow: create incident -> add hypothesis with evidence -> record verdict -> query summary', async () => {
    const createIncident = await harness.invoke('evidence-ledger:create-incident', {
      title: 'ERR-IPC-001 submit acceptance race',
      severity: 'high',
      createdBy: 'analyst',
      tags: ['err-ipc-001', 'submit'],
      meta: { lane: 'integration' },
    });
    expect(createIncident.ok).toBe(true);
    expect(typeof createIncident.incidentId).toBe('string');

    const addHypothesis = await harness.invoke('evidence-ledger:add-assertion', {
      incidentId: createIncident.incidentId,
      claim: 'CLI busy-state ignored Enter dispatch',
      confidence: 0.74,
      author: 'analyst',
      type: 'hypothesis',
      evidenceBindings: [
        {
          kind: 'event_ref',
          eventId: 'evt-ipc-001',
          traceId: 'trc-ipc-001',
          relation: 'supports',
        },
      ],
    });
    expect(addHypothesis.ok).toBe(true);
    expect(typeof addHypothesis.assertionId).toBe('string');

    const bindEvidence = await harness.invoke('evidence-ledger:bind-evidence', {
      assertionId: addHypothesis.assertionId,
      binding: {
        kind: 'query_ref',
        relation: 'context',
        query: {
          type: 'trace_lookup',
          traceId: 'trc-ipc-001',
          stage: 'inject',
        },
        queryResultHash: 'sha256:test-query-hash',
      },
    });
    expect(bindEvidence.ok).toBe(true);
    expect(typeof bindEvidence.bindingId).toBe('string');

    const recordVerdict = await harness.invoke('evidence-ledger:record-verdict', {
      incidentId: createIncident.incidentId,
      value: 'Confirmed submit acceptance race',
      confidence: 0.88,
      reason: 'Hypothesis corroborated by event + query evidence',
      keyAssertionIds: [addHypothesis.assertionId],
      author: 'analyst',
    });
    expect(recordVerdict.ok).toBe(true);
    expect(recordVerdict.version).toBe(1);

    const summary = await harness.invoke('evidence-ledger:get-summary', {
      incidentId: createIncident.incidentId,
    });
    expect(summary.incident.incidentId).toBe(createIncident.incidentId);
    expect(summary.assertions).toHaveLength(1);
    expect(summary.currentVerdict.version).toBe(1);
    expect(summary.currentVerdict.keyAssertionIds).toEqual([addHypothesis.assertionId]);
    expect(summary.evidenceCount).toBe(2);

    const incidents = await harness.invoke('evidence-ledger:list-incidents', {
      status: 'open',
      limit: 10,
    });
    expect(Array.isArray(incidents)).toBe(true);
    expect(incidents.some((incident) => incident.incidentId === createIncident.incidentId)).toBe(true);
  });

  test('memory flow: record decisions across categories -> query context shape', async () => {
    const startSession = await harness.invoke('evidence-ledger:record-session-start', {
      sessionId: 'ses-ipc-memory-1',
      sessionNumber: 222,
      mode: 'PTY',
      stats: { test_suites: 120, tests_passed: 4001 },
      team: { '1': 'Architect', '2': 'DevOps', '5': 'Analyst' },
    });
    expect(startSession.ok).toBe(true);
    expect(startSession.sessionId).toBe('ses-ipc-memory-1');

    const records = [
      {
        category: 'architecture',
        title: 'Evidence ledger is startup source of truth',
        body: 'getLatestContext replaces manual handoff read',
        author: 'architect',
      },
      {
        category: 'directive',
        title: 'Always verify runtime before closeout',
        body: 'User directive',
        author: 'user',
      },
      {
        category: 'completion',
        title: 'Slice 3 Phase B delivered',
        body: 'IPC + CLI + seed utility',
        author: 'devops',
      },
      {
        category: 'issue',
        title: 'ERR-MEM-IPC-01',
        body: 'Context drift between sessions',
        author: 'analyst',
      },
      {
        category: 'roadmap',
        title: 'Slice 3 Phase C',
        body: 'Snapshots + prune extensions',
        author: 'architect',
      },
    ];

    for (const decision of records) {
      const recorded = await harness.invoke('evidence-ledger:record-decision', {
        ...decision,
        sessionId: 'ses-ipc-memory-1',
      });
      expect(recorded.ok).toBe(true);
      expect(typeof recorded.decisionId).toBe('string');
    }

    const context = await harness.invoke('evidence-ledger:get-context', {});
    expect(context.source).toBe('ledger');
    expect(context.session).toBe(222);
    expect(context.mode).toBe('PTY');
    expect(Array.isArray(context.completed)).toBe(true);
    expect(Array.isArray(context.important_notes)).toBe(true);
    expect(Array.isArray(context.roadmap)).toBe(true);
    expect(Array.isArray(context.not_yet_done)).toBe(true);
    expect(typeof context.known_issues).toBe('object');
    expect(typeof context.architecture).toBe('object');
    expect(typeof context.stats).toBe('object');
    expect(typeof context.team).toBe('object');

    expect(context.completed.some((item) => item.includes('Slice 3 Phase B delivered'))).toBe(true);
    expect(context.important_notes.some((item) => item.includes('Always verify runtime before closeout'))).toBe(true);
    expect(context.roadmap.some((item) => item.includes('Slice 3 Phase C'))).toBe(true);
    expect(context.not_yet_done.some((item) => item.includes('Slice 3 Phase C'))).toBe(true);
    expect(context.known_issues['ERR-MEM-IPC-01']).toBe('Context drift between sessions');
    expect(context.architecture.decisions.some((item) => item.title.includes('Evidence ledger'))).toBe(true);

    const directives = await harness.invoke('evidence-ledger:get-directives', { limit: 5 });
    expect(Array.isArray(directives)).toBe(true);
    expect(directives.some((item) => item.title.includes('Always verify runtime'))).toBe(true);

    const completions = await harness.invoke('evidence-ledger:get-completions', { limit: 5 });
    expect(Array.isArray(completions)).toBe(true);
    expect(completions.some((item) => item.title.includes('Slice 3 Phase B delivered'))).toBe(true);

    const issues = await harness.invoke('evidence-ledger:get-issues', { limit: 5 });
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.some((item) => item.title === 'ERR-MEM-IPC-01')).toBe(true);

    const roadmap = await harness.invoke('evidence-ledger:get-roadmap', { limit: 5 });
    expect(Array.isArray(roadmap)).toBe(true);
    expect(roadmap.some((item) => item.title.includes('Slice 3 Phase C'))).toBe(true);
  });
});
