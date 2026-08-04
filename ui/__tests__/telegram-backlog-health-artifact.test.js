/**
 * ARTIFACT-LEVEL PROOF, per Architect #60 and #62.
 *
 * The bar is not "the reader returns a good object" and not "buildHealthStatus
 * penalises". It is: the JSON that gets EMITTED and the Markdown that gets
 * WRITTEN both show a degraded score and name the backlog. James reads the
 * artifact. Every layer above it can be correct while the artifact stays green
 * — that is precisely the failure this whole lane exists to eliminate, and it
 * has already happened once inside this fix.
 *
 * So these tests drive `main()` end to end against a fixture project root and
 * assert on the serialized bytes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('child_process', () => ({ execFileSync: jest.fn() }));
jest.mock('../modules/memory-consistency-check', () => ({
  runMemoryConsistencyCheck: jest.fn(() => ({
    ok: true,
    checkedAt: '2026-08-03T00:00:00.000Z',
    status: 'in_sync',
    synced: true,
    summary: {
      knowledgeEntryCount: 1,
      knowledgeNodeCount: 1,
      missingInCognitiveCount: 0,
      orphanedNodeCount: 0,
      duplicateKnowledgeHashCount: 0,
      issueCount: 0,
    },
  })),
  planMemoryConsistencyRepair: jest.fn(() => ({
    ok: true,
    mode: 'dry_run',
    dryRun: true,
    summary: {
      actionCount: 0, insertCount: 0, duplicateMergeCount: 0,
      orphanDeleteCount: 0, deleteCount: 0, skippedCount: 0,
    },
    skipped: [],
  })),
}));

const { execFileSync } = require('child_process');

const NOW = Date.now();

function sink() {
  const chunks = [];
  return { write: (s) => chunks.push(String(s)), text: () => chunks.join('') };
}

describe('the emitted and written artifact carries the backlog', () => {
  let tempDir;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-health-artifact-'));
    fs.mkdirSync(path.join(tempDir, 'ui', '__tests__'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'ui', 'modules'), { recursive: true });
    execFileSync.mockReturnValue(path.join(tempDir, 'ui', '__tests__', 'a.test.js'));
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeWedgedBacklog() {
    const statePath = path.join(tempDir, '.squidrun', 'runtime', 'telegram-backlog-health.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    // The real S491 state: six held, head 8.6h old, proof unattainable.
    fs.writeFileSync(statePath, JSON.stringify({
      schema: 'telegramBacklogHealth.v0',
      updatedAtMs: NOW,
      routes: {
        main: {
          pendingCount: 6,
          oldestPendingUpdateId: 808499316,
          oldestPendingReceivedAtMs: NOW - Math.round(8.6 * 60 * 60 * 1000),
          blockedUpdateId: 808499316,
          blockedReason: 'unprovable_pane:runtime_never_produced_proof',
          proofUnattainable: true,
          attemptedCount: 1,
          lastRetirementAtMs: null,
          observedAtMs: NOW,
          // v7 section 3 Phase L. A document written by the current producer always
          // carries the operating state; a fixture without it would be testing a
          // shape nothing writes.
          activationMode: 'legacy_settlement',
          activationModeHealthy: true,
          activationModeReason: null,
        },
      },
    }), 'utf8');
  }

  test('THE EMITTED JSON shows score < 100 and names the backlog', () => {
    const { main } = require('../scripts/hm-health-snapshot');
    writeWedgedBacklog();
    const stdout = sink();

    const code = main(['--json', tempDir], { stdout, stderr: sink() });

    expect(code).toBe(0);
    const emitted = JSON.parse(stdout.text());
    expect(emitted.status.score).toBeLessThan(100);
    expect(emitted.status.level).not.toBe('ok');
    expect(emitted.status.warnings.join()).toMatch(/telegram_ingress_backlog_critical/);
    // The structured section itself is present for machine consumers.
    expect(emitted.telegramIngressBacklog.severity).toBe('critical');
    expect(emitted.telegramIngressBacklog.routes.main.headAgeMs).toBeGreaterThan(8 * 60 * 60 * 1000);
  });

  test('THE WRITTEN MARKDOWN shows the degraded score and the backlog warning', () => {
    const { main } = require('../scripts/hm-health-snapshot');
    writeWedgedBacklog();
    const stdout = sink();
    const outputPath = path.join(tempDir, 'startup-health.md');

    main(['--markdown', '--write', '--output', outputPath, tempDir], {
      stdout, stderr: sink(),
    });

    const written = fs.readFileSync(outputPath, 'utf8');
    expect(written).toMatch(/telegram_ingress_backlog_critical/);
    // The score in the artifact is not 100.
    expect(written).not.toMatch(/score=100\/100/);
    const scoreMatch = written.match(/score=(\d+)\/100/);
    expect(scoreMatch).not.toBeNull();
    expect(Number(scoreMatch[1])).toBeLessThan(100);
    // And the stdout the operator sees agrees with the file.
    expect(stdout.text()).toMatch(/telegram_ingress_backlog_critical/);
  });

  test('A MISSING SNAPSHOT WITH A LIVE SPOOL degrades the WRITTEN artifact too', () => {
    const { main } = require('../scripts/hm-health-snapshot');
    // Spool exists, report does not — the "reporter died" case.
    fs.mkdirSync(path.join(tempDir, '.squidrun', 'runtime', 'telegram-inbound', 'main'), { recursive: true });
    const outputPath = path.join(tempDir, 'startup-health.md');

    main(['--markdown', '--write', '--output', outputPath, tempDir], {
      stdout: sink(), stderr: sink(),
    });

    const written = fs.readFileSync(outputPath, 'utf8');
    expect(written).toMatch(/telegram_ingress_backlog_degraded/);
    expect(written).toMatch(/backlog_snapshot_missing/);
    expect(Number(written.match(/score=(\d+)\/100/)[1])).toBeLessThan(100);
  });

  test('A STALE SNAPSHOT degrades the EMITTED JSON', () => {
    const { main } = require('../scripts/hm-health-snapshot');
    const statePath = path.join(tempDir, '.squidrun', 'runtime', 'telegram-backlog-health.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      schema: 'telegramBacklogHealth.v0',
      routes: {
        main: {
          pendingCount: 0, oldestPendingUpdateId: null, oldestPendingReceivedAtMs: null,
          blockedReason: null, proofUnattainable: false, attemptedCount: 0,
          // Two hours old: its last words were good news.
          observedAtMs: NOW - 2 * 60 * 60 * 1000,
        },
      },
    }), 'utf8');
    const stdout = sink();

    main(['--json', tempDir], { stdout, stderr: sink() });

    const emitted = JSON.parse(stdout.text());
    expect(emitted.status.score).toBeLessThan(100);
    expect(emitted.status.warnings.join()).toMatch(/backlog_snapshot_stale/);
  });

  test('A MALFORMED SNAPSHOT degrades BOTH the emitted JSON and the written Markdown', () => {
    const { main } = require('../scripts/hm-health-snapshot');
    fs.mkdirSync(path.join(tempDir, '.squidrun', 'runtime', 'telegram-inbound', 'main'), { recursive: true });
    const statePath = path.join(tempDir, '.squidrun', 'runtime', 'telegram-backlog-health.json');
    fs.writeFileSync(statePath, 'not json at all', 'utf8');

    const jsonOut = sink();
    main(['--json', tempDir], { stdout: jsonOut, stderr: sink() });
    const emitted = JSON.parse(jsonOut.text());
    expect(emitted.status.score).toBeLessThan(100);
    expect(emitted.status.warnings.join()).toMatch(/backlog_snapshot_malformed/);

    const outputPath = path.join(tempDir, 'startup-health.md');
    main(['--markdown', '--write', '--output', outputPath, tempDir], { stdout: sink(), stderr: sink() });
    const written = fs.readFileSync(outputPath, 'utf8');
    expect(written).toMatch(/backlog_snapshot_malformed/);
    expect(Number(written.match(/score=(\d+)\/100/)[1])).toBeLessThan(100);
  });

  test('A STALE SNAPSHOT degrades the WRITTEN Markdown too, not only the emitted JSON', () => {
    const { main } = require('../scripts/hm-health-snapshot');
    const statePath = path.join(tempDir, '.squidrun', 'runtime', 'telegram-backlog-health.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      schema: 'telegramBacklogHealth.v0',
      routes: {
        main: {
          pendingCount: 0, oldestPendingUpdateId: null, oldestPendingReceivedAtMs: null,
          blockedReason: null, proofUnattainable: false, attemptedCount: 0,
          observedAtMs: NOW - 2 * 60 * 60 * 1000,
        },
      },
    }), 'utf8');
    const outputPath = path.join(tempDir, 'startup-health.md');

    main(['--markdown', '--write', '--output', outputPath, tempDir], { stdout: sink(), stderr: sink() });

    const written = fs.readFileSync(outputPath, 'utf8');
    expect(written).toMatch(/backlog_snapshot_stale/);
    expect(Number(written.match(/score=(\d+)\/100/)[1])).toBeLessThan(100);
  });

  test('THE ROOT-WITHOUT-FEATURE EXEMPTION, pinned on BOTH sides at artifact level', () => {
    const { main } = require('../scripts/hm-health-snapshot');

    // (a) No ingress spool at all: genuinely nothing to be behind on.
    const cleanOut = sink();
    main(['--json', tempDir], { stdout: cleanOut, stderr: sink() });
    const cleanEmitted = JSON.parse(cleanOut.text());
    expect(cleanEmitted.telegramIngressBacklog.severity).toBe('ok');
    expect(cleanEmitted.status.warnings.join()).not.toMatch(/telegram_ingress_backlog/);

    // (b) Spool present, report absent: the exemption must NOT reach here.
    fs.mkdirSync(path.join(tempDir, '.squidrun', 'runtime', 'telegram-inbound', 'main'), { recursive: true });
    jest.resetModules();
    const wedgedOut = sink();
    const { main: main2 } = require('../scripts/hm-health-snapshot');
    main2(['--json', tempDir], { stdout: wedgedOut, stderr: sink() });
    const wedgedEmitted = JSON.parse(wedgedOut.text());
    expect(wedgedEmitted.telegramIngressBacklog.severity).toBe('degraded');
    expect(wedgedEmitted.status.warnings.join()).toMatch(/backlog_snapshot_missing/);
    expect(wedgedEmitted.status.score).toBeLessThan(100);
  });

  test('A HEALTHY BACKLOG leaves the artifact clean — the alarm must not always fire', () => {
    const { main } = require('../scripts/hm-health-snapshot');
    const statePath = path.join(tempDir, '.squidrun', 'runtime', 'telegram-backlog-health.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      schema: 'telegramBacklogHealth.v0',
      routes: {
        main: {
          pendingCount: 0, oldestPendingUpdateId: null, oldestPendingReceivedAtMs: null,
          blockedReason: null, proofUnattainable: false, attemptedCount: 0,
          lastRetirementAtMs: NOW - 1000, observedAtMs: NOW,
          // v7 section 3 Phase L: an empty queue is only healthy if the channel
          // is also in a state it can operate in.
          activationMode: 'legacy_settlement', activationModeHealthy: true, activationModeReason: null,
        },
      },
    }), 'utf8');
    const stdout = sink();

    main(['--json', tempDir], { stdout, stderr: sink() });

    const emitted = JSON.parse(stdout.text());
    expect(emitted.status.warnings.join()).not.toMatch(/telegram_ingress_backlog/);
    expect(emitted.telegramIngressBacklog.severity).toBe('ok');
  });

  test('AN EMPTY QUEUE IN AN UNCONFIGURED CHANNEL still raises the alarm', () => {
    // The mirror of the test above, and the reason the mode check runs before
    // the pending count: an install nobody configured refuses every message
    // that will ever arrive, and until the first one does its queue is empty.
    const { main } = require('../scripts/hm-health-snapshot');
    const statePath = path.join(tempDir, '.squidrun', 'runtime', 'telegram-backlog-health.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      schema: 'telegramBacklogHealth.v0',
      routes: {
        main: {
          pendingCount: 0, oldestPendingUpdateId: null, oldestPendingReceivedAtMs: null,
          blockedReason: null, proofUnattainable: false, attemptedCount: 0,
          lastRetirementAtMs: NOW - 1000, observedAtMs: NOW,
          activationMode: null, activationModeHealthy: false,
          activationModeReason: 'activation_mode_missing',
        },
      },
    }), 'utf8');
    const stdout = sink();

    main(['--json', tempDir], { stdout, stderr: sink() });

    const emitted = JSON.parse(stdout.text());
    expect(emitted.telegramIngressBacklog.severity).toBe('critical');
    expect(emitted.status.warnings.join()).toMatch(/activation_mode_unhealthy:activation_mode_missing/);
  });
});
