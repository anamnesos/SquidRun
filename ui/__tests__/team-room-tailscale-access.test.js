'use strict';

const {
  TeamRoomTailscaleAccess,
  normalizeDnsName,
  plainStatusHasExactRoute,
  remoteOriginFromStatus,
  serveConfigIsRouteFree,
  serveStatusHasExactRoute,
  serveStatusJsonIsEmpty,
} = require('../modules/main/team-room-tailscale-access');

const executable = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const origin = 'https://blue-lantern.random-name.ts.net';
const target = 'http://127.0.0.1:9911';

function result(stdout = '', overrides = {}) {
  return { ok: true, code: 0, stdout, stderr: '', error: null, ...overrides };
}

function identityResult(overrides = {}) {
  return result(JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: 'blue-lantern.random-name.ts.net.', Online: true },
    ...overrides,
  }));
}

function cleanEvidence(args) {
  const key = args.join(' ');
  if (key === 'serve status') return result('No serve config');
  if (key === 'serve status --json') return result('{}');
  if (key === 'serve get-config --all') return result('{"version":"0.0.1"}');
  return null;
}

function enabledStatus(overrides = {}) {
  return {
    TCP: { 443: { HTTPS: true } },
    Web: { 'blue-lantern.random-name.ts.net:443': { Handlers: { '/': { Proxy: target } } } },
    ...overrides,
  };
}

function enabledEvidence(args, overrides = {}) {
  const key = args.join(' ');
  if (key === 'serve status') {
    return result(overrides.plain || `Available within your tailnet:\n\n${origin}/\n|-- proxy ${target}`);
  }
  if (key === 'serve status --json') return result(JSON.stringify(overrides.json || enabledStatus()));
  if (key === 'serve get-config --all') return result(JSON.stringify(overrides.config || { version: '0.0.1' }));
  return null;
}

function createManager(runCommand, applyRemoteOrigin = jest.fn(() => ({ ok: true }))) {
  return {
    applyRemoteOrigin,
    manager: new TeamRoomTailscaleAccess({
      applyRemoteOrigin,
      getTargetOrigin: () => target,
      resolveCommand: () => ({ ok: true, command: executable }),
      runCommand,
    }),
  };
}

