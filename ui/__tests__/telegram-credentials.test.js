const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TELEGRAM_SETTINGS_RELATIVE_PATH,
  BRIDGE_RELAY_MODE_ENV_KEY,
  applyTelegramEnvOverlay,
  buildTelegramEnvOverlay,
  readTelegramSettings,
  resolveTelegramSettingsPath,
} = require('../modules/telegram-credentials');

describe('telegram-credentials', () => {
  const tempRoots = [];

  function makeDataRoot(settings) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-creds-'));
    tempRoots.push(root);
    if (settings !== undefined) {
      const settingsPath = path.join(root, TELEGRAM_SETTINGS_RELATIVE_PATH);
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        typeof settings === 'string' ? settings : JSON.stringify(settings)
      );
    }
    return root;
  }

  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (_) {
        // best effort temp cleanup
      }
    }
  });

  test('resolveTelegramSettingsPath joins the data root and returns null without one', () => {
    expect(resolveTelegramSettingsPath('D:\\SomeRoot')).toBe(
      path.join(path.resolve('D:\\SomeRoot'), TELEGRAM_SETTINGS_RELATIVE_PATH)
    );
    expect(resolveTelegramSettingsPath('')).toBeNull();
    expect(resolveTelegramSettingsPath(null)).toBeNull();
  });

  test('fills every telegram env key from a full settings file into an empty env', () => {
    const root = makeDataRoot({
      botToken: '123456789:fake_install_bot_token_do_not_use',
      ownerChatId: 8754356993,
      chatAllowlist: [8754356993],
      relayMode: 'off',
    });
    const env = {};

    const result = applyTelegramEnvOverlay({ env, dataRoot: root });

    expect(result.ok).toBe(true);
    expect(result.source).toBe(path.join(root, TELEGRAM_SETTINGS_RELATIVE_PATH));
    expect(result.applied.sort()).toEqual([
      BRIDGE_RELAY_MODE_ENV_KEY,
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ALLOWLIST',
      'TELEGRAM_CHAT_ALLOWLIST_STRICT',
      'TELEGRAM_CHAT_ID',
    ]);
    expect(env.TELEGRAM_BOT_TOKEN).toBe('123456789:fake_install_bot_token_do_not_use');
    expect(env.TELEGRAM_CHAT_ID).toBe('8754356993');
    expect(env.TELEGRAM_CHAT_ALLOWLIST).toBe('8754356993');
    expect(env.TELEGRAM_CHAT_ALLOWLIST_STRICT).toBe('1');
    expect(env[BRIDGE_RELAY_MODE_ENV_KEY]).toBe('off');
    expect(result.relayMode).toBe('off');
  });

  test('existing env values always win and are reported as skipped', () => {
    const root = makeDataRoot({
      botToken: '123456789:file_token',
      ownerChatId: '111111',
      chatAllowlist: ['111111'],
    });
    const env = {
      TELEGRAM_BOT_TOKEN: '999999999:env_token_wins',
      TELEGRAM_CHAT_ID: '222222',
    };

    const result = applyTelegramEnvOverlay({ env, dataRoot: root });

    expect(env.TELEGRAM_BOT_TOKEN).toBe('999999999:env_token_wins');
    expect(env.TELEGRAM_CHAT_ID).toBe('222222');
    expect(result.skipped.sort()).toEqual(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
    expect(result.applied.sort()).toEqual([
      'TELEGRAM_CHAT_ALLOWLIST',
      'TELEGRAM_CHAT_ALLOWLIST_STRICT',
    ]);
  });

  test('whitespace-only env values are treated as unset and get filled', () => {
    const root = makeDataRoot({ botToken: '123456789:file_token' });
    const env = { TELEGRAM_BOT_TOKEN: '   ' };

    const result = applyTelegramEnvOverlay({ env, dataRoot: root });

    expect(env.TELEGRAM_BOT_TOKEN).toBe('123456789:file_token');
    expect(result.applied).toEqual(['TELEGRAM_BOT_TOKEN']);
  });

  test('missing settings file is a clean no-op', () => {
    const root = makeDataRoot(undefined);
    const env = {};

    const result = applyTelegramEnvOverlay({ env, dataRoot: root });

    expect(result).toEqual({ ok: true, applied: [], skipped: [], source: null });
    expect(env).toEqual({});
  });

  test('malformed JSON never throws and applies nothing', () => {
    const root = makeDataRoot('{ this is not json');
    const env = {};

    const result = applyTelegramEnvOverlay({ env, dataRoot: root });

    expect(result.ok).toBe(true);
    expect(result.applied).toEqual([]);
    expect(env).toEqual({});
  });

  test('non-object settings JSON applies nothing', () => {
    const root = makeDataRoot('["not", "an", "object"]');
    const env = {};

    const result = applyTelegramEnvOverlay({ env, dataRoot: root });

    expect(result.applied).toEqual([]);
    expect(env).toEqual({});
  });

  test('allowlist entries are normalized, deduplicated, and invalid entries dropped', () => {
    const root = makeDataRoot({
      botToken: '123456789:file_token',
      chatAllowlist: [8754356993, '8754356993', ' 111111 ', 'not-a-chat-id', null],
    });
    const env = {};

    applyTelegramEnvOverlay({ env, dataRoot: root });

    expect(env.TELEGRAM_CHAT_ALLOWLIST).toBe('8754356993,111111');
    expect(env.TELEGRAM_CHAT_ALLOWLIST_STRICT).toBe('1');
  });

  test('settings without an allowlist set neither allowlist nor strict keys', () => {
    const root = makeDataRoot({
      botToken: '123456789:file_token',
      ownerChatId: '111111',
    });
    const env = {};

    const result = applyTelegramEnvOverlay({ env, dataRoot: root });

    expect(result.applied.sort()).toEqual(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
    expect(env.TELEGRAM_CHAT_ALLOWLIST).toBeUndefined();
    expect(env.TELEGRAM_CHAT_ALLOWLIST_STRICT).toBeUndefined();
  });

  test('an explicit strict opt-out in env is never overwritten', () => {
    const root = makeDataRoot({
      botToken: '123456789:file_token',
      chatAllowlist: ['111111'],
    });
    const env = { TELEGRAM_CHAT_ALLOWLIST_STRICT: '0' };

    applyTelegramEnvOverlay({ env, dataRoot: root });

    expect(env.TELEGRAM_CHAT_ALLOWLIST_STRICT).toBe('0');
  });

  test('explicit settingsPath option overrides dataRoot resolution', () => {
    const root = makeDataRoot({ botToken: '123456789:ignored_token' });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-creds-alt-'));
    tempRoots.push(elsewhere);
    const altPath = path.join(elsewhere, 'telegram.json');
    fs.writeFileSync(altPath, JSON.stringify({ botToken: '123456789:alt_token' }));
    const env = {};

    const result = applyTelegramEnvOverlay({ env, dataRoot: root, settingsPath: altPath });

    expect(env.TELEGRAM_BOT_TOKEN).toBe('123456789:alt_token');
    expect(result.source).toBe(altPath);
  });

  test('readTelegramSettings returns null for empty or pointless files', () => {
    const root = makeDataRoot({ relayMode: 'off' });
    expect(readTelegramSettings(path.join(root, TELEGRAM_SETTINGS_RELATIVE_PATH))).toBeNull();
    expect(readTelegramSettings(null)).toBeNull();
  });

  test('buildTelegramEnvOverlay tolerates junk input', () => {
    expect(buildTelegramEnvOverlay(null)).toEqual({});
    expect(buildTelegramEnvOverlay('nope')).toEqual({});
  });
});
