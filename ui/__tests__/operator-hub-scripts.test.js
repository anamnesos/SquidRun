'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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
