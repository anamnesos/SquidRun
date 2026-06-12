const { checkRelayConnectivity } = require('../modules/ipc/preflight-handlers');

describe('preflight handlers', () => {
  const ENV_KEYS = [
    'SQUIDRUN_CROSS_DEVICE',
    'SQUIDRUN_RELAY_URL',
  ];

  let previousEnv;

  beforeEach(() => {
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousEnv[key];
      }
    }
  });

  it('does not fail relay preflight when cross-device mode is disabled and no relay URL is configured', async () => {
    process.env.SQUIDRUN_CROSS_DEVICE = '0';
    delete process.env.SQUIDRUN_RELAY_URL;

    const check = await checkRelayConnectivity();

    expect(check).toEqual(expect.objectContaining({
      id: 'relay',
      ok: true,
      skipped: true,
      crossDeviceEnabled: false,
    }));
    expect(check.detail).toContain('Relay disabled');
  });

  it('still fails relay preflight when cross-device mode is enabled without a relay URL', async () => {
    process.env.SQUIDRUN_CROSS_DEVICE = '1';
    delete process.env.SQUIDRUN_RELAY_URL;

    const check = await checkRelayConnectivity();

    expect(check).toEqual(expect.objectContaining({
      id: 'relay',
      ok: false,
    }));
    expect(check.detail).toContain('SQUIDRUN_RELAY_URL is not set');
  });
});
