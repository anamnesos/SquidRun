const fs = require('fs');
const os = require('os');
const path = require('path');

const codexInbox = require('../scripts/hm-codex-inbox-append');

describe('hm-codex-inbox-append', () => {
  let tempDir;
  let inboxPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-codex-inbox-'));
    inboxPath = path.join(tempDir, 'codex-inbox.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('builds the Codex bridge contract shape', () => {
    const entry = codexInbox.buildEntry({
      id: 'current-objective-2026-04-29-builder',
      from: 'builder',
      priority: 'urgent',
      instance: 'james-main',
      contextFile: '.squidrun/coord/client-readiness-failure-2026-04-29.md',
      action: 'Check the current-objective bridge once and reply only if drift remains.',
      type: 'current_objective_request',
    });

    expect(entry).toEqual(expect.objectContaining({
      id: 'current-objective-2026-04-29-builder',
      type: 'current_objective_request',
      from: 'builder',
      to: 'codex',
      priority: 'urgent',
      instance: 'james-main',
      contextFile: '.squidrun/coord/client-readiness-failure-2026-04-29.md',
      neededCodexAction: 'Check the current-objective bridge once and reply only if drift remains.',
    }));
    expect(entry.createdAt).toEqual(expect.any(String));
  });

  test('requires one explicit action and stable id', () => {
    expect(codexInbox.validate({
      id: '',
      action: '',
      instance: 'james-main',
      priority: 'normal',
      type: 'current_objective_request',
    })).toEqual(expect.arrayContaining([
      '--id is required',
      '--action is required',
    ]));
  });

  test('appends once and skips duplicate ids', () => {
    const opts = {
      id: 'wake-bridge-contract-builder-2026-04-29',
      from: 'builder',
      priority: 'normal',
      instance: 'james-main',
      contextFile: '.squidrun/coord/client-readiness-failure-2026-04-29.md',
      action: 'Verify the latest Builder wake-loop commit and respond only if bridge drift remains.',
      type: 'current_objective_request',
      inboxPath,
    };

    const first = codexInbox.appendEntry(opts);
    const second = codexInbox.appendEntry(opts);
    const lines = fs.readFileSync(inboxPath, 'utf8').trim().split(/\r?\n/);

    expect(first).toEqual(expect.objectContaining({ ok: true, skipped: false }));
    expect(second).toEqual(expect.objectContaining({
      ok: true,
      skipped: true,
      reason: 'duplicate_id',
    }));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(expect.objectContaining({
      id: 'wake-bridge-contract-builder-2026-04-29',
      to: 'codex',
      neededCodexAction: 'Verify the latest Builder wake-loop commit and respond only if bridge drift remains.',
    }));
  });
});
