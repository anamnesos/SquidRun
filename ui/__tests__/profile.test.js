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
  test('normalizes [private-profile] profile aliases', () => {
    expect(normalizeProfileName('private-profile')).toBe('private-profile');
    expect(normalizeProfileName('sideprofile')).toBe('private-profile');
    expect(normalizeProfileName('')).toBe('main');
  });

  test('namespaces runtime and app-status paths for non-main profiles', () => {
    expect(namespaceCoordRelPath('runtime/daemon.pid', 'private-profile')).toBe('runtime-private-profile/daemon.pid');
    expect(namespaceCoordRelPath('app-status.json', 'private-profile')).toBe('app-status-private-profile.json');
    expect(namespaceCoordRelPath('runtime/daemon.pid', 'main')).toBe('runtime/daemon.pid');
  });

  test('builds profile-specific pipe paths and websocket ports', () => {
    expect(getProfilePipePath('main', 'win32')).toContain('squidrun-terminal');
    expect(getProfilePipePath('private-profile', 'win32')).toContain('squidrun-terminal-private-profile');
    expect(getProfileWebSocketPort('main')).toBe(9900);
    expect(getProfileWebSocketPort('private-profile')).toBe(9901);
  });

  test('resolves explicit profile project roots without affecting main', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-private-profile-root-'));
    try {
      expect(getProfileProjectRootOverride('main', {
        SQUIDRUN_sideprofile_PROJECT_ROOT: tempRoot,
      })).toBeNull();
      expect(getProfileProjectRootOverride('private-profile', {
        SQUIDRUN_sideprofile_PROJECT_ROOT: tempRoot,
      })).toBe(path.resolve(tempRoot));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('filters Telegram env so [private-profile] traffic stays out of the main profile', () => {
    const mainEnv = buildProfileTelegramEnv({
      TELEGRAM_CHAT_ID: 'REDACTED',
      TELEGRAM_CHAT_ALLOWLIST: 'REDACTED-CHAT-ID,111111',
      TELEGRAM_AUTHORIZED_CHAT_IDS: 'REDACTED-CHAT-ID,222222',
    }, 'main');
    expect(mainEnv.TELEGRAM_CHAT_ID).toBe('REDACTED');
    expect(mainEnv.TELEGRAM_CHAT_ALLOWLIST).toBe('111111');
    expect(mainEnv.TELEGRAM_AUTHORIZED_CHAT_IDS).toBe('222222');
    expect(mainEnv.TELEGRAM_sideprofile_CHAT_IDS).toBe('REDACTED-CHAT-ID');

    const private-profileEnv = buildProfileTelegramEnv({
      TELEGRAM_CHAT_ID: 'REDACTED',
      TELEGRAM_CHAT_ALLOWLIST: '111111',
    }, 'private-profile');
    expect(private-profileEnv.TELEGRAM_CHAT_ID).toBe('REDACTED-CHAT-ID');
    expect(private-profileEnv.TELEGRAM_CHAT_ALLOWLIST).toBe('');
    expect(private-profileEnv.TELEGRAM_AUTHORIZED_CHAT_IDS).toBe('');
    expect(private-profileEnv.TELEGRAM_sideprofile_CHAT_IDS).toBe('REDACTED-CHAT-ID');
  });
});
