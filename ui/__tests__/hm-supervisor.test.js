const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveWakeSignalPath,
  signalSupervisorWake,
} = require('../scripts/hm-supervisor');

describe('hm-supervisor wake signaling', () => {
  test('writes a wake signal next to a custom supervisor db path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-hm-supervisor-'));
    const dbPath = path.join(tempDir, 'supervisor.sqlite');

    const wakeSignalPath = resolveWakeSignalPath(dbPath);
    signalSupervisorWake(dbPath, 'enqueue');

    expect(wakeSignalPath).toBe(path.join(tempDir, 'supervisor-wake.signal'));
    expect(fs.existsSync(wakeSignalPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(wakeSignalPath, 'utf8'))).toEqual(expect.objectContaining({
      reason: 'enqueue',
      pid: process.pid,
      updatedAt: expect.any(String),
    }));
  });
});
