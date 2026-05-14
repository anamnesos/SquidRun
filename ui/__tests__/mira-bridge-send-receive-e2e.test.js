'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Mira bridge send and receive smoke', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const sendCliPath = path.join(repoRoot, 'mira', 'bridge', 'send-pane-message.js');
  const readCliPath = path.join(repoRoot, 'mira', 'bridge', 'read-pane-messages.js');
  let tempProject;
  let hmSendPath;
  let hmCommsPath;
  let sendLogPath;

  beforeEach(() => {
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-bridge-e2e-'));
    hmSendPath = path.join(tempProject, 'ui', 'scripts', 'hm-send.js');
    hmCommsPath = path.join(tempProject, 'ui', 'scripts', 'hm-comms.js');
    sendLogPath = path.join(tempProject, 'hm-send-log.json');
    fs.mkdirSync(path.dirname(hmSendPath), { recursive: true });
    fs.mkdirSync(path.join(tempProject, '.squidrun'), { recursive: true });
    fs.writeFileSync(path.join(tempProject, '.squidrun', 'link.json'), JSON.stringify({
      squidrun_root: tempProject,
      workspace: tempProject,
      session_id: 'app-session-373',
      comms: {
        hm_send: hmSendPath,
        hm_comms: hmCommsPath,
      },
    }, null, 2));

    fs.writeFileSync(hmSendPath, `
const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(sendLogPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  stdin: input
}, null, 2));
console.log('Delivered to ' + process.argv[2]);
`);

    fs.writeFileSync(hmCommsPath, `
const betweenIndex = process.argv.indexOf('--between');
const left = betweenIndex >= 0 ? process.argv[betweenIndex + 1] : null;
const right = betweenIndex >= 0 ? process.argv[betweenIndex + 2] : null;
console.log(JSON.stringify({
  ok: true,
  count: 1,
  rows: [{
    messageId: 'builder-reply-1',
    sessionId: 'app-session-373',
    sender: right,
    target: left,
    status: 'recorded',
    rawBody: '(BUILDER #1): reply visible to Mira'
  }]
}));
`);
  });

  afterEach(() => {
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  test('Mira can send to Builder and read the Builder reply through bridge CLIs', () => {
    const sendOutput = execFileSync(process.execPath, [
      sendCliPath,
      '--send',
      '--target', 'builder',
      '--content', '(MIRA #1): bridge smoke',
      '--session-id', 'app-session-373',
      '--message-id', 'mira-bridge-smoke-1',
    ], {
      cwd: tempProject,
      encoding: 'utf8',
    });
    const sendPayload = JSON.parse(sendOutput);

    expect(sendPayload).toEqual(expect.objectContaining({
      ok: true,
      dryRun: false,
      message_id: 'mira-bridge-smoke-1',
      delivery: expect.objectContaining({
        status: 'hm_send_completed',
        target_role: 'builder',
        target_pane_id: '2',
        exit_code: 0,
      }),
    }));
    expect(JSON.parse(fs.readFileSync(sendLogPath, 'utf8'))).toEqual({
      argv: [
        'builder',
        '--stdin',
        '--role',
        'mira',
        '--no-fallback',
      ],
      stdin: '(MIRA #1): bridge smoke',
    });

    const readOutput = execFileSync(process.execPath, [
      readCliPath,
      '--read',
      '--from', 'builder',
      '--session-id', 'app-session-373',
      '--last', '5',
    ], {
      cwd: tempProject,
      encoding: 'utf8',
    });
    const readPayload = JSON.parse(readOutput);

    expect(readPayload).toEqual(expect.objectContaining({
      ok: true,
      dryRun: false,
      manualReadOnly: true,
      mutatesState: false,
      query: expect.objectContaining({
        participant: 'mira',
        teamRole: 'builder',
        sessionId: 'app-session-373',
      }),
      delivery: expect.objectContaining({
        status: 'hm_comms_completed',
        exit_code: 0,
      }),
      result: expect.objectContaining({
        count: 1,
        rows: [expect.objectContaining({
          sender: 'builder',
          target: 'mira',
          rawBody: '(BUILDER #1): reply visible to Mira',
        })],
      }),
    }));
  });

  test('Builder can reply to Mira through real hm-send and Mira can read it', () => {
    const realHmSendPath = path.join(repoRoot, 'ui', 'scripts', 'hm-send.js');
    const realHmCommsPath = path.join(repoRoot, 'ui', 'scripts', 'hm-comms.js');
    fs.writeFileSync(path.join(tempProject, '.squidrun', 'link.json'), JSON.stringify({
      squidrun_root: tempProject,
      workspace: tempProject,
      session_id: 'app-session-373',
      comms: {
        hm_send: realHmSendPath,
        hm_comms: realHmCommsPath,
      },
    }, null, 2));

    const replyOutput = execFileSync(process.execPath, [
      realHmSendPath,
      'mira',
      '(BUILDER #1): reply visible to Mira',
      '--role', 'builder',
      '--timeout', '80',
      '--retries', '0',
      '--no-fallback',
    ], {
      cwd: tempProject,
      encoding: 'utf8',
      env: {
        ...process.env,
        SQUIDRUN_PROJECT_ROOT: tempProject,
        SQUIDRUN_ROLE: 'builder',
        SQUIDRUN_PANE_ID: '',
      },
    });

    expect(replyOutput).toContain('Recorded to mira inbox');

    const readOutput = execFileSync(process.execPath, [
      readCliPath,
      '--read',
      '--from', 'builder',
      '--session-id', 'app-session-373',
      '--last', '5',
    ], {
      cwd: tempProject,
      encoding: 'utf8',
      env: {
        ...process.env,
        SQUIDRUN_PROJECT_ROOT: tempProject,
      },
    });
    const readPayload = JSON.parse(readOutput);

    expect(readPayload).toEqual(expect.objectContaining({
      ok: true,
      dryRun: false,
      manualReadOnly: true,
      mutatesState: false,
      result: expect.objectContaining({
        count: 1,
        rows: [expect.objectContaining({
          sessionId: 'app-session-373',
          sender: 'builder',
          target: 'mira',
          rawBody: '(BUILDER #1): reply visible to Mira',
        })],
      }),
    }));
  });
});
