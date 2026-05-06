const {
  buildStatusSnapshot,
  isNodeExecutablePath,
  resolveBrokerLaunchCommand,
} = require('../scripts/hm-voice-broker');

describe('hm-voice-broker lane launcher', () => {
  test('falls back to node.exe instead of spawning Electron as the broker runtime', () => {
    const launch = resolveBrokerLaunchCommand({
      env: {},
      execPath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
      versions: { electron: '28.0.0', node: '24.12.0' },
      platform: 'win32',
    });

    expect(launch).toEqual(expect.objectContaining({
      executable: 'node.exe',
      source: 'electron_node_fallback',
    }));
  });

  test('prefers npm_node_execpath when Electron launched the parent process', () => {
    const launch = resolveBrokerLaunchCommand({
      env: {
        npm_node_execpath: 'C:\\Program Files\\nodejs\\node.exe',
        ELECTRON_RUN_AS_NODE: '1',
      },
      execPath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
      versions: { electron: '28.0.0', node: '24.12.0' },
      platform: 'win32',
    });

    expect(launch).toEqual(expect.objectContaining({
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      source: 'npm_node_execpath',
    }));
    expect(launch.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  test('detects stale broker status when pid file and status json disagree', () => {
    const snapshot = buildStatusSnapshot({
      pid: 25064,
      pidAlive: true,
      pidMtimeMs: Date.now() - 60000,
      statusFile: {
        pid: 37408,
        running: true,
        address: { address: '127.0.0.1', port: 61984 },
      },
      nowMs: Date.now(),
    });

    expect(snapshot).toEqual(expect.objectContaining({
      running: false,
      starting: false,
      stalePid: 25064,
      staleStatus: true,
      reason: 'stale_voice_broker_pid',
      broker: null,
    }));
  });

  test('keeps a just-spawned broker in starting state until the child writes matching status', () => {
    const nowMs = Date.now();
    const snapshot = buildStatusSnapshot({
      pid: 12345,
      pidAlive: true,
      pidMtimeMs: nowMs - 1000,
      statusFile: null,
      nowMs,
    });

    expect(snapshot).toEqual(expect.objectContaining({
      running: false,
      starting: true,
      pid: 12345,
      reason: 'broker_starting',
    }));
  });

  test('recognizes Node executable names', () => {
    expect(isNodeExecutablePath('C:\\Program Files\\nodejs\\node.exe')).toBe(true);
    expect(isNodeExecutablePath('/usr/local/bin/node')).toBe(true);
    expect(isNodeExecutablePath('D:\\app\\electron.exe')).toBe(false);
  });
});
