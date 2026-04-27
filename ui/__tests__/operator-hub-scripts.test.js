'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const heartbeatCheck = require('../scripts/hm-codex-heartbeat-check');
const alignmentAudit = require('../scripts/hm-alignment-audit');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeRegistry(projectRoot, liveInstance = {}, templateInstance = {}) {
  writeJson(path.join(projectRoot, '.squidrun', 'operator-registry.json'), {
    schemaVersion: 1,
    instances: [
      {
        id: 'james-main',
        codexInbox: '.squidrun/coord/codex-inbox.jsonl',
        architectInbox: '.squidrun/coord/architect-inbox.jsonl',
        coordPath: '.squidrun/coord',
        notifyPolicy: {
          heartbeatStaleMinutes: 18,
        },
        ...liveInstance,
      },
    ],
  });
  writeJson(path.join(projectRoot, '.squidrun', 'operator-registry.template.json'), {
    schemaVersion: 1,
    instances: [
      {
        id: 'james-main',
        codexInbox: '.squidrun/coord/codex-inbox.jsonl',
        architectInbox: '.squidrun/coord/architect-inbox.jsonl',
        coordPath: '.squidrun/coord',
        codexHeartbeatPath: '.squidrun/coord/codex-heartbeat.json',
        notifyPolicy: {
          codexHeartbeatStaleMinutes: 10,
        },
        ...templateInstance,
      },
    ],
  });
}

describe('operator hub scripts', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-operator-hub-'));
    fs.mkdirSync(path.join(tempRoot, '.squidrun', 'coord'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('codex heartbeat check falls back to template heartbeat policy and passes when fresh', () => {
    writeRegistry(tempRoot);
    writeJson(path.join(tempRoot, '.squidrun', 'coord', 'codex-heartbeat.json'), {
      timestampUtc: '2026-04-27T00:00:00.000Z',
    });

    const result = heartbeatCheck.runCheck({
      projectRoot: tempRoot,
      instance: 'james-main',
      nowMs: Date.parse('2026-04-27T00:09:00.000Z'),
      runNodeScript: jest.fn(),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      reason: 'fresh',
      staleMinutes: 10,
      ageMinutes: 9,
    }));
  });

  test('codex heartbeat check reports stale heartbeat through anomaly and Telegram', () => {
    writeRegistry(tempRoot);
    writeJson(path.join(tempRoot, '.squidrun', 'coord', 'codex-heartbeat.json'), {
      ts: '2026-04-27T00:00:00.000Z',
    });
    const runNodeScript = jest.fn(() => ({ status: 0, stdout: '{"ok":true}' }));

    const result = heartbeatCheck.runCheck({
      projectRoot: tempRoot,
      instance: 'james-main',
      nowMs: Date.parse('2026-04-27T00:11:30.000Z'),
      runNodeScript,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'stale_heartbeat',
      ageMinutes: 11.5,
    }));
    expect(runNodeScript).toHaveBeenCalledTimes(2);
    expect(runNodeScript.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'type=codex_heartbeat_stale',
      'src=architect',
      'sev=high',
      '--json',
    ]));
    expect(runNodeScript.mock.calls[0][1].some((arg) => String(arg).includes('"instance":"james-main"'))).toBe(true);
    expect(runNodeScript.mock.calls[1][1][0]).toBe('telegram');
    expect(runNodeScript.mock.calls[1][1][1]).toContain('Codex heartbeat stale for james-main');
  });

  test('alignment audit appends a report with architect, reply, and absent witness entries', async () => {
    writeRegistry(tempRoot);
    const sent = [];
    const auditPromise = alignmentAudit.runAlignmentAudit({
      projectRoot: tempRoot,
      instance: 'james-main',
      auditId: 'align-test',
      timeoutMs: 50,
      pollMs: 10,
      nowMs: Date.parse('2026-04-27T00:00:00.000Z'),
      sendHmMessage: (projectRoot, target, message) => {
        sent.push({ projectRoot, target, message });
      },
    });
    writeJson(path.join(tempRoot, '.squidrun', 'coord', 'alignment-replies', 'align-test-builder.json'), {
      identity: 'builder',
      currentOwner: 'builder',
      openTask: 'standing_by',
      anomaliesSinceLast: 0,
      restartRequested: false,
      driftSelfReport: 'none',
    });

    const result = await auditPromise;
    const inboxLines = fs.readFileSync(
      path.join(tempRoot, '.squidrun', 'coord', 'codex-inbox.jsonl'),
      'utf8'
    ).trim().split(/\r?\n/);
    const report = JSON.parse(inboxLines[0]);

    expect(sent.map((entry) => entry.target)).toEqual(['builder', 'oracle']);
    expect(sent[0].message).toContain('ALIGNMENT_QUERY align-test');
    expect(result.entries.map((entry) => entry.identity)).toEqual(['architect', 'builder', 'absent']);
    expect(report).toEqual(expect.objectContaining({
      type: 'alignment_report',
      from: 'architect',
      to: 'codex',
      instance: 'james-main',
      auditId: 'align-test',
    }));
    expect(report.entries.map((entry) => entry.identity)).toEqual(['architect', 'builder', 'absent']);
  });
});
