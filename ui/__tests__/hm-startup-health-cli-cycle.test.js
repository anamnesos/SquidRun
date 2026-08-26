const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

describe('hm-startup-health CLI module cycle', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-startup-health-cli-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('publishes the Telegram backlog reader before the snapshot calls back into the wrapper', () => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'hm-startup-health.js');
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--no-telegram-poller-auto-recover',
      '--no-bidirectional-wake-watchdog-auto-start',
      '--json',
      tempRoot,
    ], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('readTelegramBacklogHealth is not a function');

    const snapshot = JSON.parse(result.stdout);
    expect(snapshot.telegramIngressBacklog).toEqual(expect.objectContaining({
      ok: true,
      severity: 'ok',
      reasons: ['no_telegram_ingress_configured'],
    }));
  });
});
