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
});
