const { EventEmitter } = require('events');

jest.mock('https', () => ({
  request: jest.fn(),
}));

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const https = require('https');
const smsPoller = require('../modules/sms-poller');

function mockTwilioMessages(messages, statusCode = 200) {
  https.request.mockImplementation((options, onResponse) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;

    const request = new EventEmitter();
    request.end = jest.fn(() => {
      onResponse(response);
      response.emit('data', JSON.stringify({ messages }));
      response.emit('end');
    });
    return request;
  });
}

describe('sms-poller', () => {
  afterEach(() => {
    smsPoller.stop();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('start is a no-op when Twilio credentials are missing', () => {
    const started = smsPoller.start({
      env: {},
      onMessage: jest.fn(),
    });

    expect(started).toBe(false);
    expect(smsPoller.isRunning()).toBe(false);
  });

  test('start and stop manage running state', () => {
    const started = smsPoller.start({
      env: {
        TWILIO_ACCOUNT_SID: 'AC_TEST_FAKE_ACCOUNT_SID_DO_NOT_USE',
        TWILIO_AUTH_TOKEN: 'twilio_auth_token_fake_do_not_use',
        TWILIO_PHONE_NUMBER: '+15550001111',
        SMS_RECIPIENT: '+15551234567',
      },
      pollIntervalMs: 2000,
      onMessage: jest.fn(),
    });

    expect(started).toBe(true);
    expect(smsPoller.isRunning()).toBe(true);

    smsPoller.stop();
    expect(smsPoller.isRunning()).toBe(false);
  });

  test('pollNow emits inbound messages once and deduplicates by sid', async () => {
    const onMessage = jest.fn();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1000);

    smsPoller.start({
      env: {
        TWILIO_ACCOUNT_SID: 'AC_TEST_FAKE_ACCOUNT_SID_DO_NOT_USE',
        TWILIO_AUTH_TOKEN: 'twilio_auth_token_fake_do_not_use',
        TWILIO_PHONE_NUMBER: '+15550001111',
        SMS_RECIPIENT: '+15551234567',
      },
      onMessage,
    });

    mockTwilioMessages([
      {
        sid: 'SM0001',
        direction: 'inbound',
        from: '+15557654321',
        body: 'hello from twilio',
        date_sent: '1970-01-01T00:00:02.500Z',
      },
    ]);

    nowSpy.mockReturnValue(2000);
    await smsPoller._internals.pollNow();
    await smsPoller._internals.pollNow();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      'hello from twilio',
      '+15557654321',
      expect.objectContaining({
        sid: 'SM0001',
      })
    );
  });

  test('buildMessagesPath uses Twilio DateSent day-floor format', () => {
    const path = smsPoller._internals.buildMessagesPath(
      {
        accountSid: 'AC_TEST_FAKE_ACCOUNT_SID_DO_NOT_USE',
        twilioPhoneNumber: '+15550001111',
      },
      Date.parse('2026-03-01T02:02:19.000Z')
    );

    const query = path.split('?')[1] || '';
    const params = new URLSearchParams(query);
    expect(params.get('DateSent>=')).toBe('2026-03-01');
  });

  test('pollNow skips unseen inbound messages older than cursor tolerance window', async () => {
    const onMessage = jest.fn();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);

    smsPoller.start({
      env: {
        TWILIO_ACCOUNT_SID: 'AC_TEST_FAKE_ACCOUNT_SID_DO_NOT_USE',
        TWILIO_AUTH_TOKEN: 'twilio_auth_token_fake_do_not_use',
        TWILIO_PHONE_NUMBER: '+15550001111',
        SMS_RECIPIENT: '+15551234567',
      },
      onMessage,
    });

    mockTwilioMessages([
      {
        sid: 'SM_OLD',
        direction: 'inbound',
        from: '+15557654321',
        body: 'too old for cursor',
        date_sent: new Date(700_000).toISOString(),
      },
    ]);

    nowSpy.mockReturnValue(1_001_000);
    await smsPoller._internals.pollNow();

    expect(onMessage).toHaveBeenCalledTimes(0);
  });

  test('pollNow still delivers recent inbound messages near cursor boundary', async () => {
    const onMessage = jest.fn();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);

    smsPoller.start({
      env: {
        TWILIO_ACCOUNT_SID: 'AC_TEST_FAKE_ACCOUNT_SID_DO_NOT_USE',
        TWILIO_AUTH_TOKEN: 'twilio_auth_token_fake_do_not_use',
        TWILIO_PHONE_NUMBER: '+15550001111',
        SMS_RECIPIENT: '+15551234567',
      },
      onMessage,
    });

    mockTwilioMessages([
      {
        sid: 'SM_RECENT',
        direction: 'inbound',
        from: '+15557654321',
        body: 'recent enough',
        date_sent: new Date(940_000).toISOString(),
      },
    ]);

    nowSpy.mockReturnValue(1_001_000);
    await smsPoller._internals.pollNow();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      'recent enough',
      '+15557654321',
      expect.objectContaining({
        sid: 'SM_RECENT',
      })
    );
  });

  test('seen SID persistence survives stop/start and prevents replay on restart', async () => {
    const sid = `SM_PERSIST_${Math.random().toString(36).slice(2, 10)}`;
    const onMessage = jest.fn();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    smsPoller.start({
      env: {
        TWILIO_ACCOUNT_SID: 'AC_TEST_FAKE_ACCOUNT_SID_DO_NOT_USE',
        TWILIO_AUTH_TOKEN: 'twilio_auth_token_fake_do_not_use',
        TWILIO_PHONE_NUMBER: '+15550001111',
        SMS_RECIPIENT: '+15551234567',
      },
      persistSeenSids: true,
      onMessage,
    });
    mockTwilioMessages([
      {
        sid,
        direction: 'inbound',
        from: '+15557654321',
        body: 'persist me',
        date_sent: new Date(1_000_500).toISOString(),
      },
    ]);
    nowSpy.mockReturnValue(1_001_000);
    await smsPoller._internals.pollNow();
    smsPoller.stop();

    nowSpy.mockReturnValue(1_010_000);
    smsPoller.start({
      env: {
        TWILIO_ACCOUNT_SID: 'AC_TEST_FAKE_ACCOUNT_SID_DO_NOT_USE',
        TWILIO_AUTH_TOKEN: 'twilio_auth_token_fake_do_not_use',
        TWILIO_PHONE_NUMBER: '+15550001111',
        SMS_RECIPIENT: '+15551234567',
      },
      persistSeenSids: true,
      onMessage,
    });
    mockTwilioMessages([
      {
        sid,
        direction: 'inbound',
        from: '+15557654321',
        body: 'persist me',
        date_sent: new Date(1_000_500).toISOString(),
      },
    ]);
    nowSpy.mockReturnValue(1_011_000);
    await smsPoller._internals.pollNow();

    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});
