'use strict';

const {
  buildProfileTelegramEnv,
  getProfilePipePath,
  getProfileWebSocketPort,
  namespaceCoordRelPath,
  normalizeProfileName,
} = require('../profile');

describe('profile helpers', () => {
  test('normalizes [private-profile] profile aliases', () => {
    expect(normalizeProfileName('private-profile')).toBe('private-profile');
    expect(normalizeProfileName('은별')).toBe('private-profile');
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

  test('filters Telegram env so [private-profile] traffic stays out of the main profile', () => {
    const mainEnv = buildProfileTelegramEnv({
      TELEGRAM_CHAT_ID: '5613428850',
      TELEGRAM_CHAT_ALLOWLIST: '8754356993,111111',
      TELEGRAM_AUTHORIZED_CHAT_IDS: '8754356993,222222',
    }, 'main');
    expect(mainEnv.TELEGRAM_CHAT_ID).toBe('5613428850');
    expect(mainEnv.TELEGRAM_CHAT_ALLOWLIST).toBe('111111');
    expect(mainEnv.TELEGRAM_AUTHORIZED_CHAT_IDS).toBe('222222');

    const private-profileEnv = buildProfileTelegramEnv({
      TELEGRAM_CHAT_ID: '5613428850',
      TELEGRAM_CHAT_ALLOWLIST: '111111',
    }, 'private-profile');
    expect(private-profileEnv.TELEGRAM_CHAT_ID).toBe('8754356993');
    expect(private-profileEnv.TELEGRAM_CHAT_ALLOWLIST).toBe('');
    expect(private-profileEnv.TELEGRAM_AUTHORIZED_CHAT_IDS).toBe('');
  });
});
