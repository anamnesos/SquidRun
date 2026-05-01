'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildProfileTelegramEnv,
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
      TELEGRAM_CHAT_ID: '5613428850',
      TELEGRAM_CHAT_ALLOWLIST: '111111',
    }, 'scoped');
    expect(scopedEnv.TELEGRAM_CHAT_ID).toBe('2222222222');
    expect(scopedEnv.TELEGRAM_CHAT_ALLOWLIST).toBe('');
    expect(scopedEnv.TELEGRAM_AUTHORIZED_CHAT_IDS).toBe('');
    expect(scopedEnv.TELEGRAM_SCOPED_CHAT_IDS).toBe('2222222222');
  });
});
