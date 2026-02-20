const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const { EvidenceLedgerInvestigator } = require('../modules/main/evidence-ledger-investigator');

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

maybeDescribe('evidence-ledger-investigator', () => {
  let tempDir;
  let store;
  let investigator;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-ledger-investigator-'));
    store = new EvidenceLedgerStore({
      dbPath: path.join(tempDir, 'evidence-ledger.db'),
      maxRows: 1000,
      retentionMs: 24 * 60 * 60 * 1000,
      sessionId: 'investigator-test-session',
    });
    expect(store.init().ok).toBe(true);
    investigator = new EvidenceLedgerInvestigator(store);
  });

  afterEach(() => {
    if (store) store.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('incident lifecycle: create -> update -> link trace -> close', () => {
    const created = investigator.createIncident({
      title: 'ERR-XYZ startup race',
      description: 'Intermittent queue freeze on startup',
      severity: 'high',
      createdBy: 'builder',
      tags: ['err-xyz', 'startup'],
      meta: { lane: 'runtime' },
      nowMs: 1000,
    });
    expect(created.ok).toBe(true);

    const incident = investigator.getIncident(created.incidentId);
    expect(incident.title).toBe('ERR-XYZ startup race');
    expect(incident.severity).toBe('high');
    expect(incident.tags).toEqual(['err-xyz', 'startup']);

    const updated = investigator.updateIncident(created.incidentId, {
      status: 'investigating',
      severity: 'critical',
      nowMs: 1200,
    });
    expect(updated.ok).toBe(true);

    const linked = investigator.linkTrace(created.incidentId, 'trace-xyz-1', {
      linkedBy: 'oracle',
      note: 'Primary failure trace',
      linkedAtMs: 1250,
    });
    expect(linked.ok).toBe(true);
    expect(['linked', 'exists']).toContain(linked.status);

    const closed = investigator.closeIncident(created.incidentId, {
      status: 'closed',
      closedAtMs: 2000,
      nowMs: 2000,
    });
    expect(closed.ok).toBe(true);

    const finalIncident = investigator.getIncident(created.incidentId);
    expect(finalIncident.status).toBe('closed');
    expect(finalIncident.closedAtMs).toBe(2000);

    const list = investigator.listIncidents({ status: 'closed' });
    expect(list.some((item) => item.incidentId === created.incidentId)).toBe(true);
  });

  test('null nowMs falls back to current time instead of zero', () => {
    const before = Date.now();
    const created = investigator.createIncident({
      title: 'Null timestamp fallback',
      createdBy: 'builder',
      nowMs: null,
    });
    expect(created.ok).toBe(true);

    const incident = investigator.getIncident(created.incidentId);
    expect(incident.createdAtMs).toBeGreaterThanOrEqual(before);
    expect(incident.createdAtMs).not.toBe(0);
  });

  test('assertion CRUD: add -> update -> supersede chain', () => {
    const created = investigator.createIncident({
      title: 'ERR-ASSERT flow',
      createdBy: 'oracle',
      nowMs: 5000,
    });
    expect(created.ok).toBe(true);

    const added = investigator.addAssertion(created.incidentId, {
      claim: 'Queue deferral never drains due to stale focus state',
      type: 'hypothesis',
      confidence: 0.55,
      author: 'oracle',
      reasoning: 'Observed repeated defer logs and no submit events',
      evidenceBindings: [
        {
          kind: 'event_ref',
          eventId: 'evt-focus-1',
          traceId: 'trace-focus-1',
          relation: 'supports',
        },
      ],
      nowMs: 5100,
    });
    expect(added.ok).toBe(true);
    expect(added.bindingCount).toBe(1);

    const updated = investigator.updateAssertion(added.assertionId, {
      confidence: 0.8,
      status: 'confirmed',
      nowMs: 5200,
    });
    expect(updated.ok).toBe(true);

    const superseded = investigator.supersedeAssertion(added.assertionId, {
      claim: 'Root cause is render loop starving injection scheduler',
      confidence: 0.86,
      author: 'oracle',
      reasoning: 'Renderer task queue deadline exceeded during chunk writes',
      evidenceBindings: [
        {
          kind: 'log_slice_ref',
          logSource: 'renderer',
          logStartMs: 5300,
          logEndMs: 5400,
          relation: 'supports',
        },
      ],
      nowMs: 5500,
    });
    expect(superseded.ok).toBe(true);

    const oldAssertion = investigator.getAssertion(added.assertionId);
    const newAssertion = investigator.getAssertion(superseded.newAssertionId);
    expect(oldAssertion.status).toBe('superseded');
    expect(oldAssertion.supersededBy).toBe(superseded.newAssertionId);
    expect(newAssertion.version).toBe(oldAssertion.version + 1);
    expect(newAssertion.status).toBe('active');

    const assertions = investigator.listAssertions(created.incidentId, { order: 'asc' });
    expect(assertions).toHaveLength(2);
  });

  test('evidence bindings support all kinds and stale marking', () => {
    const created = investigator.createIncident({
      title: 'ERR-BINDINGS',
      createdBy: 'builder',
      nowMs: 6000,
    });
    expect(created.ok).toBe(true);

    const assertion = investigator.addAssertion(created.incidentId, {
      claim: 'Transport truncation occurs before PTY',
      confidence: 0.6,
      author: 'builder',
      evidenceBindings: [{ kind: 'event_ref', eventId: 'evt-transport-1' }],
      nowMs: 6100,
    });
    expect(assertion.ok).toBe(true);

    const fileBinding = investigator.bindEvidence(assertion.assertionId, {
      kind: 'file_line_ref',
      relation: 'supports',
      filePath: 'ui/modules/terminal/injection.js',
      fileLine: 775,
      fileColumn: 3,
      snapshotHash: 'sha256:abc123',
      createdBy: 'builder',
      nowMs: 6200,
    });
    expect(fileBinding.ok).toBe(true);

    const logBinding = investigator.bindEvidence(assertion.assertionId, {
      kind: 'log_slice_ref',
      relation: 'context',
      logSource: 'main',
      logStartMs: 6220,
      logEndMs: 6250,
      logFilter: { paneId: '1', level: 'warn' },
      createdBy: 'oracle',
      nowMs: 6260,
    });
    expect(logBinding.ok).toBe(true);

    const queryBinding = investigator.bindEvidence(assertion.assertionId, {
      kind: 'query_ref',
      relation: 'supports',
      query: { type: 'trace_lookup', traceId: 'trace-transport-1' },
      queryResultHash: 'sha256:def456',
      createdBy: 'oracle',
      nowMs: 6300,
    });
    expect(queryBinding.ok).toBe(true);

    const invalidBinding = investigator.bindEvidence(assertion.assertionId, {
      kind: 'query_ref',
      relation: 'supports',
      query: {},
    });
    expect(invalidBinding.ok).toBe(false);
    expect(invalidBinding.reason).toBe('query_required');

    const invalidEventBinding = investigator.bindEvidence(assertion.assertionId, {
      kind: 'event_ref',
      relation: 'supports',
    });
    expect(invalidEventBinding.ok).toBe(false);
    expect(invalidEventBinding.reason).toBe('event_id_required');

    const invalidFileBinding = investigator.bindEvidence(assertion.assertionId, {
      kind: 'file_line_ref',
      relation: 'supports',
      filePath: '',
      fileLine: 10,
    });
    expect(invalidFileBinding.ok).toBe(false);
    expect(invalidFileBinding.reason).toBe('file_path_required');

    const invalidLogBinding = investigator.bindEvidence(assertion.assertionId, {
      kind: 'log_slice_ref',
      relation: 'context',
      logSource: 'main',
      logStartMs: 6300,
      logEndMs: 6200,
    });
    expect(invalidLogBinding.ok).toBe(false);
    expect(invalidLogBinding.reason).toBe('invalid_log_window');

    const byAssertion = investigator.listBindings(assertion.assertionId);
    expect(byAssertion).toHaveLength(4);
    expect(byAssertion.map((item) => item.kind).sort()).toEqual([
      'event_ref',
      'file_line_ref',
      'log_slice_ref',
      'query_ref',
    ]);

    const staleMarked = investigator.markBindingStale(fileBinding.bindingId);
    expect(staleMarked.ok).toBe(true);

    const byIncident = investigator.listBindingsForIncident(created.incidentId);
    const stale = byIncident.find((item) => item.bindingId === fileBinding.bindingId);
    expect(stale.stale).toBe(true);
  });

  test('stale detection utility marks changed file_line_ref bindings', () => {
    const created = investigator.createIncident({
      title: 'ERR-STALE-DETECT',
      createdBy: 'builder',
      nowMs: 8000,
    });
    expect(created.ok).toBe(true);

    const assertion = investigator.addAssertion(created.incidentId, {
      claim: 'File snapshot should go stale after mutation',
      confidence: 0.8,
      author: 'builder',
      evidenceBindings: [{ kind: 'event_ref', eventId: 'evt-stale-seed' }],
      nowMs: 8010,
    });
    expect(assertion.ok).toBe(true);

    const snapshotFile = path.join(tempDir, 'stale-probe.txt');
    fs.writeFileSync(snapshotFile, 'line-one\nline-two\n', 'utf8');

    const initialHash = investigator.computeFileSnapshotHash(snapshotFile, { fileLine: 2 });
    expect(initialHash.ok).toBe(true);

    const bound = investigator.bindEvidence(assertion.assertionId, {
      kind: 'file_line_ref',
      relation: 'supports',
      filePath: snapshotFile,
      fileLine: 2,
      snapshotHash: initialHash.hash,
      nowMs: 8020,
    });
    expect(bound.ok).toBe(true);

    const firstPass = investigator.refreshFileLineBindingStaleness({
      bindingId: bound.bindingId,
    });
    expect(firstPass.ok).toBe(true);
    expect(firstPass.checked).toBe(1);
    expect(firstPass.markedStale).toBe(0);
    expect(firstPass.unchangedBindingIds).toContain(bound.bindingId);

    fs.writeFileSync(snapshotFile, 'line-one\nline-two-mutated\n', 'utf8');

    const secondPass = investigator.refreshFileLineBindingStaleness({
      bindingId: bound.bindingId,
      includeAlreadyStale: true,
    });
    expect(secondPass.ok).toBe(true);
    expect(secondPass.checked).toBe(1);
    expect(secondPass.markedStale).toBe(1);
    expect(secondPass.staleBindingIds).toContain(bound.bindingId);

    const bindings = investigator.listBindings(assertion.assertionId);
    const mutated = bindings.find((item) => item.bindingId === bound.bindingId);
    expect(mutated.stale).toBe(true);
  });

  test('verdict versioning and summary/timeline queries', () => {
    const created = investigator.createIncident({
      title: 'ERR-VERDICT',
      createdBy: 'oracle',
      nowMs: 7000,
    });
    expect(created.ok).toBe(true);

    expect(investigator.linkTrace(created.incidentId, 'trace-v-1', { linkedBy: 'oracle', linkedAtMs: 7010 }).ok).toBe(true);

    const assertion = investigator.addAssertion(created.incidentId, {
      claim: 'Busy-state ignored Enter',
      confidence: 0.7,
      author: 'oracle',
      evidenceBindings: [{ kind: 'event_ref', eventId: 'evt-verdict-1' }],
      nowMs: 7020,
    });
    expect(assertion.ok).toBe(true);

    const v1 = investigator.recordVerdict(created.incidentId, {
      value: 'Likely submit race',
      confidence: 0.62,
      reason: 'Initial synthesis',
      keyAssertionIds: [assertion.assertionId],
      author: 'oracle',
      nowMs: 7100,
    });
    const v2 = investigator.recordVerdict(created.incidentId, {
      value: 'Confirmed submit race + queue pressure',
      confidence: 0.86,
      reason: 'Added log evidence',
      keyAssertionIds: [assertion.assertionId],
      author: 'oracle',
      nowMs: 7200,
    });

    expect(v1.ok).toBe(true);
    expect(v1.version).toBe(1);
    expect(v2.ok).toBe(true);
    expect(v2.version).toBe(2);

    const current = investigator.getCurrentVerdict(created.incidentId);
    expect(current.version).toBe(2);
    expect(current.value).toContain('Confirmed');

    const history = investigator.getVerdictHistory(created.incidentId);
    expect(history).toHaveLength(2);
    expect(history.map((item) => item.version)).toEqual([2, 1]);

    const summary = investigator.getIncidentSummary(created.incidentId);
    expect(summary.incident.incidentId).toBe(created.incidentId);
    expect(summary.traces).toHaveLength(1);
    expect(summary.assertions).toHaveLength(1);
    expect(summary.currentVerdict.version).toBe(2);
    expect(summary.evidenceCount).toBe(1);

    const timeline = investigator.getIncidentTimeline(created.incidentId);
    expect(timeline.length).toBeGreaterThanOrEqual(4);
    expect(timeline.some((item) => item.kind === 'trace_link')).toBe(true);
    expect(timeline.some((item) => item.kind === 'assertion')).toBe(true);
    expect(timeline.some((item) => item.kind === 'evidence_binding')).toBe(true);
    expect(timeline.some((item) => item.kind === 'verdict')).toBe(true);
  });
});

describe('evidence-ledger-investigator degraded mode', () => {
  test('returns unavailable when backing store is unavailable', () => {
    const disabledStore = new EvidenceLedgerStore({ enabled: false });
    const init = disabledStore.init();
    expect(init.ok).toBe(false);

    const investigator = new EvidenceLedgerInvestigator(disabledStore);
    expect(investigator.createIncident({ title: 'x' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(investigator.addAssertion('inc-1', { claim: 'c' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(investigator.bindEvidence('ast-1', { kind: 'event_ref', eventId: 'evt-1' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(investigator.recordVerdict('inc-1', { value: 'v', confidence: 0.5 })).toEqual({ ok: false, reason: 'unavailable' });
    expect(investigator.refreshFileLineBindingStaleness()).toEqual({ ok: false, reason: 'unavailable' });
    expect(investigator.computeFileSnapshotHash('x.txt').ok).toBe(false);
    expect(investigator.getIncident('inc-1')).toEqual({ ok: false, reason: 'unavailable' });
  });
});
