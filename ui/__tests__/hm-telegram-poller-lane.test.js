const childProcess = require('child_process');
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
  stopLane,
} = require('../scripts/hm-telegram-poller-lane');

function waitForFiles(filePaths, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (filePaths.every((filePath) => fs.existsSync(filePath))) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${filePaths.join(', ')}`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function spawnLeaseContender(lockPath, readyPath, goPath, token) {
  const leaseModulePath = path.resolve(__dirname, '..', 'modules', 'cross-process-lease.js');
  const script = `
    const fs = require('fs');
    const { acquireProcessLease, releaseProcessLease } = require(process.argv[1]);
    const [lockPath, readyPath, goPath, token] = process.argv.slice(2);
    fs.writeFileSync(readyPath, String(process.pid));
    while (!fs.existsSync(goPath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    const lease = acquireProcessLease(lockPath, {
      timeoutMs: 0,
      staleMs: 1000,
      lockToken: token,
    });
    if (lease.ok) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    const released = lease.ok ? releaseProcessLease(lease) : false;
    process.stdout.write(JSON.stringify({
      ok: lease.ok,
      reason: lease.reason || null,
      token,
      released,
    }));
  `;
  const child = childProcess.spawn(
    process.execPath,
    ['-e', script, leaseModulePath, lockPath, readyPath, goPath, token],
    {
      cwd: path.resolve(__dirname, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Lease contender ${token} exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
  return { child, done };
}

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

  test('mutation lease recovers only aged dead or ownerless locks and never steals fresh or live owners', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-lane-lease-recovery-'));
    const scriptPath = path.join(tempDir, 'ui', 'scripts', 'hm-telegram-poller-lane.js');
    const oldTimestamp = new Date('2000-01-01T00:00:00.000Z');
    const seedLock = (claimPath, owner = null) => {
      const lockPath = `${claimPath}.mutation-lock`;
      fs.mkdirSync(lockPath, { recursive: true });
      if (owner) writeJson(path.join(lockPath, 'owner.json'), owner);
      return lockPath;
    };

    try {
      const deadOwnerClaim = path.join(tempDir, 'dead-owner', 'telegram-poller-lane.pid');
      seedLock(deadOwnerClaim, {
        version: 1,
        pid: 999999,
        lockToken: 'dead-owner',
        createdAt: oldTimestamp.toISOString(),
      });
      expect(createLaneLaunchClaim({
        claimPath: deadOwnerClaim,
        projectRoot: tempDir,
        scriptPath,
        launchToken: 'dead-owner-recovered',
        claimMutationLockStaleMs: 10,
        claimMutationLockTimeoutMs: 100,
        isClaimMutationLockOwnerAlive: () => false,
      })).toEqual(expect.objectContaining({ ok: true }));
      expect(fs.existsSync(`${deadOwnerClaim}.mutation-lock`)).toBe(false);

      const ownerlessClaim = path.join(tempDir, 'ownerless-aged', 'telegram-poller-lane.pid');
      const ownerlessLock = seedLock(ownerlessClaim);
      fs.utimesSync(ownerlessLock, oldTimestamp, oldTimestamp);
      expect(createLaneLaunchClaim({
        claimPath: ownerlessClaim,
        projectRoot: tempDir,
        scriptPath,
        launchToken: 'ownerless-recovered',
        claimMutationLockStaleMs: 10,
        claimMutationLockTimeoutMs: 100,
      })).toEqual(expect.objectContaining({ ok: true }));
      expect(fs.existsSync(ownerlessLock)).toBe(false);

      const freshClaim = path.join(tempDir, 'ownerless-fresh', 'telegram-poller-lane.pid');
      const freshLock = seedLock(freshClaim);
      expect(createLaneLaunchClaim({
        claimPath: freshClaim,
        projectRoot: tempDir,
        scriptPath,
        launchToken: 'fresh-must-not-win',
        claimMutationLockStaleMs: 60_000,
        claimMutationLockTimeoutMs: 0,
      })).toEqual(expect.objectContaining({
        ok: false,
        reason: 'claim_mutation_lock_timeout',
      }));
      expect(fs.existsSync(freshLock)).toBe(true);
      expect(fs.existsSync(freshClaim)).toBe(false);

      const liveClaim = path.join(tempDir, 'live-owner', 'telegram-poller-lane.pid');
      const liveLock = seedLock(liveClaim, {
        version: 1,
        pid: 77777,
        lockToken: 'live-owner',
        createdAt: oldTimestamp.toISOString(),
      });
      expect(createLaneLaunchClaim({
        claimPath: liveClaim,
        projectRoot: tempDir,
        scriptPath,
        launchToken: 'live-must-not-lose',
        claimMutationLockStaleMs: 10,
        claimMutationLockTimeoutMs: 0,
        isClaimMutationLockOwnerAlive: (pid) => Number(pid) === 77777,
      })).toEqual(expect.objectContaining({
        ok: false,
        reason: 'claim_mutation_lock_timeout',
      }));
      expect(fs.existsSync(liveLock)).toBe(true);
      expect(fs.existsSync(liveClaim)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('real Node processes contend on one lease with one winner and no leaked lock', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-lease-contention-'));
    const lockPath = path.join(tempDir, 'telegram-poller-state.poll-dispatch-lease');
    const readyA = path.join(tempDir, 'ready-a');
    const readyB = path.join(tempDir, 'ready-b');
    const goPath = path.join(tempDir, 'go');
    const contenderA = spawnLeaseContender(lockPath, readyA, goPath, 'contender-a');
    const contenderB = spawnLeaseContender(lockPath, readyB, goPath, 'contender-b');

    try {
      await waitForFiles([readyA, readyB]);
      fs.writeFileSync(goPath, 'go\n', 'utf8');
      const results = await Promise.all([contenderA.done, contenderB.done]);
      expect(results.filter((entry) => entry.ok)).toHaveLength(1);
      expect(results.filter((entry) => entry.reason === 'lease_busy')).toHaveLength(1);
      expect(results.find((entry) => entry.ok)).toEqual(expect.objectContaining({
        released: true,
      }));
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      for (const contender of [contenderA, contenderB]) {
        if (contender.child.exitCode === null) contender.child.kill();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('child adoption cannot overwrite a replacement claim installed after validation', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-lane-adoption-cas-'));
    const claimPath = path.join(tempDir, 'telegram-poller-lane.pid');
    const scriptPath = path.join(tempDir, 'ui', 'scripts', 'hm-telegram-poller-lane.js');
    try {
      createLaneLaunchClaim({
        claimPath,
        projectRoot: tempDir,
        scriptPath,
        launchToken: 'claim-a',
        launcherPid: 101,
      });

      const result = claimLaneForChild({
        claimPath,
        projectRoot: tempDir,
        scriptPath,
        launchToken: 'claim-a',
        pid: 303,
        beforeClaimMutationCommit: () => {
          writeJson(claimPath, {
            version: 2,
            state: 'running',
            pid: 404,
            launcherPid: null,
            launchToken: 'claim-b',
            projectRoot: path.resolve(tempDir),
            scriptPath: path.resolve(scriptPath),
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
          });
        },
      });

      expect(result).toEqual(expect.objectContaining({
        ok: false,
        reason: 'claim_changed_during_adoption',
      }));
      expect(readLaneClaim(claimPath)).toEqual(expect.objectContaining({
        state: 'running',
        pid: 404,
        launchToken: 'claim-b',
      }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test.each([
    ['not_running', false, '99999 node.exe harmless.js'],
    ['pid_identity_mismatch', true, '33333 node.exe wrapper.js'],
  ])('conditional stop cleanup preserves replacement claim for %s', (expectedStatus, pidAlive, processListText) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-lane-stop-cas-'));
    const claimPath = path.join(tempDir, 'telegram-poller-lane.pid');
    const scriptPath = path.join(tempDir, 'ui', 'scripts', 'hm-telegram-poller-lane.js');
    const claimA = {
      version: 2,
      state: 'running',
      pid: 33333,
      launcherPid: null,
      launchToken: 'claim-a',
      projectRoot: path.resolve(tempDir),
      scriptPath: path.resolve(scriptPath),
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    };
    const claimB = {
      ...claimA,
      pid: 44444,
      launchToken: 'claim-b',
    };
    try {
      writeJson(claimPath, claimA);
      const options = {
        claimPath,
        projectRoot: tempDir,
        scriptPath,
        processListText,
        isPidAlive: (pid) => pidAlive && Number(pid) === 33333,
        env: { SQUIDRUN_DATA_ROOT: tempDir },
        mainWorkerScriptPath: path.join(tempDir, 'ui', 'modules', 'main', 'telegram-poller-worker.js'),
        beforeClaimMutationCommit: () => writeJson(claimPath, claimB),
      };
      const before = status(options);
      if (expectedStatus === 'pid_identity_mismatch') {
        expect(before.stalePid).toBe(33333);
      } else {
        expect(before.running).toBe(false);
        expect(before.stalePid).toBeNull();
      }
      const result = stopLane(options);

      expect(result).toEqual(expect.objectContaining({
        ok: false,
        stopped: false,
        reason: 'lane_claim_changed_during_cleanup',
      }));
      expect(readLaneClaim(claimPath)).toEqual(expect.objectContaining({
        pid: 44444,
        launchToken: 'claim-b',
      }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('live exact legacy numeric claim is active and fails closed instead of being deleted', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-lane-legacy-'));
    const claimPath = path.join(tempDir, 'telegram-poller-lane.pid');
    const scriptPath = path.join(tempDir, 'ui', 'scripts', 'hm-telegram-poller-lane.js');
    try {
      fs.mkdirSync(path.dirname(claimPath), { recursive: true });
      fs.writeFileSync(claimPath, '11111\n', 'utf8');
      const options = {
        claimPath,
        projectRoot: tempDir,
        scriptPath,
        processListText: `11111 node.exe "${scriptPath}" run`,
        isPidAlive: (pid) => Number(pid) === 11111,
        env: { SQUIDRUN_DATA_ROOT: tempDir },
        mainWorkerScriptPath: path.join(tempDir, 'ui', 'modules', 'main', 'telegram-poller-worker.js'),
      };

      expect(status(options)).toEqual(expect.objectContaining({
        running: true,
        pid: 11111,
        stalePid: null,
        legacyClaimActive: true,
      }));
      expect(stopLane(options)).toEqual(expect.objectContaining({
        ok: false,
        stopped: false,
        reason: 'legacy_lane_claim_active',
        pid: 11111,
      }));
      expect(fs.readFileSync(claimPath, 'utf8').trim()).toBe('11111');
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