describe('Team Room Tailscale access manager', () => {
  test('accepts only an online structural HTTPS ts.net identity', () => {
    expect(normalizeDnsName('blue-lantern.random-name.ts.net.')).toBe('blue-lantern.random-name.ts.net');
    expect(normalizeDnsName('*.random-name.ts.net')).toBeNull();
    expect(remoteOriginFromStatus({ Self: { DNSName: 'blue-lantern.random-name.ts.net.' } })).toBe(origin);
    expect(remoteOriginFromStatus({ Self: { DNSName: 'blue-lantern.example.com' } })).toBeNull();
  });

  test('enables one exact loopback route with a resolved executable and literal no-shell args', async () => {
    const calls = [];
    let enabled = false;
    const runCommand = jest.fn(async (file, args, options) => {
      calls.push({ file, args, options });
      const key = args.join(' ');
      if (key === 'status --json') return identityResult();
      if (key === `serve --yes --bg --https=443 ${target}`) { enabled = true; return result(); }
      return (enabled ? enabledEvidence(args) : cleanEvidence(args))
        || result('', { ok: false, error: `unexpected:${key}` });
    });
    const { manager, applyRemoteOrigin } = createManager(runCommand);

    await expect(manager.setEnabled(true)).resolves.toEqual(expect.objectContaining({
      ok: true, enabled: true, origin, target,
    }));
    expect(calls.every((call) => call.file === executable)).toBe(true);
    expect(calls.find((call) => call.args[0] === 'serve' && call.args.includes('--bg'))?.args).toEqual([
      'serve', '--yes', '--bg', '--https=443', target,
    ]);
    expect(calls.every((call) => Array.isArray(call.args))).toBe(true);
    expect(applyRemoteOrigin).toHaveBeenLastCalledWith(origin);
  });

  test('recognizes only the exact live 1.102 node-level schema with no Funnel or extras', () => {
    const exact = enabledStatus();
    expect(plainStatusHasExactRoute(`${origin}/\n|-- proxy ${target}`, origin, target)).toBe(true);
    expect(plainStatusHasExactRoute(`${origin}/\n|-- proxy ${target}0`, origin, target)).toBe(false);
    expect(serveStatusHasExactRoute(exact, origin, target, 443)).toBe(true);
    expect(serveStatusHasExactRoute({
      ...exact,
      AllowFunnel: { 'blue-lantern.random-name.ts.net:443': true },
    }, origin, target, 443)).toBe(false);
    expect(serveStatusHasExactRoute({
      ...exact,
      Web: {
        ...exact.Web,
        'second.random-name.ts.net:443': { Handlers: { '/': { Proxy: target } } },
      },
    }, origin, target, 443)).toBe(false);
    expect(serveStatusHasExactRoute({
      ...exact,
      Web: { 'blue-lantern.random-name.ts.net:443': { Handlers: { '/': { Proxy: `${target}0` } } } },
    }, origin, target, 443)).toBe(false);
    expect(serveStatusHasExactRoute({
      ...exact,
      Web: { 'blue-lantern.random-name.ts.net:443': { Handlers: {
        '/': { Proxy: target },
        '/extra': { Proxy: target },
      } } },
    }, origin, target, 443)).toBe(false);
  });

  test('rejects malicious extra routes and clears a previously applied origin', async () => {
    let malicious = false;
    const runCommand = jest.fn(async (_file, args) => {
      const key = args.join(' ');
      if (key === 'status --json') return identityResult();
      if (!malicious) return enabledEvidence(args) || result('', { ok: false });
      return enabledEvidence(args, {
        json: {
          ...enabledStatus(),
          AllowFunnel: { 'blue-lantern.random-name.ts.net:443': true },
        },
      }) || result('', { ok: false });
    });
    const { manager, applyRemoteOrigin } = createManager(runCommand);
    await expect(manager.inspect()).resolves.toEqual(expect.objectContaining({ ok: true, enabled: true }));
    malicious = true;
    await expect(manager.inspect()).resolves.toEqual(expect.objectContaining({
      ok: false, enabled: false, reason: 'tailscale_serve_unrecognized_config',
    }));
    expect(applyRemoteOrigin).toHaveBeenLastCalledWith(null);
  });

  test('a fresh inspect clears stale origin after an external Serve reset', async () => {
    let enabled = true;
    const runCommand = jest.fn(async (_file, args) => {
      if (args.join(' ') === 'status --json') return identityResult();
      return (enabled ? enabledEvidence(args) : cleanEvidence(args)) || result('', { ok: false });
    });
    const { manager, applyRemoteOrigin } = createManager(runCommand);
    await manager.inspect();
    enabled = false;
    await expect(manager.getStatus()).resolves.toEqual(expect.objectContaining({
      ok: true, enabled: false, reason: 'tailscale_serve_disabled',
    }));
    expect(applyRemoteOrigin).toHaveBeenLastCalledWith(null);
  });

  test('rolls back and proves all clean surfaces when post-enable origin application fails', async () => {
    let enabled = false;
    const calls = [];
    const runCommand = jest.fn(async (_file, args) => {
      calls.push([...args]);
      const key = args.join(' ');
      if (key === 'status --json') return identityResult();
      if (key === `serve --yes --bg --https=443 ${target}`) { enabled = true; return result(); }
      if (key === 'serve reset') { enabled = false; return result(); }
      return (enabled ? enabledEvidence(args) : cleanEvidence(args)) || result('', { ok: false });
    });
    const applyRemoteOrigin = jest.fn((value) => (
      value === null ? { ok: true } : { ok: false, reason: 'synthetic_apply_failure' }
    ));
    const { manager } = createManager(runCommand, applyRemoteOrigin);

    await expect(manager.setEnabled(true)).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'synthetic_apply_failure',
      rolledBack: true,
      enabled: false,
      rollbackEvidence: expect.objectContaining({
        plain: 'No serve config', json: {}, config: { version: '0.0.1' },
      }),
    }));
    expect(calls).toContainEqual(['serve', 'reset']);
    expect(enabled).toBe(false);
    expect(applyRemoteOrigin).toHaveBeenLastCalledWith(null);
  });

  test('Off resets Serve and requires the exact three-surface clean baseline', async () => {
    const runCommand = jest.fn(async (_file, args) => {
      if (args.join(' ') === 'serve reset') return result();
      return cleanEvidence(args) || result('', { ok: false });
    });
    const { manager, applyRemoteOrigin } = createManager(runCommand);
    await expect(manager.setEnabled(false)).resolves.toEqual(expect.objectContaining({
      ok: true, enabled: false, reason: 'tailscale_serve_disabled',
    }));
    expect(applyRemoteOrigin).toHaveBeenLastCalledWith(null);
  });

  test('does not create Serve when the exact loopback listener is unavailable', async () => {
    const runCommand = jest.fn(async (_file, args) => {
      if (args.join(' ') === 'status --json') return identityResult();
      return cleanEvidence(args) || result('', { ok: false });
    });
    const manager = new TeamRoomTailscaleAccess({
      applyRemoteOrigin: jest.fn(() => ({ ok: true })),
      getTargetOrigin: () => null,
      resolveCommand: () => ({ ok: true, command: executable }),
      runCommand,
    });
    await expect(manager.setEnabled(true)).resolves.toEqual(expect.objectContaining({
      ok: false, reason: 'team_room_remote_target_not_loopback',
    }));
    expect(runCommand.mock.calls.some(([, args]) => args.includes('--bg'))).toBe(false);
  });

  test('fails closed when reset leaves any route on any status surface', async () => {
    const runCommand = jest.fn(async (_file, args) => {
      const key = args.join(' ');
      if (key === 'serve reset') return result();
      if (key === 'serve status') return result('No serve config');
      if (key === 'serve status --json') return result('{}');
      if (key === 'serve get-config --all') return result(JSON.stringify({
        version: '0.0.1', services: { 'svc:extra': { endpoints: { 'tcp:443': target } } },
      }));
      return result('', { ok: false });
    });
    const { manager, applyRemoteOrigin } = createManager(runCommand);
    await expect(manager.setEnabled(false)).resolves.toEqual(expect.objectContaining({
      ok: false, reason: 'tailscale_serve_reset_unverified', originCleared: true,
    }));
    expect(applyRemoteOrigin).toHaveBeenLastCalledWith(null);
  });

  test.each([
    ['absent executable', () => ({ ok: false, reason: 'tailscale_executable_not_found' }), identityResult(), 'tailscale_executable_not_found'],
    ['signed out backend', () => ({ ok: true, command: executable }), result(JSON.stringify({ BackendState: 'Stopped', Self: {} })), 'tailscale_not_connected'],
    ['offline node', () => ({ ok: true, command: executable }), identityResult({ Self: { DNSName: 'blue-lantern.random-name.ts.net.', Online: false } }), 'tailscale_node_offline'],
  ])('fails remote-only for %s', async (_label, resolveCommand, statusResult, expectedReason) => {
    const manager = new TeamRoomTailscaleAccess({
      applyRemoteOrigin: jest.fn(() => ({ ok: true })),
      getTargetOrigin: () => target,
      resolveCommand,
      runCommand: jest.fn(async () => statusResult),
    });
    await expect(manager.reconcile()).resolves.toEqual(expect.objectContaining({
      ok: false, enabled: false, reason: expectedReason,
    }));
  });

  test('treats malformed Serve JSON as unverified and clears origin', async () => {
    const runCommand = jest.fn(async (_file, args) => {
      const key = args.join(' ');
      if (key === 'status --json') return identityResult();
      if (key === 'serve status') return result('No serve config');
      if (key === 'serve status --json') return result('{not-json');
      if (key === 'serve get-config --all') return result('{"version":"0.0.1"}');
      return result('', { ok: false });
    });
    const { manager, applyRemoteOrigin } = createManager(runCommand);
    await expect(manager.reconcile()).resolves.toEqual(expect.objectContaining({
      ok: false, enabled: false, reason: 'tailscale_serve_status_json_failed_invalid_json',
    }));
    expect(applyRemoteOrigin).toHaveBeenLastCalledWith(null);
  });

  test('accepts only the installed version-only service export as route-free', () => {
    expect(serveStatusJsonIsEmpty({})).toBe(true);
    expect(serveStatusJsonIsEmpty({ Web: {} })).toBe(false);
    expect(serveConfigIsRouteFree({ version: '0.0.1' })).toBe(true);
    expect(serveConfigIsRouteFree({})).toBe(false);
    expect(serveConfigIsRouteFree({ version: '0.0.2' })).toBe(false);
    expect(serveConfigIsRouteFree({ version: '0.0.1', services: {} })).toBe(false);
  });
});
