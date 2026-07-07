const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CREDENTIAL_CLASS_POLICIES,
  RELAY_SETTINGS_RELATIVE_PATH,
  RELAY_ENV_KEYS,
  TWILIO_SETTINGS_RELATIVE_PATH,
  WALLET_DENY_ENV_KEYS,
  WALLET_SETTINGS_RELATIVE_PATH,
  applyInstallCredentialEnvOverlay,
} = require('../modules/install-credentials');
const { TELEGRAM_SETTINGS_RELATIVE_PATH } = require('../modules/telegram-credentials');

describe('install-credentials', () => {
  const tempRoots = [];

  function makeDataRoot(files = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-creds-'));
    tempRoots.push(root);
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(
        fullPath,
        typeof content === 'string' ? content : JSON.stringify(content)
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

  describe('relay class (all-or-nothing identity)', () => {
    const FULL_RELAY = {
      relayUrl: 'wss://relay.example.test/socket',
      relaySecret: 'fake_relay_secret_do_not_use',
      deviceId: 'INSTALL-DEVICE-01',
    };

    test('a complete relay identity applies all three env keys', () => {
      const root = makeDataRoot({ [RELAY_SETTINGS_RELATIVE_PATH]: FULL_RELAY });
      const env = {};

      const result = applyInstallCredentialEnvOverlay({ env, dataRoot: root });

      expect(env.SQUIDRUN_RELAY_URL).toBe(FULL_RELAY.relayUrl);
      expect(env.SQUIDRUN_RELAY_SECRET).toBe(FULL_RELAY.relaySecret);
      expect(env.SQUIDRUN_DEVICE_ID).toBe(FULL_RELAY.deviceId);
      expect(result.classes.relay.applied.sort()).toEqual([
        'SQUIDRUN_DEVICE_ID',
        'SQUIDRUN_RELAY_SECRET',
        'SQUIDRUN_RELAY_URL',
      ]);
    });

    test.each([
      ['deviceId', { relayUrl: FULL_RELAY.relayUrl, relaySecret: FULL_RELAY.relaySecret }],
      ['relaySecret', { relayUrl: FULL_RELAY.relayUrl, deviceId: FULL_RELAY.deviceId }],
      ['relayUrl', { relaySecret: FULL_RELAY.relaySecret, deviceId: FULL_RELAY.deviceId }],
    ])('a relay identity missing %s applies NOTHING', (_missing, partial) => {
      const root = makeDataRoot({ [RELAY_SETTINGS_RELATIVE_PATH]: partial });
      const env = {};

      const result = applyInstallCredentialEnvOverlay({ env, dataRoot: root });

      expect(env).toEqual({});
      expect(result.classes.relay.applied).toEqual([]);
      expect(result.classes.relay.reason).toBe('incomplete_relay_identity');
    });

    test('a single relay key already in env fails the WHOLE class closed (no mixed identity)', () => {
      const root = makeDataRoot({ [RELAY_SETTINGS_RELATIVE_PATH]: FULL_RELAY });
      const env = { SQUIDRUN_DEVICE_ID: 'ALREADY-SET' };

      const result = applyInstallCredentialEnvOverlay({ env, dataRoot: root });

      // The inherited key is untouched AND the file's other two are NOT spliced in.
      expect(env.SQUIDRUN_DEVICE_ID).toBe('ALREADY-SET');
      expect(env.SQUIDRUN_RELAY_URL).toBeUndefined();
      expect(env.SQUIDRUN_RELAY_SECRET).toBeUndefined();
      expect(result.classes.relay.applied).toEqual([]);
      expect(result.classes.relay.reason).toBe('partial_env_relay_identity');
      expect(result.classes.relay.skipped).toEqual(['SQUIDRUN_DEVICE_ID']);
    });

    test('every relay env key is covered by the fail-closed guard', () => {
      for (const key of ['SQUIDRUN_RELAY_URL', 'SQUIDRUN_RELAY_SECRET', 'SQUIDRUN_DEVICE_ID']) {
        const root = makeDataRoot({ [RELAY_SETTINGS_RELATIVE_PATH]: FULL_RELAY });
        const env = { [key]: 'inherited' };

        const result = applyInstallCredentialEnvOverlay({ env, dataRoot: root });

        expect(result.classes.relay.reason).toBe('partial_env_relay_identity');
        expect(result.classes.relay.applied).toEqual([]);
        expect(RELAY_ENV_KEYS).toContain(key);
      }
    });

    test('malformed relay.json is a clean no-op', () => {
      const root = makeDataRoot({ [RELAY_SETTINGS_RELATIVE_PATH]: '{ nope' });
      const env = {};

      const result = applyInstallCredentialEnvOverlay({ env, dataRoot: root });

      expect(env).toEqual({});
      expect(result.classes.relay.applied).toEqual([]);
    });
  });

  describe('twilio class', () => {
    test('sid+token pair with phone and recipient applies all four keys', () => {
      const root = makeDataRoot({
        [TWILIO_SETTINGS_RELATIVE_PATH]: {
          accountSid: 'ACfakefakefakefakefakefakefakefa',
          authToken: 'fake_twilio_token_do_not_use',
          phoneNumber: '+15550001111',
          smsRecipient: '+15550002222',
        },
      });
      const env = {};

      const result = applyInstallCredentialEnvOverlay({ env, dataRoot: root });

      expect(env.TWILIO_ACCOUNT_SID).toBe('ACfakefakefakefakefakefakefakefa');
      expect(env.TWILIO_AUTH_TOKEN).toBe('fake_twilio_token_do_not_use');
      expect(env.TWILIO_PHONE_NUMBER).toBe('+15550001111');
      expect(env.SMS_RECIPIENT).toBe('+15550002222');
      expect(result.classes.twilio.applied).toHaveLength(4);
    });

    test('sid without token applies neither credential (pair-or-nothing), but phone keys still apply', () => {
      const root = makeDataRoot({
        [TWILIO_SETTINGS_RELATIVE_PATH]: {
          accountSid: 'ACfakefakefakefakefakefakefakefa',
          phoneNumber: '+15550001111',
        },
      });
      const env = {};

      const result = applyInstallCredentialEnvOverlay({ env, dataRoot: root });

      expect(env.TWILIO_ACCOUNT_SID).toBeUndefined();
      expect(env.TWILIO_AUTH_TOKEN).toBeUndefined();
      expect(env.TWILIO_PHONE_NUMBER).toBe('+15550001111');
      expect(result.classes.twilio.reason).toBe('incomplete_twilio_credential_pair');
    });

    test('existing twilio env values win', () => {
      const root = makeDataRoot({
        [TWILIO_SETTINGS_RELATIVE_PATH]: {
          accountSid: 'ACfile',
          authToken: 'file_token',
        },
      });
      const env = { TWILIO_ACCOUNT_SID: 'ACenv', TWILIO_AUTH_TOKEN: 'env_token' };

      const result = applyInstallCredentialEnvOverlay({ env, dataRoot: root });

      expect(env.TWILIO_ACCOUNT_SID).toBe('ACenv');
      expect(env.TWILIO_AUTH_TOKEN).toBe('env_token');
      expect(result.classes.twilio.skipped.sort()).toEqual([
        'TWILIO_ACCOUNT_SID',
        'TWILIO_AUTH_TOKEN',
      ]);
    });
  });

  describe('telegram delegation + aggregation', () => {
    test('telegram.json applies through the combined overlay with per-class reporting', () => {
      const root = makeDataRoot({
        [TELEGRAM_SETTINGS_RELATIVE_PATH]: {
          botToken: '123456789:fake_install_bot_token_do_not_use',
          ownerChatId: 8754356993,
          chatAllowlist: [8754356993],
        },
        [RELAY_SETTINGS_RELATIVE_PATH]: {
          relayUrl: 'wss://relay.example.test/socket',
          relaySecret: 'fake_relay_secret_do_not_use',
          deviceId: 'INSTALL-DEVICE-01',
        },
      });
      const env = {};

      const result = applyInstallCredentialEnvOverlay({ env, dataRoot: root });

      expect(env.TELEGRAM_BOT_TOKEN).toBe('123456789:fake_install_bot_token_do_not_use');
      expect(env.TELEGRAM_CHAT_ALLOWLIST_STRICT).toBe('1');
      expect(env.SQUIDRUN_DEVICE_ID).toBe('INSTALL-DEVICE-01');
      expect(result.classes.telegram.applied).toContain('TELEGRAM_BOT_TOKEN');
      expect(result.applied).toEqual(
        expect.arrayContaining(['TELEGRAM_BOT_TOKEN', 'SQUIDRUN_RELAY_URL'])
      );
      expect(result.ok).toBe(true);
    });

    test('an empty data root is a clean no-op across every class', () => {
      const root = makeDataRoot({});
      const env = {};

      const result = applyInstallCredentialEnvOverlay({ env, dataRoot: root });

      expect(env).toEqual({});
      expect(result.applied).toEqual([]);
      expect(result.ok).toBe(true);
    });
  });

  describe('wallet class (explicit DENY — never carried by an install)', () => {
    test('the taxonomy enumerates wallet with a deny policy, not by omission', () => {
      expect(CREDENTIAL_CLASS_POLICIES.wallet).toBe('deny');
      expect(CREDENTIAL_CLASS_POLICIES.telegram).toBe('overlay');
      expect(CREDENTIAL_CLASS_POLICIES.relay).toBe('overlay');
      expect(CREDENTIAL_CLASS_POLICIES.twilio).toBe('overlay');
    });

    test('wallet env vars that survive to the overlay are stripped and reported', () => {
      const root = makeDataRoot({});
      const env = {
        HYPERLIQUID_PRIVATE_KEY: 'fake_private_key_do_not_use',
        HYPERLIQUID_WALLET_ADDRESS: '0xfake',
        SOME_OTHER_VAR: 'kept',
      };

      const result = applyInstallCredentialEnvOverlay({ env, dataRoot: root });

      expect(env.HYPERLIQUID_PRIVATE_KEY).toBeUndefined();
      expect(env.HYPERLIQUID_WALLET_ADDRESS).toBeUndefined();
      expect(env.SOME_OTHER_VAR).toBe('kept');
      expect(result.classes.wallet.denied.sort()).toEqual([
        'HYPERLIQUID_PRIVATE_KEY',
        'HYPERLIQUID_WALLET_ADDRESS',
      ]);
    });

    test('a wallet settings file is never read — its presence is reported as denied', () => {
      const root = makeDataRoot({
        [WALLET_SETTINGS_RELATIVE_PATH]: { privateKey: 'fake_private_key_do_not_use' },
      });
      const env = {};

      const result = applyInstallCredentialEnvOverlay({ env, dataRoot: root });

      expect(env).toEqual({});
      expect(result.classes.wallet.reason).toBe('wallet_class_denied');
      expect(result.classes.wallet.settingsFilePresent).toBe(true);
      expect(result.classes.wallet.applied).toEqual([]);
    });

    test('every wallet env key from the incident inventory is on the deny list', () => {
      for (const key of ['HYPERLIQUID_PRIVATE_KEY', 'HYPERLIQUID_WALLET_ADDRESS']) {
        expect(WALLET_DENY_ENV_KEYS).toContain(key);
      }
    });
  });

});
