'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Mira send-pane-message CLI', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const cliPath = path.join(repoRoot, 'mira', 'bridge', 'send-pane-message.js');
  let tempProject;
  let hmSendPath;

  beforeEach(() => {
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-send-pane-message-cli-'));
    hmSendPath = path.join(tempProject, 'ui', 'scripts', 'hm-send.js');
    fs.mkdirSync(path.dirname(hmSendPath), { recursive: true });
    fs.mkdirSync(path.join(tempProject, '.squidrun'), { recursive: true });
    fs.writeFileSync(hmSendPath, '#!/usr/bin/env node\n');
    fs.writeFileSync(path.join(tempProject, '.squidrun', 'link.json'), JSON.stringify({
      squidrun_root: tempProject,
      workspace: tempProject,
      session_id: 'app-session-373',
      comms: {
        hm_send: hmSendPath,
      },
    }, null, 2));
  });

  afterEach(() => {
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  function runCli(args) {
    const output = execFileSync(process.execPath, [
      cliPath,
      ...args,
    ], {
      cwd: tempProject,
      encoding: 'utf8',
    });
    return JSON.parse(output);
  }

  test.each([
    ['architect', '1'],
    ['builder', '2'],
    ['oracle', '3'],
  ])('prints a dry-run plan for %s', (targetRole, paneId) => {
    const result = runCli([
      '--target', targetRole,
      '--content', `(MIRA #1): planned ${targetRole}`,
      '--session-id', 'app-session-373',
      '--message-id', `mira-cli-${targetRole}`,
      '--request-id', `req-cli-${targetRole}`,
      '--timestamp-ms', '1778710000000',
      '--evidence-file', 'mira/bridge/squidrun-adapter-protocol-v0.md',
    ]);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      dryRun: true,
      message_id: `mira-cli-${targetRole}`,
      session_id: 'app-session-373',
      delivery: {
        status: 'dry_run',
        target_role: targetRole,
        target_pane_id: paneId,
        channel: 'hm-send',
        transport: 'ui/scripts/hm-send.js',
      },
      envelope: expect.objectContaining({
        request_id: `req-cli-${targetRole}`,
        timestamp_ms: 1778710000000,
        target: {
          system: 'squidrun',
          role: targetRole,
          pane_id: paneId,
        },
        evidence: [{
          kind: 'file',
          path: 'mira/bridge/squidrun-adapter-protocol-v0.md',
        }],
        body: {
          content: `(MIRA #1): planned ${targetRole}`,
        },
      }),
      command: {
        executable: process.execPath,
        args: [hmSendPath, targetRole, '--stdin', '--role', 'mira', '--no-fallback'],
        stdin: `(MIRA #1): planned ${targetRole}`,
        cwd: tempProject,
      },
    }));
  });

  test.each([
    'telegram',
    'user',
    '@peer-builder',
    'https://example.com/hook',
  ])('refuses external target %s', (targetRole) => {
    const result = spawnSync(process.execPath, [
      cliPath,
      '--target', targetRole,
      '--content', '(MIRA #2): should fail',
    ], {
      cwd: tempProject,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'external_target_refused',
        message: expect.stringContaining('only targets SquidRun panes'),
      }),
    }));
  });

  test('refuses live send mode in v0', () => {
    const result = spawnSync(process.execPath, [
      cliPath,
      '--send',
      '--target', 'builder',
      '--content', '(MIRA #3): not live yet',
    ], {
      cwd: tempProject,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        code: 'send_not_supported_v0',
        message: 'Mira hm-send adapter v0 only supports --dry-run planning.',
        retryable: false,
      },
    });
  });
});
