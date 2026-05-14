'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PROTOCOL,
  buildReadPlan,
  run,
} = require('../../mira/bridge/read-pane-messages');

describe('Mira read-pane-messages bridge wrapper', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const cliPath = path.join(repoRoot, 'mira', 'bridge', 'read-pane-messages.js');
  let tempProject;
  let hmCommsPath;

  beforeEach(() => {
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-read-pane-messages-'));
    hmCommsPath = path.join(tempProject, 'ui', 'scripts', 'hm-comms.js');
    fs.mkdirSync(path.dirname(hmCommsPath), { recursive: true });
    fs.mkdirSync(path.join(tempProject, '.squidrun'), { recursive: true });
    fs.writeFileSync(hmCommsPath, '#!/usr/bin/env node\n');
    fs.writeFileSync(path.join(tempProject, '.squidrun', 'link.json'), JSON.stringify({
      squidrun_root: tempProject,
      workspace: tempProject,
      session_id: 'app-session-373',
      comms: {
        hm_comms: hmCommsPath,
      },
    }, null, 2));
  });

  afterEach(() => {
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  test.each([
    'architect',
    'builder',
    'oracle',
  ])('builds a dry-run hm-comms plan for Mira and %s', (teamRole) => {
    const plan = buildReadPlan({
      teamRole,
      sessionId: 'app-session-373',
      correlationId: 'mira-msg-1',
      last: 7,
    }, { cwd: tempProject });

    expect(plan).toEqual(expect.objectContaining({
      ok: true,
      dryRun: true,
      protocol: PROTOCOL,
      manualReadOnly: true,
      mutatesState: false,
      telegramRouteControl: false,
      uiSurfaceControl: false,
      query: {
        participant: 'mira',
        teamRole,
        sessionId: 'app-session-373',
        correlationId: 'mira-msg-1',
        last: 7,
        scope: null,
      },
      command: {
        executable: process.execPath,
        args: [
          hmCommsPath,
          'history',
          '--between',
          'mira',
          teamRole,
          '--last',
          '7',
          '--json',
          '--session',
          'app-session-373',
        ],
        cwd: tempProject,
      },
    }));
  });

  test('CLI defaults to dry-run and never spawns hm-comms', () => {
    const spawnMock = jest.fn();
    const result = run([
      '--from', 'builder',
      '--session-id', 'app-session-373',
      '--last', '3',
    ], {
      cwd: tempProject,
      spawnSync: spawnMock,
    });

    expect(result.statusCode).toBe(0);
    expect(result.payload).toEqual(expect.objectContaining({
      ok: true,
      dryRun: true,
      query: expect.objectContaining({
        participant: 'mira',
        teamRole: 'builder',
        sessionId: 'app-session-373',
        last: 3,
      }),
    }));
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test('explicit read executes only hm-comms history with JSON output', () => {
    const stdout = JSON.stringify({
      ok: true,
      count: 1,
      rows: [{
        messageId: 'reply-1',
        sender: 'builder',
        target: 'mira',
        rawBody: '(BUILDER #1): seen',
      }],
    });
    const spawnMock = jest.fn(() => ({
      status: 0,
      stdout,
      stderr: '',
      signal: null,
    }));

    const result = run([
      '--read',
      '--from', 'builder',
      '--session-id', 'app-session-373',
    ], {
      cwd: tempProject,
      spawnSync: spawnMock,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(process.execPath, [
      hmCommsPath,
      'history',
      '--between',
      'mira',
      'builder',
      '--last',
      '20',
      '--json',
      '--session',
      'app-session-373',
    ], {
      cwd: tempProject,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result).toEqual(expect.objectContaining({
      statusCode: 0,
      payload: expect.objectContaining({
        ok: true,
        dryRun: false,
        manualReadOnly: true,
        mutatesState: false,
        delivery: expect.objectContaining({
          status: 'hm_comms_completed',
          exit_code: 0,
        }),
        result: expect.objectContaining({
          count: 1,
          rows: [expect.objectContaining({
            target: 'mira',
            rawBody: '(BUILDER #1): seen',
          })],
        }),
      }),
    }));
  });

  test.each([
    'telegram',
    'user',
    '@peer-builder',
    'https://example.com/hook',
    'mira',
    '1',
  ])('refuses non-team read target %s before spawn', (teamRole) => {
    const spawnMock = jest.fn();

    expect(() => run([
      '--read',
      '--from', teamRole,
    ], {
      cwd: tempProject,
      spawnSync: spawnMock,
    })).toThrow(/only reads between Mira and team panes/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test('CLI refusal prints structured JSON', () => {
    const result = spawnSync(process.execPath, [
      cliPath,
      '--from', 'telegram',
    ], {
      cwd: tempProject,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'external_target_refused',
      }),
    }));
  });

  test('CLI dry-run prints JSON plan', () => {
    const output = execFileSync(process.execPath, [
      cliPath,
      '--from', 'oracle',
      '--last', '2',
    ], {
      cwd: tempProject,
      encoding: 'utf8',
    });

    const payload = JSON.parse(output);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      dryRun: true,
      query: expect.objectContaining({
        teamRole: 'oracle',
        last: 2,
      }),
    }));
  });
});
