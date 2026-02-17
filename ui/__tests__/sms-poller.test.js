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
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'token123',
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
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'token123',
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
});
