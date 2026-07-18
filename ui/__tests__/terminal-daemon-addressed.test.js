'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DaemonClient } = require('../daemon-client');
const { getProfilePipePath } = require('../profile');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForEvent(emitter, eventName, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${eventName} timeout`)), timeoutMs);
    emitter.once(eventName, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

async function waitForExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exited: true, code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ exited: false, code: null, signal: null }), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ exited: true, code, signal });
    });
  });
}

describe('addressed terminal daemon protocol', () => {
  jest.setTimeout(20_000);

  test('isolated daemon refuses duplicates and releases the lease on explicit death', async () => {
    const token = `${process.pid}-${Date.now()}`;
    const profileName = `build1aqa-${token}`;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-build1a-'));
    const pipePath = getProfilePipePath(profileName, os.platform(), { dataRoot });
    const daemonPath = path.join(__dirname, '..', 'terminal-daemon.js');
    const daemon = spawn(process.execPath, [daemonPath], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        SQUIDRUN_PROFILE: profileName,
        SQUIDRUN_DATA_ROOT: dataRoot,
        SQUIDRUN_PROJECT_ROOT: path.resolve(__dirname, '..', '..'),
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    const client = new DaemonClient({ pipePath, profileName });

    try {
      let connected = false;
      for (let attempt = 0; attempt < 40 && !connected; attempt += 1) {
        connected = await client._tryConnect();
        if (!connected) await delay(50);
      }
      expect(connected).toBe(true);

      const base = {
        durableAddress: `arm://${profileName}/portal`,
        paneId: 'qa-portal',
        cwd: path.resolve(__dirname, '..', '..'),
        dryRun: true,
        owner: 'terminal-daemon',
        recoveryEvent: 'lease_check_on_spawn',
        expectedResponseClass: 'arm.liveness.pong',
        env: { SQUIDRUN_ROLE: 'qa-portal' },
      };
      const first = await client.spawnAddressed({ ...base, sourceMessageId: 'qa-ping-1' });
      const duplicate = await client.spawnAddressed({ ...base, sourceMessageId: 'qa-ping-2' });

      expect(first).toEqual(expect.objectContaining({
        ok: true,
        status: 'spawned',
        receipt: expect.objectContaining({
          sourceMessageId: 'qa-ping-1',
          expectedResponseClass: 'arm.liveness.pong',
          durableAddress: base.durableAddress,
          spawnLeaseId: first.spawnLeaseId,
          owner: 'terminal-daemon',
          recoveryEvent: 'lease_check_on_spawn',
        }),
      }));
      expect(first.receipt).not.toHaveProperty('whoFailed');
      expect(duplicate).toEqual(expect.objectContaining({
        ok: false,
        status: 'refused',
        reason: 'address_lease_held',
        spawnLeaseId: first.spawnLeaseId,
      }));
      expect(client.getTerminal('qa-portal')).toEqual(expect.objectContaining({
        alive: true,
        durableAddress: base.durableAddress,
        spawnLeaseId: first.spawnLeaseId,
      }));

      const killed = waitForEvent(client, 'killed');
      expect(client.kill('qa-portal')).toBe(true);
      await killed;
      const replacement = await client.spawnAddressed({ ...base, sourceMessageId: 'qa-ping-3' });

      expect(replacement).toEqual(expect.objectContaining({
        ok: true,
        status: 'spawned',
      }));
      expect(replacement.spawnLeaseId).not.toBe(first.spawnLeaseId);
    } finally {
      if (client.connected) client.shutdown();
      client.disconnect();
      let exitResult = await waitForExit(daemon);
      if (!exitResult.exited) {
        daemon.kill('SIGTERM');
        exitResult = await waitForExit(daemon);
      }
      expect(exitResult.exited).toBe(true);
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
