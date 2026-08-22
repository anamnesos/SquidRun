const fs = require('fs');
const os = require('os');
const path = require('path');
let childProcess;

jest.mock('child_process', () => ({
  spawn: jest.fn(() => ({
    pid: 9876,
    unref: jest.fn(),
  })),
}));

describe('hm-bidirectional-wake-watchdog runner control', () => {
  let tempRoot;
  let moduleUnderTest;
  const runnerScriptPath = path.resolve(__dirname, '..', 'scripts', 'hm-bidirectional-wake-watchdog.js');

  function processRow(pid, commandLine) {
    return {
      pid,
      name: 'node.exe',
      executablePath: 'C:\\Program Files\\nodejs\\node.exe',
      commandLine,
    };
  }

  function exactRunnerRow(pid) {
    return processRow(
      pid,
      `"C:\\Program Files\\nodejs\\node.exe" "${runnerScriptPath}" run --interval-ms 60000`
    );
  }

  function ownershipProbe({ alivePids = [], rows = [], scan = null } = {}) {
    const live = new Set(alivePids.map(Number));
    return {
      probePid: jest.fn((pid) => ({
        known: true,
        alive: live.has(Number(pid)),
        pid: Number(pid),
        error: null,
      })),
      getProcessScan: jest.fn(() => scan || {
        ok: true,
        source: 'test',
        rows,
        error: null,
      }),
    };
  }

  beforeEach(() => {
    jest.resetModules();
    childProcess = require('child_process');
    childProcess.spawn.mockClear();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-bidir-wake-runner-'));
    jest.doMock('../config', () => ({
      ROLE_ID_MAP: { architect: '1', builder: '2', oracle: '3' },
      getProjectRoot: () => tempRoot,
      resolveCoordPath: (relPath) => path.join(
        tempRoot,
        '.squidrun',
        String(relPath || '')
          .replace(/^[/\\]+/, '')
          .replace(/[/\\]+/g, path.sep)
      ),
      resolveWebSocketPortInfo: () => ({ port: 9900, source: 'test' }),
    }));
    moduleUnderTest = require('../scripts/hm-bidirectional-wake-watchdog');
  });

  afterEach(() => {
    jest.dontMock('../config');
    jest.restoreAllMocks();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('startRunner fails closed for split live pidfile/status ownership with unreadable identity', () => {
    const pidPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog.pid');
    const statusPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-status.json');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(pidPath, '33400', 'utf8');
    fs.writeFileSync(statusPath, JSON.stringify({
      version: 1,
      role: 'bidirectional-wake-watchdog',
      pid: 33380,
      appGenerationId: null,
      running: true,
      intervalMs: 60_000,
      heartbeatAt: new Date().toISOString(),
    }, null, 2), 'utf8');
    const pidBytes = fs.readFileSync(pidPath);
    const statusBytes = fs.readFileSync(statusPath);
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ownership conflict must not probe or signal through process.kill');
    });
    const probe = ownershipProbe({
      alivePids: [33400, 33380],
      rows: [
        exactRunnerRow(33400),
        processRow(33380, null),
      ],
    });

    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      appGenerationId: 'app-gen-current',
      ownershipProbe: probe,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ownership_conflict',
      reason: 'ownership_conflict',
      blocked: true,
      retryable: false,
    }));
    expect(result.ownership).toEqual(expect.objectContaining({
      pidFilePid: 33400,
      statusPid: 33380,
      conflicts: expect.arrayContaining([
        expect.objectContaining({ code: 'pid_status_mismatch' }),
        expect.objectContaining({ code: 'live_identity_unreadable', pid: 33380 }),
      ]),
    }));
    expect(killSpy).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(pidPath)).toEqual(pidBytes);
    expect(fs.readFileSync(statusPath)).toEqual(statusBytes);
  });

  test('stopRunner preserves split-owner metadata and signals no process', () => {
    const pidPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog.pid');
    const statusPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-status.json');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(pidPath, '33400', 'utf8');
    fs.writeFileSync(statusPath, JSON.stringify({
      role: 'bidirectional-wake-watchdog',
      pid: 33380,
      appGenerationId: null,
      running: true,
      heartbeatAt: new Date().toISOString(),
    }, null, 2), 'utf8');
    const pidBytes = fs.readFileSync(pidPath);
    const statusBytes = fs.readFileSync(statusPath);
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('conflicted stop must not signal');
    });

    const result = moduleUnderTest.stopRunner({
      ownershipProbe: ownershipProbe({
        alivePids: [33400, 33380],
        rows: [exactRunnerRow(33400), processRow(33380, null)],
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ownership_conflict',
      operation: 'stop',
    }));
    expect(killSpy).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(pidPath)).toEqual(pidBytes);
    expect(fs.readFileSync(statusPath)).toEqual(statusBytes);
  });

  test('restart aborts after a conflicted stop without invoking start', async () => {
    const stopResult = {
      ok: false,
      status: 'ownership_conflict',
      reason: 'ownership_conflict',
      blocked: true,
      retryable: false,
    };
    const stopControl = jest.fn(() => stopResult);
    const startControl = jest.fn();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await moduleUnderTest.runCli(
      { positional: ['restart'], options: new Map() },
      { stopRunner: stopControl, startRunner: startControl }
    );

    expect(result).toEqual(expect.objectContaining({
      ...stopResult,
      restartAborted: true,
    }));
    expect(stopControl).toHaveBeenCalledTimes(1);
    expect(startControl).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  test.each(['--help', '-h'])('%s prints help without starting, stopping, or writing runner metadata', async (flag) => {
    const startControl = jest.fn();
    const stopControl = jest.fn();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const argv = moduleUnderTest.parseCliArgs([flag]);

    const result = await moduleUnderTest.runCli(argv, {
      startRunner: startControl,
      stopRunner: stopControl,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      help: true,
      usage: expect.stringContaining('Show this help without starting a runner'),
    }));
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(startControl).not.toHaveBeenCalled();
    expect(stopControl).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog.pid'))).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-status.json'))).toBe(false);
  });

  test('startRunner recovers mismatched metadata only when every referenced pid is proven dead', () => {
    const pidPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog.pid');
    const statusPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-status.json');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(pidPath, '33400', 'utf8');
    fs.writeFileSync(statusPath, JSON.stringify({
      role: 'bidirectional-wake-watchdog',
      pid: 33380,
      running: true,
      heartbeatAt: '2026-01-01T00:00:00.000Z',
    }), 'utf8');
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('dead stale owners must not be signalled');
    });

    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      ownershipProbe: ownershipProbe({
        alivePids: [],
        rows: [],
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      started: true,
      pid: 9876,
    }));
    expect(killSpy).not.toHaveBeenCalled();
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe('9876');
    expect(fs.existsSync(statusPath)).toBe(false);
  });

  test('startRunner recheck turns a clean-to-conflict race into a mutation-free refusal', () => {
    const lockPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-start.lock');
    const racedPid = 45670;
    const probe = ownershipProbe();
    probe.getProcessScan
      .mockReturnValueOnce({ ok: true, source: 'test', rows: [], error: null })
      .mockReturnValueOnce({
        ok: true,
        source: 'test',
        rows: [exactRunnerRow(racedPid)],
        error: null,
      });
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('raced ownership conflict must not signal');
    });

    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      ownershipProbe: probe,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ownership_conflict',
      phase: 'under_start_lock',
    }));
    expect(result.ownership.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'unclaimed_exact_runner_owner',
        pid: racedPid,
      }),
    ]));
    expect(killSpy).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('startRunner fails closed when process enumeration is uncertain', () => {
    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      ownershipProbe: ownershipProbe({
        scan: {
          ok: false,
          source: 'test',
          rows: [],
          error: 'access denied',
        },
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ownership_conflict',
      phase: 'initial',
    }));
    expect(result.ownership.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'process_enumeration_uncertain' }),
    ]));
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test('startRunner fails closed when a referenced pid liveness probe is uncertain', () => {
    const pid = 46000;
    const pidPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog.pid');
    const statusPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-status.json');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(pidPath, String(pid), 'utf8');
    fs.writeFileSync(statusPath, JSON.stringify({
      role: 'bidirectional-wake-watchdog',
      pid,
      running: true,
      heartbeatAt: new Date().toISOString(),
    }), 'utf8');
    const probe = ownershipProbe({ rows: [exactRunnerRow(pid)] });
    probe.probePid.mockReturnValue({
      known: false,
      alive: null,
      pid,
      error: 'access denied',
      code: 'EPERM',
    });

    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      ownershipProbe: probe,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ownership_conflict',
      phase: 'initial',
    }));
    expect(result.ownership.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'pid_liveness_uncertain',
        pid,
      }),
    ]));
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test('exact runner identity rejects wrapper mentions and sideprofile same-name paths', () => {
    const wrapper = processRow(
      501,
      `"C:\\Program Files\\nodejs\\node.exe" "D:\\tools\\wrapper.js" --probe "${runnerScriptPath}" run`
    );
    const sideprofile = processRow(
      502,
      '"C:\\Program Files\\nodejs\\node.exe" "D:\\SquidRun\\sideprofile\\workspace\\ui\\scripts\\hm-bidirectional-wake-watchdog.js" run'
    );

    expect(moduleUnderTest.isExactRunnerProcessRow(exactRunnerRow(500))).toBe(true);
    expect(moduleUnderTest.isExactRunnerProcessRow(wrapper)).toBe(false);
    expect(moduleUnderTest.isExactRunnerProcessRow(sideprofile)).toBe(false);
  });

  test('exact runner identity accepts only the supported unambiguous Windows argv shape', () => {
    const spacedScriptPath = 'D:\\projects\\Squid Run\\ui\\scripts\\hm-bidirectional-wake-watchdog.js';
    const exactWithSpaces = processRow(
      600,
      `"C:\\Program Files\\nodejs\\node.exe" "${spacedScriptPath}" run --interval-ms 60000`
    );
    const powershellWrapper = {
      ...processRow(601, `"powershell.exe" "${runnerScriptPath}" run`),
      name: 'powershell.exe',
      executablePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    };
    const cmdWrapper = {
      ...processRow(602, `"cmd.exe" /c "node.exe \\"${runnerScriptPath}\\" run"`),
      name: 'cmd.exe',
      executablePath: 'C:\\Windows\\System32\\cmd.exe',
    };
    const rejected = [
      powershellWrapper,
      cmdWrapper,
      processRow(603, `"node.exe" -e "console.log('${runnerScriptPath} run')"`),
      processRow(604, `"node.exe" --inspect "${runnerScriptPath}" run`),
      processRow(605, `"node.exe" "D:\\foreign\\ui\\scripts\\hm-bidirectional-wake-watchdog.js" run`),
      processRow(606, `"node.exe" ""${runnerScriptPath}"" run`),
      processRow(607, `"node.exe" \\"${runnerScriptPath}\\" run`),
      processRow(608, `"node.exe" "${runnerScriptPath} run`),
    ];

    expect(moduleUnderTest.isExactRunnerProcessRow(exactWithSpaces, spacedScriptPath)).toBe(true);
    for (const row of rejected) {
      expect(moduleUnderTest.isExactRunnerProcessRow(row)).toBe(false);
    }
  });

  test('malformed quoted identity for a referenced live pid is a mutation-free conflict', () => {
    const pid = 610;
    const pidPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog.pid');
    const statusPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-status.json');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(pidPath, String(pid), 'utf8');
    fs.writeFileSync(statusPath, JSON.stringify({
      role: 'bidirectional-wake-watchdog',
      pid,
      running: true,
      heartbeatAt: new Date().toISOString(),
    }), 'utf8');
    const pidBytes = fs.readFileSync(pidPath);
    const statusBytes = fs.readFileSync(statusPath);
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ambiguous identity must not signal');
    });

    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      ownershipProbe: ownershipProbe({
        alivePids: [pid],
        rows: [processRow(pid, `"node.exe" "${runnerScriptPath} run`)],
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ownership_conflict',
    }));
    expect(result.ownership.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'live_identity_mismatch', pid }),
    ]));
    expect(killSpy).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(pidPath)).toEqual(pidBytes);
    expect(fs.readFileSync(statusPath)).toEqual(statusBytes);
  });

  test('startRunner reuses a fresh exact pidfile-only child while status is pending', () => {
    const pid = 620;
    const pidPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog.pid');
    const statusPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-status.json');
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, String(pid), 'utf8');
    const pidBytes = fs.readFileSync(pidPath);
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('verified starting owner must not be signalled');
    });

    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      appGenerationId: 'app-gen-current',
      ownershipProbe: ownershipProbe({
        alivePids: [pid],
        rows: [exactRunnerRow(pid)],
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      alreadyStarting: true,
      starting: true,
      staleGeneration: false,
      ownership: expect.objectContaining({
        ok: true,
        status: 'verified_starting_owner',
        verifiedStartingOwner: true,
      }),
    }));
    expect(killSpy).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(pidPath)).toEqual(pidBytes);
    expect(fs.existsSync(statusPath)).toBe(false);
  });

  test('stopRunner fails closed on a verified-starting owner without orphaning it', () => {
    const pid = 624;
    const pidPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog.pid');
    const statusPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-status.json');
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, String(pid), 'utf8');
    const pidBytes = fs.readFileSync(pidPath);
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('starting owner stop must fail closed without signalling');
    });

    const result = moduleUnderTest.stopRunner({
      ownershipProbe: ownershipProbe({
        alivePids: [pid],
        rows: [exactRunnerRow(pid)],
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'owner_start_in_progress',
      reason: 'owner_start_in_progress',
      blocked: true,
      retryable: false,
      operation: 'stop',
      pid,
    }));
    expect(killSpy).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(pidPath)).toEqual(pidBytes);
    expect(fs.existsSync(statusPath)).toBe(false);
  });

  test('restart aborts before fallback when the exact owner is still starting', async () => {
    const pid = 625;
    const pidPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog.pid');
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, String(pid), 'utf8');
    const pidBytes = fs.readFileSync(pidPath);
    const probe = ownershipProbe({
      alivePids: [pid],
      rows: [exactRunnerRow(pid)],
    });
    const stopControl = jest.fn(() => moduleUnderTest.stopRunner({
      ownershipProbe: probe,
    }));
    const startControl = jest.fn();
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('restart must not signal or fallback during starting grace');
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await moduleUnderTest.runCli(
      { positional: ['restart'], options: new Map() },
      { stopRunner: stopControl, startRunner: startControl }
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'owner_start_in_progress',
      restartAborted: true,
      pid,
    }));
    expect(stopControl).toHaveBeenCalledTimes(1);
    expect(startControl).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(pidPath)).toEqual(pidBytes);
  });

  test('verified-starting exception rejects every boundary outside the exact grace claim', () => {
    const nowMs = Date.parse('2026-07-30T06:40:00.000Z');
    const pid = 621;
    const alive = { known: true, alive: true, pid, error: null };
    const base = {
      pidInfo: {
        exists: true,
        readable: true,
        pid,
        mtimeMs: nowMs - 1_000,
        error: null,
      },
      statusInfo: {
        exists: false,
        readable: true,
        value: null,
        mtimeMs: 0,
        error: null,
      },
      pidProbes: new Map([[pid, alive]]),
      processScan: {
        ok: true,
        source: 'test',
        rows: [exactRunnerRow(pid)],
        error: null,
      },
      nowMs,
    };
    const accepted = moduleUnderTest.buildRunnerOwnershipSnapshot(base);
    expect(accepted).toEqual(expect.objectContaining({
      ok: true,
      status: 'verified_starting_owner',
      verifiedStartingOwner: true,
    }));

    const rejected = [
      {
        ...base,
        pidInfo: { ...base.pidInfo, mtimeMs: nowMs - 10_001 },
      },
      {
        ...base,
        pidInfo: { ...base.pidInfo, mtimeMs: nowMs + 1_001 },
      },
      {
        ...base,
        statusInfo: {
          exists: true,
          readable: false,
          value: null,
          mtimeMs: nowMs,
          error: 'invalid_status_file',
        },
      },
      {
        ...base,
        statusInfo: {
          exists: true,
          readable: true,
          value: { role: 'bidirectional-wake-watchdog', pid: 622 },
          mtimeMs: nowMs,
          error: null,
        },
        pidProbes: new Map([
          [pid, alive],
          [622, { known: true, alive: true, pid: 622, error: null }],
        ]),
      },
      {
        ...base,
        processScan: { ...base.processScan, rows: [] },
      },
      {
        ...base,
        processScan: { ...base.processScan, rows: [processRow(pid, null)] },
      },
      {
        ...base,
        processScan: {
          ...base.processScan,
          rows: [processRow(pid, `"node.exe" "D:\\foreign\\wrapper.js" "${runnerScriptPath}" run`)],
        },
      },
      {
        ...base,
        pidProbes: new Map([[
          pid,
          { known: false, alive: null, pid, error: 'access denied', code: 'EPERM' },
        ]]),
      },
      {
        ...base,
        processScan: { ok: false, source: 'test', rows: [], error: 'access denied' },
      },
      {
        ...base,
        processScan: {
          ...base.processScan,
          rows: [exactRunnerRow(pid), exactRunnerRow(623)],
        },
      },
    ];

    for (const candidate of rejected) {
      expect(moduleUnderTest.buildRunnerOwnershipSnapshot(candidate)).toEqual(
        expect.objectContaining({
          ok: false,
          status: 'ownership_conflict',
          verifiedStartingOwner: false,
        })
      );
    }
  });

  test('script identity is case-sensitive on POSIX and case-insensitive on Windows', () => {
    const posixPath = '/opt/SquidRun/ui/scripts/hm-bidirectional-wake-watchdog.js';
    const posixRow = {
      pid: 630,
      name: 'node',
      executablePath: '/usr/bin/node',
      commandLine: `"node" "${posixPath}" run`,
    };
    const windowsPath = 'D:\\Projects\\SquidRun\\ui\\scripts\\hm-bidirectional-wake-watchdog.js';
    const windowsRow = processRow(631, `"node.exe" "${windowsPath}" run`);

    expect(moduleUnderTest.isExactRunnerProcessRow(posixRow, posixPath)).toBe(true);
    expect(moduleUnderTest.isExactRunnerProcessRow(
      posixRow,
      '/opt/squidrun/ui/scripts/hm-bidirectional-wake-watchdog.js'
    )).toBe(false);
    expect(moduleUnderTest.isExactRunnerProcessRow(
      windowsRow,
      'd:\\projects\\squidrun\\ui\\scripts\\hm-bidirectional-wake-watchdog.js'
    )).toBe(true);
  });

  test('startRunner no-ops when a fresh matching runner is already live', () => {
    const statusPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-status.json');
    const pidPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog.pid');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(pidPath, String(process.pid), 'utf8');
    fs.writeFileSync(statusPath, JSON.stringify({
      version: 1,
      role: 'bidirectional-wake-watchdog',
      pid: process.pid,
      running: true,
      intervalMs: 60_000,
      heartbeatAt: new Date().toISOString(),
    }, null, 2), 'utf8');

    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      ownershipProbe: ownershipProbe({
        alivePids: [process.pid],
        rows: [exactRunnerRow(process.pid)],
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      alreadyRunning: true,
      running: true,
      pid: process.pid,
    }));
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test('startRunner no-ops when the live runner carries the current generation token', () => {
    const statusPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-status.json');
    const pidPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog.pid');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(pidPath, String(process.pid), 'utf8');
    fs.writeFileSync(statusPath, JSON.stringify({
      version: 1,
      role: 'bidirectional-wake-watchdog',
      pid: process.pid,
      appGenerationId: 'app-gen-current',
      running: true,
      intervalMs: 60_000,
      heartbeatAt: new Date().toISOString(),
    }, null, 2), 'utf8');

    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      appGenerationId: 'app-gen-current',
      ownershipProbe: ownershipProbe({
        alivePids: [process.pid],
        rows: [exactRunnerRow(process.pid)],
      }),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, alreadyRunning: true }));
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test('startRunner reaps + replaces a live runner from a prior generation', () => {
    // process.kill must be stubbed: the fake orphan pid is reported alive (sig 0)
    // and SIGTERM is a no-op so the jest worker is not actually signalled.
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const orphanPid = 999999;
    const statusPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-status.json');
    const pidPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog.pid');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(pidPath, String(orphanPid), 'utf8');
    fs.writeFileSync(statusPath, JSON.stringify({
      version: 1,
      role: 'bidirectional-wake-watchdog',
      pid: orphanPid,
      appGenerationId: 'app-gen-PRIOR',
      running: true,
      intervalMs: 60_000,
      heartbeatAt: new Date().toISOString(),
    }, null, 2), 'utf8');

    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      appGenerationId: 'app-gen-NEW',
      ownershipProbe: ownershipProbe({
        alivePids: [orphanPid],
        rows: [exactRunnerRow(orphanPid)],
      }),
    });

    // The prior-generation orphan was SIGTERM'd...
    expect(killSpy).toHaveBeenCalledWith(orphanPid, 'SIGTERM');
    // ...and a fresh daemon was spawned carrying the new generation token.
    expect(result).toEqual(expect.objectContaining({ ok: true, started: true }));
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    expect(childProcess.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ SQUIDRUN_WAKE_APP_GENERATION: 'app-gen-NEW' }),
      })
    );
  });

  test('startRunner spawns a singleton child when no fresh runner exists', () => {
    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      ownershipProbe: ownershipProbe(),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      started: true,
      pid: 9876,
      statePath: path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-state.json'),
    }));
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    expect(childProcess.spawn).toHaveBeenCalledWith(
      expect.any(String),
      [
        expect.stringContaining('hm-bidirectional-wake-watchdog.js'),
        'run',
        '--state',
        path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-state.json'),
        '--interval-ms',
        '60000',
      ],
      expect.objectContaining({
        cwd: tempRoot,
        detached: true,
        windowsHide: true,
        env: expect.objectContaining({
          SQUIDRUN_PROJECT_ROOT: tempRoot,
        }),
      })
    );
  });

  test('startRunner atomic lock prevents a concurrent double spawn before pid file exists', () => {
    let reentrantResult = null;
    childProcess.spawn.mockImplementationOnce(() => {
      reentrantResult = moduleUnderTest.startRunner({
        projectRoot: tempRoot,
        ownershipProbe: ownershipProbe(),
      });
      return {
        pid: 9876,
        unref: jest.fn(),
      };
    });

    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      ownershipProbe: ownershipProbe(),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      started: true,
      pid: 9876,
    }));
    expect(reentrantResult).toEqual(expect.objectContaining({
      ok: true,
      alreadyStarting: true,
      startInProgress: true,
      reason: 'start_in_progress',
    }));
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  });

  test('startRunner stale-lock reclaim lets only one stale reclaimer spawn', () => {
    const lockPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-start.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 1111,
      createdAt: '2026-06-09T05:00:00.000Z',
      ownerToken: 'stale-owner',
    }), 'utf8');
    const staleDate = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleDate, staleDate);

    const originalRenameSync = fs.renameSync.bind(fs);
    let competitorResult = null;
    let reentered = false;
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      if (src === lockPath && !reentered) {
        reentered = true;
        renameSpy.mockImplementation(originalRenameSync);
        competitorResult = moduleUnderTest.startRunner({
          projectRoot: tempRoot,
          startLock: { staleAfterMs: 1_000 },
          ownershipProbe: ownershipProbe(),
        });
        const error = new Error('stale lock already claimed');
        error.code = 'ENOENT';
        throw error;
      }
      return originalRenameSync(src, dest);
    });

    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      startLock: { staleAfterMs: 1_000 },
      ownershipProbe: ownershipProbe(),
    });

    expect(competitorResult).toEqual(expect.objectContaining({
      ok: true,
      started: true,
      pid: 9876,
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      alreadyStarting: true,
      startInProgress: true,
      reason: 'start_in_progress',
      claimReason: 'stale_lock_claim_lost',
    }));
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  });

  test('startRunner does not spawn when stale claim captures a changed lock', () => {
    const lockPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-start.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 1111,
      createdAt: '2026-06-09T05:00:00.000Z',
      ownerToken: 'stale-owner',
    }), 'utf8');
    const staleDate = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleDate, staleDate);

    const originalRenameSync = fs.renameSync.bind(fs);
    let changed = false;
    jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      if (src === lockPath && !changed) {
        changed = true;
        fs.writeFileSync(lockPath, JSON.stringify({
          pid: 2222,
          createdAt: new Date().toISOString(),
          ownerToken: 'fresh-owner',
        }), 'utf8');
      }
      return originalRenameSync(src, dest);
    });

    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      startLock: { staleAfterMs: 1_000 },
      ownershipProbe: ownershipProbe(),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      alreadyStarting: true,
      startInProgress: true,
      reason: 'start_in_progress',
      claimReason: 'stale_lock_claim_mismatch',
    }));
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toEqual(expect.objectContaining({
      ownerToken: 'fresh-owner',
    }));
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});
