'use strict';

const {
  buildProfileTelegramEnv,
  getProfilePipePath,
  getProfileWebSocketPort,
  namespaceCoordRelPath,
  normalizeProfileName,
} = require('../profile');

describe('profile helpers', () => {
  test('normalizes Eunbyeol profile aliases', () => {
    expect(normalizeProfileName('eunbyul')).toBe('eunbyeol');
    expect(normalizeProfileName('은별')).toBe('eunbyeol');
    expect(normalizeProfileName('')).toBe('main');
  });

  test('namespaces runtime and app-status paths for non-main profiles', () => {
    expect(namespaceCoordRelPath('runtime/daemon.pid', 'eunbyeol')).toBe('runtime-eunbyeol/daemon.pid');
    expect(namespaceCoordRelPath('app-status.json', 'eunbyeol')).toBe('app-status-eunbyeol.json');
    expect(namespaceCoordRelPath('runtime/daemon.pid', 'main')).toBe('runtime/daemon.pid');
  });

  test('builds profile-specific pipe paths and websocket ports', () => {
    expect(getProfilePipePath('main', 'win32')).toContain('squidrun-terminal');
    expect(getProfilePipePath('eunbyeol', 'win32')).toContain('squidrun-terminal-eunbyeol');
    expect(getProfileWebSocketPort('main')).toBe(9900);
    expect(getProfileWebSocketPort('eunbyeol')).toBe(9901);
  });

  test('filters Telegram env so Eunbyeol traffic stays out of the main profile', () => {
    const mainEnv = buildProfileTelegramEnv({
      TELEGRAM_CHAT_ID: '5613428850',
      TELEGRAM_CHAT_ALLOWLIST: '8754356993,111111',
      TELEGRAM_AUTHORIZED_CHAT_IDS: '8754356993,222222',
    }, 'main');
    expect(mainEnv.TELEGRAM_CHAT_ID).toBe('5613428850');
    expect(mainEnv.TELEGRAM_CHAT_ALLOWLIST).toBe('111111');
    expect(mainEnv.TELEGRAM_AUTHORIZED_CHAT_IDS).toBe('222222');

    const eunbyeolEnv = buildProfileTelegramEnv({
      TELEGRAM_CHAT_ID: '5613428850',
      TELEGRAM_CHAT_ALLOWLIST: '111111',
    }, 'eunbyeol');
    expect(eunbyeolEnv.TELEGRAM_CHAT_ID).toBe('8754356993');
    expect(eunbyeolEnv.TELEGRAM_CHAT_ALLOWLIST).toBe('');
    expect(eunbyeolEnv.TELEGRAM_AUTHORIZED_CHAT_IDS).toBe('');
  });
});
