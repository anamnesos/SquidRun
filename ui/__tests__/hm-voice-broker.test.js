const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildStatusSnapshot,
  STATUS_STALE_AFTER_MS,
  isNodeExecutablePath,
  resolveBrokerLaunchCommand,
} = require('../scripts/hm-voice-broker');
const { readVoiceBrokerStatusSnapshot } = require('../modules/bridge/preload-api');

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

  test('does not report running when matching broker status heartbeat is stale', () => {
    const nowMs = Date.now();
    const snapshot = buildStatusSnapshot({
      pid: 25064,
      pidAlive: true,
      pidMtimeMs: nowMs - 60000,
      statusFile: {
        pid: 25064,
        running: true,
        updatedAt: new Date(nowMs - STATUS_STALE_AFTER_MS - 1000).toISOString(),
        heartbeatAt: new Date(nowMs - STATUS_STALE_AFTER_MS - 1000).toISOString(),
        address: { address: '127.0.0.1', port: 61984 },
      },
      nowMs,
    });

    expect(snapshot).toEqual(expect.objectContaining({
      running: false,
      starting: false,
      stalePid: 25064,
      staleStatus: false,
      staleHeartbeat: true,
      statusFresh: false,
      reason: 'stale_voice_broker_status',
      broker: null,
    }));
    expect(snapshot.statusAgeMs).toBeGreaterThan(STATUS_STALE_AFTER_MS);
  });

  test('reports running only when matching broker status heartbeat is fresh', () => {
    const nowMs = Date.now();
    const snapshot = buildStatusSnapshot({
      pid: 25064,
      pidAlive: true,
      pidMtimeMs: nowMs - 60000,
      statusFile: {
        pid: 25064,
        running: true,
        updatedAt: new Date(nowMs - 1000).toISOString(),
        heartbeatAt: new Date(nowMs - 1000).toISOString(),
        address: { address: '127.0.0.1', port: 61984 },
      },
      nowMs,
    });

    expect(snapshot).toEqual(expect.objectContaining({
      running: true,
      starting: false,
      stalePid: null,
      staleStatus: false,
      staleHeartbeat: false,
      statusFresh: true,
      reason: null,
      broker: expect.objectContaining({
        pid: 25064,
        running: true,
      }),
    }));
  });

  test('preload local broker status rejects stale running:true status files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-broker-preload-'));
    try {
      const runtimeDir = path.join(tempDir, '.squidrun', 'runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const nowMs = Date.parse('2026-06-23T20:00:00.000Z');
      const staleHeartbeatAt = new Date(nowMs - STATUS_STALE_AFTER_MS - 1000).toISOString();
      fs.writeFileSync(path.join(runtimeDir, 'voice-broker.pid'), String(process.pid), 'utf8');
      fs.writeFileSync(path.join(runtimeDir, 'voice-broker-status.json'), JSON.stringify({
        pid: process.pid,
        running: true,
        updatedAt: staleHeartbeatAt,
        heartbeatAt: staleHeartbeatAt,
        address: { address: '127.0.0.1', port: 61984 },
        config: { openaiApiKeyPresent: true },
      }, null, 2));

      const snapshot = readVoiceBrokerStatusSnapshot({ projectRoot: tempDir, nowMs });

      expect(snapshot).toEqual(expect.objectContaining({
        ready: true,
        running: false,
        state: 'stopped',
      }));
      expect(snapshot.lane).toEqual(expect.objectContaining({
        running: false,
        staleHeartbeat: true,
        statusFresh: false,
        reason: 'stale_voice_broker_status',
      }));
      expect(snapshot.lane.broker).toEqual(expect.objectContaining({
        running: true,
        address: { address: '127.0.0.1', port: 61984 },
      }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
