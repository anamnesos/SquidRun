const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildStandaloneLaneSpawnOptions,
  claimLaneForChild,
  createLaneLaunchClaim,
  dispatchInboundTelegramMessage,
  evaluateLaneStartupProof,
  formatInbound,
  isMainTelegramWorkerAlive,
  isStandaloneLaneProcess,
  readLaneClaim,
  resolveRuntimeUiScriptPath,
  status,
} = require('../scripts/hm-telegram-poller-lane');

describe('hm-telegram-poller-lane', () => {
  function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  test('formats inbound videos with saved media path for Architect', () => {
    expect(formatInbound('', '@james', {
      updateId: 10,
      media: {
        kind: 'video',
        localPath: 'D:\\projects\\squidrun\\.squidrun\\runtime\\telegram-inbound-media\\video-10.mp4',
      },
    })).toBe('[Telegram from @james]: [Video received] | saved: D:\\projects\\squidrun\\.squidrun\\runtime\\telegram-inbound-media\\video-10.mp4');
  });

  test('formats document fallback without losing filename', () => {
    expect(formatInbound('', '@james', {
      media: {
        kind: 'document',
        fileName: 'report.pdf',
      },
    })).toBe('[Telegram from @james]: [File: report.pdf]');
  });

  test('dispatches routed non-main inbound messages to profile trigger only', () => {
    const sendToArchitect = jest.fn();
    const forwardToProfileTrigger = jest.fn(() => ({ ok: true, written: ['trigger'] }));

    const result = dispatchInboundTelegramMessage(
      '[Telegram from @ClientProfile]: hello',
      { chatId: '3333333333', updateId: 1 },
      {
        env: { TELEGRAM_CHAT_ID: '1111111111' },
        sendToArchitect,
        forwardToProfileTrigger,
        writeLog: jest.fn(),
        resolveInboundRoute: () => ({
          ok: true,
          chatId: '3333333333',
          windowKey: 'client-profile',
          profile: 'client-profile',
        }),
      }
    );

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      target: 'profile-trigger',
      windowKey: 'client-profile',
    }));
    expect(forwardToProfileTrigger).toHaveBeenCalledWith(
      'client-profile',
      '[Telegram from @ClientProfile]: hello',
      { TELEGRAM_CHAT_ID: '1111111111' }
    );
    expect(sendToArchitect).not.toHaveBeenCalled();
  });

  test('fails closed when inbound route is missing for a non-owner chat', () => {
    const sendToArchitect = jest.fn();
    const forwardToProfileTrigger = jest.fn();

    const result = dispatchInboundTelegramMessage(
      '[Telegram from @ClientProfile]: hello',
      { chatId: '3333333333', updateId: 2 },
      {
        sendToArchitect,
        forwardToProfileTrigger,
        writeLog: jest.fn(),
        resolveInboundRoute: () => ({
          ok: false,
          blocked: true,
          chatId: '3333333333',
          reason: 'missing_inbound_window_route',
        }),
      }
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      blocked: true,
      reason: 'missing_inbound_window_route',
    }));
    expect(sendToArchitect).not.toHaveBeenCalled();
    expect(forwardToProfileTrigger).not.toHaveBeenCalled();
  });

  test('detects only the root-owned main app Telegram worker so standalone lane does not fight getUpdates', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-lane-owner-'));
    const statePath = path.join(tempDir, '.squidrun', 'runtime', 'telegram-poller-state.json');
    const mainWorkerScriptPath = path.join(tempDir, 'ui', 'modules', 'main', 'telegram-poller-worker.js');
    try {
      writeJson(statePath, {
        version: 1,
        updatedAt: '2026-06-12T18:00:00.000Z',
        poller: {
          pid: 1234,
          dataRoot: tempDir,
        },
      });

      expect(isMainTelegramWorkerAlive({
        env: { SQUIDRUN_DATA_ROOT: tempDir },
        mainWorkerScriptPath,
        statePath,
        processListText: [
          `1234 node.exe "${mainWorkerScriptPath}"`,
        ].join('\n'),
      })).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('does not treat a foreign install Telegram worker as this lane owner by process name alone', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-lane-foreign-'));
    const statePath = path.join(tempDir, '.squidrun', 'runtime', 'telegram-poller-state.json');
    const mainWorkerScriptPath = path.join(tempDir, 'ui', 'modules', 'main', 'telegram-poller-worker.js');
    try {
      writeJson(statePath, {
        version: 1,
        updatedAt: '2026-06-12T18:00:00.000Z',
        poller: {
          pid: 9999,
          dataRoot: tempDir,
        },
      });

      expect(isMainTelegramWorkerAlive({
        env: { SQUIDRUN_DATA_ROOT: tempDir },
        mainWorkerScriptPath,
        statePath,
        processListText: [
          '1234 node.exe D:\\SquidRun\\sideprofile\\ui\\modules\\main\\telegram-poller-worker.js',
        ].join('\n'),
      })).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('does not treat unrelated Telegram Desktop as the main app poller', () => {
    expect(isMainTelegramWorkerAlive({
      processListText: [
        '1234 C:\\Program Files\\Telegram Desktop\\Telegram.exe',
        '2345 node D:\\projects\\squidrun\\ui\\scripts\\hm-telegram-poller-lane.js run',
      ].join('\n'),
    })).toBe(false);
  });

  test('launches a detached lane through Electron in Node mode', () => {
    const options = buildStandaloneLaneSpawnOptions(
      'D:\\projects\\squidrun',
      { EXISTING_FLAG: 'kept' },
      42
    );

    expect(options).toEqual(expect.objectContaining({
      cwd: 'D:\\projects\\squidrun',
      detached: true,
      stdio: ['ignore', 42, 42],
      windowsHide: true,
      env: expect.objectContaining({
        EXISTING_FLAG: 'kept',
        ELECTRON_RUN_AS_NODE: '1',
        SQUIDRUN_PROJECT_ROOT: 'D:\\projects\\squidrun',
      }),
    }));
  });

  test('does not accept a live child as started until the child claims the lane pidfile', () => {
    expect(evaluateLaneStartupProof(32852, {
      alive: true,
      claimedPid: null,
      mainWorkerRunning: false,
    })).toEqual(expect.objectContaining({
      ok: false,
      started: false,
      reason: 'lane_child_alive_without_startup_claim',
    }));

    expect(evaluateLaneStartupProof(32852, {
      alive: true,
      claimedPid: 32852,
      claimedToken: 'launch-1',
      expectedToken: 'launch-1',
      mainWorkerRunning: false,
    })).toEqual(expect.objectContaining({
      ok: true,
      started: true,
      reason: 'lane_child_claimed',
    }));
  });

  test('matches only the exact standalone run command for pid-scoped containment', () => {
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'hm-telegram-poller-lane.js');
    const processListText = [
      `32852 node.exe "${scriptPath}" run`,
      '14584 D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe D:\\projects\\squidrun\\ui\\modules\\main\\telegram-poller-worker.js',
    ].join('\n');

    expect(isStandaloneLaneProcess(32852, { processListText, scriptPath })).toBe(true);
    expect(isStandaloneLaneProcess(14584, { processListText, scriptPath })).toBe(false);
  });

  test('rejects wrapper mentions and side-profile scripts as standalone stop authority', () => {
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'hm-telegram-poller-lane.js');
    const wrapperList = [
      `32852 node.exe wrapper.js --probe "${scriptPath}" run --dry-run`,
    ].join('\n');
    const foreignList = [
      '32852 node.exe D:\\SquidRun\\sideprofile\\workspace\\ui\\scripts\\hm-telegram-poller-lane.js run',
    ].join('\n');

    expect(isStandaloneLaneProcess(32852, { processListText: wrapperList, scriptPath })).toBe(false);
    expect(isStandaloneLaneProcess(32852, { processListText: foreignList, scriptPath })).toBe(false);
  });

  test('serializes simultaneous starts and lets only the matching child adopt the claim', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-lane-claim-'));
    const claimPath = path.join(tempDir, 'telegram-poller-lane.pid');
    const scriptPath = path.join(tempDir, 'ui', 'scripts', 'hm-telegram-poller-lane.js');
    try {
      const first = createLaneLaunchClaim({
        claimPath,
        projectRoot: tempDir,
        scriptPath,
        launchToken: 'first-launch',
        launcherPid: 101,
      });
      const second = createLaneLaunchClaim({
        claimPath,
        projectRoot: tempDir,
        scriptPath,
        launchToken: 'second-launch',
        launcherPid: 202,
      });

      expect(first.ok).toBe(true);
      expect(second).toEqual(expect.objectContaining({
        ok: false,
        reason: 'claim_exists',
      }));

      expect(claimLaneForChild({
        claimPath,
        projectRoot: tempDir,
        scriptPath,
        launchToken: 'first-launch',
        pid: 303,
      }).ok).toBe(true);
      expect(claimLaneForChild({
        claimPath,
        projectRoot: tempDir,
        scriptPath,
        launchToken: 'second-launch',
        pid: 404,
      })).toEqual(expect.objectContaining({
        ok: false,
        reason: 'claim_owned_by_another_lane',
      }));
      expect(readLaneClaim(claimPath)).toEqual(expect.objectContaining({
        state: 'running',
        pid: 303,
        launchToken: 'first-launch',
        projectRoot: path.resolve(tempDir),
        scriptPath: path.resolve(scriptPath),
      }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('fails closed when a live claimed pid cannot be identity-probed', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-lane-probe-'));
    const claimPath = path.join(tempDir, 'telegram-poller-lane.pid');
    const scriptPath = path.join(tempDir, 'ui', 'scripts', 'hm-telegram-poller-lane.js');
    try {
      createLaneLaunchClaim({
        claimPath,
        projectRoot: tempDir,
        scriptPath,
        launchToken: 'probe-launch',
      });
      claimLaneForChild({
        claimPath,
        projectRoot: tempDir,
        scriptPath,
        launchToken: 'probe-launch',
        pid: 505,
      });

      expect(status({
        claimPath,
        projectRoot: tempDir,
        scriptPath,
        processListText: '',
        isPidAlive: (pid) => pid === 505,
        env: { SQUIDRUN_DATA_ROOT: tempDir },
        mainWorkerScriptPath: path.join(tempDir, 'ui', 'modules', 'main', 'telegram-poller-worker.js'),
      })).toEqual(expect.objectContaining({
        running: false,
        identityUnverified: true,
        stalePid: null,
        claimMatchesRuntime: true,
      }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('detects exact local main takeover after a stale standalone heartbeat clobbers owner pid', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-lane-handoff-'));
    const statePath = path.join(tempDir, '.squidrun', 'runtime', 'telegram-poller-state.json');
    const mainWorkerScriptPath = path.join(tempDir, 'ui', 'modules', 'main', 'telegram-poller-worker.js');
    try {
      writeJson(statePath, {
        version: 1,
        poller: {
          pid: 111,
          dataRoot: tempDir,
          lastPollStatus: 'ok_empty',
        },
      });

      expect(isMainTelegramWorkerAlive({
        env: { SQUIDRUN_DATA_ROOT: tempDir },
        mainWorkerScriptPath,
        statePath,
        processListText: `222 node.exe "${mainWorkerScriptPath}"`,
      })).toBe(true);
      expect(isMainTelegramWorkerAlive({
        env: { SQUIDRUN_DATA_ROOT: tempDir },
        mainWorkerScriptPath,
        statePath,
        processListText: '333 node.exe D:\\SquidRun\\sideprofile\\ui\\modules\\main\\telegram-poller-worker.js',
      })).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('resolves hm-send from runtime bin when source ui scripts are absent', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-lane-runtime-path-'));
    try {
      const runtimeHmSend = path.join(tempDir, '.squidrun', 'bin', 'runtime', 'ui', 'scripts', 'hm-send.js');
      fs.mkdirSync(path.dirname(runtimeHmSend), { recursive: true });
      fs.writeFileSync(runtimeHmSend, 'module.exports = {};\n', 'utf8');

      expect(resolveRuntimeUiScriptPath(tempDir, 'hm-send.js')).toBe(runtimeHmSend);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
