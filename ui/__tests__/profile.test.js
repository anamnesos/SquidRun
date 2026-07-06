'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildProfileTelegramEnv,
  PROFILE_ROOT_CONFIG_VERSION,
  getProfileProjectRootConfigPath,
  getProfilePipePath,
  getProfileProjectRootOverride,
  getProfileWebSocketPort,
  namespaceCoordRelPath,
  normalizeProfileName,
} = require('../profile');

describe('profile helpers', () => {
  test('normalizes Scoped profile aliases', () => {
    expect(normalizeProfileName('scoped')).toBe('scoped');
    expect(normalizeProfileName('Scoped')).toBe('scoped');
    expect(normalizeProfileName('')).toBe('main');
  });

  test('namespaces runtime and app-status paths for non-main profiles', () => {
    expect(namespaceCoordRelPath('runtime/daemon.pid', 'scoped')).toBe('runtime-scoped/daemon.pid');
    expect(namespaceCoordRelPath('app-status.json', 'scoped')).toBe('app-status-scoped.json');
    expect(namespaceCoordRelPath('runtime/daemon.pid', 'main')).toBe('runtime/daemon.pid');
  });

  test('builds profile-specific pipe paths and websocket ports', () => {
    expect(getProfilePipePath('main', 'win32')).toContain('squidrun-terminal');
    expect(getProfilePipePath('scoped', 'win32')).toContain('squidrun-terminal-scoped');
    expect(getProfileWebSocketPort('main')).toBe(9900);
    expect(getProfileWebSocketPort('scoped')).toBe(9901);
    expect(getProfileWebSocketPort('eunbyeol')).toBe(9901);
    expect(getProfileWebSocketPort('eunbyeol')).not.toBe(10001);
  });

  test('keeps the legacy pipe for the dev/main root but gives each install its own', () => {
    // No discriminator (legacy/dev main) — explicit null forces the unsuffixed pipe.
    const legacyMain = getProfilePipePath('main', 'win32', { installDiscriminator: null });
    expect(legacyMain).toBe('\\\\.\\pipe\\squidrun-terminal');

    // A pinned install (profile=main, de-scoped) gets a per-install suffix so it
    // can never join the dev/main daemon — the cross-bind closed by construction.
    const installA = getProfilePipePath('main', 'win32', { dataRoot: 'D:\\SquidRun\\InstanceA' });
    expect(installA).toMatch(/^\\\\\.\\pipe\\squidrun-terminal-[0-9a-f]{10}$/);
    expect(installA).not.toBe(legacyMain);

    // Distinct roots → distinct pipes; same root (case/slash variants) → same pipe.
    const installB = getProfilePipePath('main', 'win32', { dataRoot: 'D:\\SquidRun\\InstanceB' });
    expect(installB).not.toBe(installA);
    expect(getProfilePipePath('main', 'win32', { dataRoot: 'd:\\squidrun\\instancea\\' })).toBe(installA);

    // Explicit discriminator composes onto a non-main profile too.
    expect(getProfilePipePath('scoped', 'win32', { installDiscriminator: 'abc1234567' }))
      .toBe('\\\\.\\pipe\\squidrun-terminal-scoped-abc1234567');

    // Unix socket form carries the discriminator identically.
    expect(getProfilePipePath('main', 'linux', { dataRoot: 'D:\\SquidRun\\InstanceA' }))
      .toMatch(/^\/tmp\/squidrun-terminal-[0-9a-f]{10}\.sock$/);
  });

  test('resolves explicit profile project roots without affecting main', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-scoped-root-'));
    try {
      expect(getProfileProjectRootOverride('main', {
        SQUIDRUN_SCOPED_PROJECT_ROOT: tempRoot,
      })).toBeNull();
      expect(getProfileProjectRootOverride('scoped', {
        SQUIDRUN_SCOPED_PROJECT_ROOT: tempRoot,
      })).toBe(path.resolve(tempRoot));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('resolves bundled side-profile workspaces when no explicit root is set', () => {
    const profileRoot = path.resolve(__dirname, '..', '..', '.squidrun', 'profiles', 'unit-profile', 'workspace');
    try {
      fs.mkdirSync(profileRoot, { recursive: true });
      expect(getProfileProjectRootOverride('unit-profile', {})).toBe(profileRoot);
    } finally {
      fs.rmSync(path.dirname(profileRoot), { recursive: true, force: true });
    }
  });

  test('resolves durable profile-root contracts when env is absent', () => {
    const squidrunRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-profile-root-'));
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trustquote-profile-root-'));
    try {
      const configPath = getProfileProjectRootConfigPath('trustquote', squidrunRoot);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        version: PROFILE_ROOT_CONFIG_VERSION,
        profile: 'trustquote',
        projectRoot: profileRoot,
      }, null, 2));

      expect(getProfileProjectRootOverride('trustquote', {}, { squidrunRoot })).toBe(path.resolve(profileRoot));
    } finally {
      fs.rmSync(squidrunRoot, { recursive: true, force: true });
      fs.rmSync(profileRoot, { recursive: true, force: true });
    }
  });

  test('filters Telegram env so Scoped traffic stays out of the main profile', () => {
    const mainEnv = buildProfileTelegramEnv({
      TELEGRAM_CHAT_ID: '5613428850',
      TELEGRAM_CHAT_ALLOWLIST: '2222222222,111111',
      TELEGRAM_AUTHORIZED_CHAT_IDS: '2222222222,222222',
    }, 'main');
    expect(mainEnv.TELEGRAM_CHAT_ID).toBe('5613428850');
    expect(mainEnv.TELEGRAM_CHAT_ALLOWLIST).toBe('111111');
    expect(mainEnv.TELEGRAM_AUTHORIZED_CHAT_IDS).toBe('222222');
    expect(mainEnv.TELEGRAM_SCOPED_CHAT_IDS).toBe('2222222222');

    const scopedEnv = buildProfileTelegramEnv({
      TELEGRAM_SCOPED_CHAT_ID: '2222222222',
      TELEGRAM_CHAT_ID: '5613428850',
      TELEGRAM_CHAT_ALLOWLIST: '111111',
    }, 'scoped');
    expect(scopedEnv.TELEGRAM_CHAT_ID).toBe('2222222222');
    expect(scopedEnv.TELEGRAM_CHAT_ALLOWLIST).toBe('');
    expect(scopedEnv.TELEGRAM_AUTHORIZED_CHAT_IDS).toBe('');
    expect(scopedEnv.TELEGRAM_SCOPED_CHAT_IDS).toBe('2222222222');
  });

  test('does not rewrite a scoped Telegram chat id to a hardcoded main chat fallback', () => {
    const mainEnv = buildProfileTelegramEnv({
      TELEGRAM_CHAT_ID: '2222222222',
      TELEGRAM_CHAT_ALLOWLIST: '2222222222,333333',
      TELEGRAM_AUTHORIZED_CHAT_IDS: '2222222222,444444',
    }, 'main');

    expect(mainEnv).not.toHaveProperty('TELEGRAM_CHAT_ID');
    expect(mainEnv.TELEGRAM_CHAT_ALLOWLIST).toBe('333333');
    expect(mainEnv.TELEGRAM_AUTHORIZED_CHAT_IDS).toBe('444444');
    expect(mainEnv.TELEGRAM_SCOPED_CHAT_IDS).toBe('2222222222');
  });

  test('uses configured scoped Telegram chat id for named side profiles', () => {
    const sideEnv = buildProfileTelegramEnv({
      TELEGRAM_SCOPED_CHAT_ID: '8754356993',
      TELEGRAM_CHAT_ID: '5613428850',
      TELEGRAM_CHAT_ALLOWLIST: '111111',
      TELEGRAM_AUTHORIZED_CHAT_IDS: '222222',
    }, 'eunbyeol');

    expect(sideEnv.TELEGRAM_CHAT_ID).toBe('8754356993');
    expect(sideEnv.TELEGRAM_CHAT_ALLOWLIST).toBe('');
    expect(sideEnv.TELEGRAM_AUTHORIZED_CHAT_IDS).toBe('');
    expect(sideEnv.TELEGRAM_SCOPED_CHAT_IDS).toBe('8754356993');

    const mainEnv = buildProfileTelegramEnv({
      TELEGRAM_SCOPED_CHAT_ID: '8754356993',
      TELEGRAM_CHAT_ID: '5613428850',
      TELEGRAM_CHAT_ALLOWLIST: '8754356993,111111',
      TELEGRAM_AUTHORIZED_CHAT_IDS: '8754356993,222222',
    }, 'main');

    expect(mainEnv.TELEGRAM_CHAT_ID).toBe('5613428850');
    expect(mainEnv.TELEGRAM_CHAT_ALLOWLIST).toBe('111111');
    expect(mainEnv.TELEGRAM_AUTHORIZED_CHAT_IDS).toBe('222222');
    expect(mainEnv.TELEGRAM_SCOPED_CHAT_IDS).toBe('8754356993');
  });

  test('warns when a side profile falls back to the placeholder Telegram chat id', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sideEnv = buildProfileTelegramEnv({
        TELEGRAM_CHAT_ID: '5613428850',
      }, 'eunbyeol');

      expect(sideEnv.TELEGRAM_CHAT_ID).toBe('2222222222');
      expect(warnSpy).toHaveBeenCalledWith(
        '[profile] TELEGRAM_SCOPED_CHAT_ID is not configured; using placeholder scoped chat id.'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
