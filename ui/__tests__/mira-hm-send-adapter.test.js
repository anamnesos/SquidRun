'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PROTOCOL,
  buildHmSendCommand,
  buildPaneMessageEnvelope,
  planPaneMessage,
} = require('../../mira/bridge/hm-send-adapter');

describe('Mira hm-send bridge adapter', () => {
  let tempProject;
  let hmSendPath;

  beforeEach(() => {
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-hm-send-adapter-'));
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
      role_targets: {
        architect: 'architect',
        builder: 'builder',
        oracle: 'oracle',
      },
    }, null, 2));
  });

  afterEach(() => {
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  test.each([
    ['architect', '1'],
    ['builder', '2'],
    ['oracle', '3'],
  ])('builds a pane message envelope for %s', (targetRole, paneId) => {
    const envelope = buildPaneMessageEnvelope({
      targetRole,
      messageId: `mira-msg-${targetRole}`,
      requestId: `req-${targetRole}`,
      timestampMs: 1778710000000,
      content: `(MIRA #1): status for ${targetRole}`,
      evidence: [{
        kind: 'file',
        path: 'mira/bridge/squidrun-adapter-protocol-v0.md',
        summary: 'Protocol metadata fixture.',
      }],
    }, { cwd: tempProject });

    expect(envelope).toEqual(expect.objectContaining({
      protocol: PROTOCOL,
      request_id: `req-${targetRole}`,
      message_id: `mira-msg-${targetRole}`,
      session_id: 'app-session-373',
      timestamp_ms: 1778710000000,
      source: expect.objectContaining({
        service: 'mira-runtime',
        surface: 'mira-bridge',
        adapter: 'hm-send',
      }),
      target: {
        system: 'squidrun',
        role: targetRole,
        pane_id: paneId,
      },
      evidence: [expect.objectContaining({
        kind: 'file',
        path: 'mira/bridge/squidrun-adapter-protocol-v0.md',
      })],
      body: {
        content: `(MIRA #1): status for ${targetRole}`,
      },
    }));
    expect(envelope.workspace.replace(/\\/g, '/')).toBe(tempProject.replace(/\\/g, '/'));
  });

  test('builds an hm-send stdin command without sending', () => {
    const envelope = buildPaneMessageEnvelope({
      targetRole: 'builder',
      messageId: 'mira-msg-builder',
      content: '(MIRA #2): dry-run only',
    }, { cwd: tempProject });

    const command = buildHmSendCommand(envelope, { cwd: tempProject });

    expect(command).toEqual({
      executable: process.execPath,
      args: [
        hmSendPath,
        'builder',
        '--stdin',
        '--role',
        'mira',
        '--no-fallback',
      ],
      stdin: '(MIRA #2): dry-run only',
      cwd: tempProject,
    });
  });

  test('plans a dry-run pane delivery through existing hm-send transport', () => {
    const result = planPaneMessage({
      targetRole: 'oracle',
      messageId: 'mira-msg-oracle',
      content: '(MIRA #3): inspect bridge adapter',
    }, { cwd: tempProject });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      dryRun: true,
      protocol: PROTOCOL,
      message_id: 'mira-msg-oracle',
      session_id: 'app-session-373',
      delivery: {
        status: 'dry_run',
        target_role: 'oracle',
        target_pane_id: '3',
        channel: 'hm-send',
        transport: 'ui/scripts/hm-send.js',
      },
      command: expect.objectContaining({
        executable: process.execPath,
        args: [hmSendPath, 'oracle', '--stdin', '--role', 'mira', '--no-fallback'],
        stdin: '(MIRA #3): inspect bridge adapter',
        cwd: tempProject,
      }),
    }));
  });

  test.each([
    'telegram',
    'user',
    'external',
    '@peer-builder',
    'https://example.com/hook',
    '1',
    'mira',
  ])('refuses non-pane target %s', (targetRole) => {
    expect(() => planPaneMessage({
      targetRole,
      content: '(MIRA #4): should not route',
    }, { cwd: tempProject })).toThrow(/only targets SquidRun panes/);
  });
});
