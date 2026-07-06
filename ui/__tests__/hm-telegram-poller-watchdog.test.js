const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  inspectTelegramPollerFreshness,
  recoverWedgedTelegramPoller,
} = require('../scripts/hm-telegram-poller-watchdog');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('hm-telegram-poller-watchdog', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-poller-watchdog-'));
    fs.mkdirSync(path.join(tempDir, '.squidrun', 'runtime'), { recursive: true });
    writeJson(path.join(tempDir, '.squidrun', 'app-status.json'), {
      session: 405,
      started: '2026-06-06T04:00:00.000Z',
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('stale poller state is treated as wedged while the app is up and chooses app restart recovery', async () => {
    writeJson(path.join(tempDir, '.squidrun', 'runtime', 'telegram-poller-state.json'), {
      version: 1,
      updatedAt: '2026-06-06T04:00:00.000Z',
      poller: {
        lastPollStatus: 'ok_empty',
        nextOffset: 808,
      },
    });

    const freshness = inspectTelegramPollerFreshness({
      projectRoot: tempDir,
      nowMs: Date.parse('2026-06-06T04:20:00.000Z'),
      staleThresholdMs: 10 * 60 * 1000,
    });

    expect(freshness).toEqual(expect.objectContaining({
      status: 'stale',
      wedged: true,
      ageMs: 20 * 60 * 1000,
    }));

    const runAppRestart = jest.fn(() => {
      writeJson(path.join(tempDir, '.squidrun', 'runtime', 'telegram-poller-state.json'), {
        version: 1,
        updatedAt: new Date().toISOString(),
        poller: {
          lastPollStatus: 'ok_empty',
          nextOffset: 808,
        },
      });
      return {
        ok: true,
        result: {
          success: true,
          started: true,
        },
      };
    });
    const notifyJames = jest.fn(() => ({ ok: true, message: 'restored' }));
    const startStandaloneLane = jest.fn();

    const recovery = await recoverWedgedTelegramPoller({
      projectRoot: tempDir,
      freshness,
      runAppRestart,
      notifyJames,
      appRestartVerifyMs: 1,
      startStandaloneLane,
      standaloneStatus: { running: false },
    });

    expect(recovery).toEqual(expect.objectContaining({
      ok: true,
      action: 'app_restart',
      recovered: true,
    }));
    expect(runAppRestart).toHaveBeenCalledWith(
      tempDir,
      'telegram-poller-freshness-stale:20m'
    );
    expect(notifyJames).toHaveBeenCalledWith(
      tempDir,
      freshness,
      expect.objectContaining({ reason: 'telegram-poller-freshness-stale:20m' })
    );
    expect(startStandaloneLane).not.toHaveBeenCalled();

    const watchdogLog = fs.readFileSync(
      path.join(tempDir, '.squidrun', 'runtime', 'telegram-poller-watchdog.log'),
      'utf8'
    );
    expect(watchdogLog).toContain('[detect] status=stale');
    expect(watchdogLog).toContain('[recover] app-control restart succeeded');
  });

  test('successful app restart is not trusted until freshness is verified', async () => {
    const freshness = {
      status: 'stale',
      wedged: true,
      ageMs: 20 * 60 * 1000,
      staleThresholdMs: 10 * 60 * 1000,
    };
    writeJson(path.join(tempDir, '.squidrun', 'runtime', 'telegram-poller-state.json'), {
      version: 1,
      updatedAt: '2026-06-06T04:00:00.000Z',
      poller: {
        lastPollStatus: 'ok_empty',
        nextOffset: 808,
      },
    });

    const runAppRestart = jest.fn(() => ({
      ok: true,
      result: {
        success: true,
        started: true,
      },
    }));
    const startStandaloneLane = jest.fn(() => ({
      ok: true,
      started: true,
      pid: 470996,
    }));
    const notifyJames = jest.fn(() => ({ ok: true, message: 'restored' }));

    const recovery = await recoverWedgedTelegramPoller({
      projectRoot: tempDir,
      freshness,
      appRestartVerifyMs: 1,
      isMainWorkerAlive: () => false,
      notifyJames,
      processListText: '',
      runAppRestart,
      startStandaloneLane,
      standaloneStatus: { running: false },
    });

    expect(recovery).toEqual(expect.objectContaining({
      ok: true,
      action: 'standalone_lane',
      recovered: true,
    }));
    expect(startStandaloneLane).toHaveBeenCalledTimes(1);
    const watchdogLog = fs.readFileSync(
      path.join(tempDir, '.squidrun', 'runtime', 'telegram-poller-watchdog.log'),
      'utf8'
    );
    expect(watchdogLog).toContain('app-control restart UNVERIFIED');
  });

  test('failed app restart kills the stale worker before choosing standalone lane fallback', async () => {
    const freshness = {
      status: 'stale',
      wedged: true,
      ageMs: 43 * 60 * 1000,
      staleThresholdMs: 10 * 60 * 1000,
    };
    writeJson(path.join(tempDir, '.squidrun', 'runtime', 'telegram-poller-state.json'), {
      version: 1,
      updatedAt: '2026-06-06T04:00:00.000Z',
      poller: {
        pid: 68752,
        dataRoot: tempDir,
        lastPollStatus: 'ok_empty',
      },
    });
    const runAppRestart = jest.fn(() => ({
      ok: false,
      result: {
        success: false,
        reason: 'app_control_unavailable',
      },
    }));
    const notifyJames = jest.fn(() => ({ ok: true, message: 'restored' }));
    const startStandaloneLane = jest.fn(() => ({
      ok: true,
      started: true,
      pid: 470996,
    }));

    const recovery = await recoverWedgedTelegramPoller({
      projectRoot: tempDir,
      freshness,
      dryRun: true,
      isMainWorkerAlive: () => false,
      notifyJames,
      processListText: '68752 node D:\\projects\\squidrun\\ui\\modules\\main\\telegram-poller-worker.js',
      runAppRestart,
      startStandaloneLane,
      standaloneStatus: { running: false },
    });

    expect(recovery).toEqual(expect.objectContaining({
      ok: true,
      action: 'standalone_lane',
      recovered: true,
    }));
    expect(recovery.killResult.killed).toEqual([{
      pid: 68752,
      dryRun: true,
    }]);
    expect(startStandaloneLane).toHaveBeenCalledTimes(1);
    expect(notifyJames).not.toHaveBeenCalled();
    expect(recovery.notice).toBeNull();
  });

  test('dry-run app restart success does not send a live recovered notice', async () => {
    const freshness = {
      status: 'stale',
      wedged: true,
      ageMs: 20 * 60 * 1000,
      staleThresholdMs: 10 * 60 * 1000,
    };
    const runAppRestart = jest.fn(() => ({
      ok: true,
      result: {
        success: true,
        started: true,
      },
    }));
    const notifyJames = jest.fn(() => ({ ok: true, message: 'restored' }));

    const recovery = await recoverWedgedTelegramPoller({
      projectRoot: tempDir,
      freshness,
      dryRun: true,
      runAppRestart,
      notifyJames,
      standaloneStatus: { running: false },
    });

    expect(recovery).toEqual(expect.objectContaining({
      ok: true,
      action: 'app_restart',
      recovered: true,
      notice: null,
    }));
    expect(notifyJames).not.toHaveBeenCalled();
  });

  test('failed app restart does not kill a foreign install worker with the same script name', async () => {
    const freshness = {
      status: 'stale',
      wedged: true,
      ageMs: 43 * 60 * 1000,
      staleThresholdMs: 10 * 60 * 1000,
    };
    writeJson(path.join(tempDir, '.squidrun', 'runtime', 'telegram-poller-state.json'), {
      version: 1,
      updatedAt: '2026-06-06T04:00:00.000Z',
      poller: {
        pid: 99999,
        dataRoot: tempDir,
        lastPollStatus: 'ok_empty',
      },
    });
    const runAppRestart = jest.fn(() => ({
      ok: false,
      result: {
        success: false,
        reason: 'app_control_unavailable',
      },
    }));
    const startStandaloneLane = jest.fn(() => ({
      ok: true,
      started: true,
      pid: 470996,
    }));

    const recovery = await recoverWedgedTelegramPoller({
      projectRoot: tempDir,
      freshness,
      dryRun: true,
      isMainWorkerAlive: () => false,
      notifyJames: jest.fn(() => ({ ok: true, message: 'restored' })),
      processListText: '68752 node D:\\projects\\squidrun\\ui\\modules\\main\\telegram-poller-worker.js',
      runAppRestart,
      startStandaloneLane,
      standaloneStatus: { running: false },
    });

    expect(recovery).toEqual(expect.objectContaining({
      ok: true,
      action: 'standalone_lane',
      recovered: true,
    }));
    expect(recovery.killResult.killed).toEqual([]);
    expect(startStandaloneLane).toHaveBeenCalledTimes(1);
  });

  test('failed app restart refuses same-pid worker when token ownership does not match', async () => {
    const freshness = {
      status: 'stale',
      wedged: true,
      ageMs: 43 * 60 * 1000,
      staleThresholdMs: 10 * 60 * 1000,
    };
    writeJson(path.join(tempDir, '.squidrun', 'runtime', 'telegram-poller-state.json'), {
      version: 1,
      updatedAt: '2026-06-06T04:00:00.000Z',
      poller: {
        pid: 68752,
        dataRoot: tempDir,
        tokenFingerprint: 'foreign-token-fp',
        lastPollStatus: 'ok_empty',
      },
    });
    const startStandaloneLane = jest.fn(() => ({
      ok: true,
      started: true,
      pid: 470996,
    }));

    const recovery = await recoverWedgedTelegramPoller({
      projectRoot: tempDir,
      env: {
        TELEGRAM_BOT_TOKEN: 'owned-token',
        SQUIDRUN_DATA_ROOT: tempDir,
      },
      freshness,
      dryRun: true,
      isMainWorkerAlive: () => false,
      notifyJames: jest.fn(() => ({ ok: true, message: 'restored' })),
      processListText: '68752 node D:\\projects\\squidrun\\ui\\modules\\main\\telegram-poller-worker.js',
      runAppRestart: jest.fn(() => ({
        ok: false,
        result: { success: false, reason: 'app_control_unavailable' },
      })),
      startStandaloneLane,
      standaloneStatus: { running: false },
    });

    expect(recovery.killResult.killed).toEqual([]);
    expect(recovery.killResult.skipped).toEqual([]);
    expect(startStandaloneLane).toHaveBeenCalledTimes(1);
  });

  test('existing standalone lane is restarted instead of starting an app worker', async () => {
    const freshness = {
      status: 'stale',
      wedged: true,
      ageMs: 11 * 60 * 1000,
      staleThresholdMs: 10 * 60 * 1000,
    };
    const runAppRestart = jest.fn();
    const restartStandaloneLane = jest.fn(() => ({
      ok: true,
      started: {
        ok: true,
        pid: 470997,
      },
    }));
    const notifyJames = jest.fn(() => ({ ok: true, message: 'restored' }));

    const recovery = await recoverWedgedTelegramPoller({
      projectRoot: tempDir,
      freshness,
      notifyJames,
      restartStandaloneLane,
      runAppRestart,
      standaloneStatus: {
        running: true,
        pid: 470996,
      },
    });

    expect(recovery).toEqual(expect.objectContaining({
      ok: true,
      action: 'standalone_lane_restart',
      recovered: true,
    }));
    expect(runAppRestart).not.toHaveBeenCalled();
    expect(restartStandaloneLane).toHaveBeenCalledTimes(1);
    expect(notifyJames).toHaveBeenCalledWith(
      tempDir,
      freshness,
      expect.objectContaining({ reason: 'telegram-poller-freshness-stale:11m' })
    );
  });

  test('dry-run standalone lane restart does not send a live recovered notice', async () => {
    const freshness = {
      status: 'stale',
      wedged: true,
      ageMs: 11 * 60 * 1000,
      staleThresholdMs: 10 * 60 * 1000,
    };
    const runAppRestart = jest.fn();
    const restartStandaloneLane = jest.fn();
    const notifyJames = jest.fn(() => ({ ok: true, message: 'restored' }));

    const recovery = await recoverWedgedTelegramPoller({
      projectRoot: tempDir,
      freshness,
      dryRun: true,
      notifyJames,
      restartStandaloneLane,
      runAppRestart,
      standaloneStatus: {
        running: true,
        pid: 470996,
      },
    });

    expect(recovery).toEqual(expect.objectContaining({
      ok: true,
      action: 'standalone_lane_restart',
      recovered: true,
      notice: null,
    }));
    expect(runAppRestart).not.toHaveBeenCalled();
    expect(restartStandaloneLane).not.toHaveBeenCalled();
    expect(notifyJames).not.toHaveBeenCalled();
  });
});
