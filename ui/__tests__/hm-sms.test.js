const { EventEmitter } = require('events');

jest.mock('https', () => ({
  request: jest.fn(),
}));
jest.mock('../modules/main/comms-journal', () => ({
  appendCommsJournalEntry: jest.fn(() => ({ ok: true })),
  closeCommsJournalStores: jest.fn(),
}));

const https = require('https');
const { appendCommsJournalEntry } = require('../modules/main/comms-journal');
const hmSms = require('../scripts/hm-sms');

function mockTwilioResponse(statusCode, payload) {
  https.request.mockImplementation((options, onResponse) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;

    const request = new EventEmitter();
    request.write = jest.fn();
    request.end = jest.fn(() => {
      onResponse(response);
      if (payload !== undefined) {
        response.emit('data', typeof payload === 'string' ? payload : JSON.stringify(payload));
      }
      response.emit('end');
    });
    return request;
  });
}

describe('hm-sms', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    appendCommsJournalEntry.mockReturnValue({ ok: true });
  });

  test('parseMessage joins argument tokens', () => {
    expect(hmSms.parseMessage(['Hey,', 'build', 'passed!'])).toBe('Hey, build passed!');
  });

  test('getMissingConfigKeys reports required env vars', () => {
    const config = hmSms.getTwilioConfig({});
    expect(hmSms.getMissingConfigKeys(config)).toEqual([
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_PHONE_NUMBER',
      'SMS_RECIPIENT',
    ]);
  });

  test('sendSms returns success on Twilio 2xx', async () => {
    mockTwilioResponse(201, {
      sid: 'SM123',
      to: '+15551234567',
    });

    const result = await hmSms.sendSms('test message', {
      TWILIO_ACCOUNT_SID: 'AC_TEST_FAKE_ACCOUNT_SID_DO_NOT_USE',
      TWILIO_AUTH_TOKEN: 'twilio_auth_token_fake_do_not_use',
      TWILIO_PHONE_NUMBER: '+15550001111',
      SMS_RECIPIENT: '+15551234567',
    });

    expect(result.ok).toBe(true);
    expect(result.sid).toBe('SM123');
    expect(https.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/2010-04-01/Accounts/AC_TEST_FAKE_ACCOUNT_SID_DO_NOT_USE/Messages.json',
      }),
      expect.any(Function)
    );
  });

  test('sendSms returns Twilio error message on non-2xx', async () => {
    mockTwilioResponse(400, {
      message: 'The From phone number is invalid.',
    });

    const result = await hmSms.sendSms('test message', {
      TWILIO_ACCOUNT_SID: 'AC_TEST_FAKE_ACCOUNT_SID_DO_NOT_USE',
      TWILIO_AUTH_TOKEN: 'twilio_auth_token_fake_do_not_use',
      TWILIO_PHONE_NUMBER: '+15550001111',
      SMS_RECIPIENT: '+15551234567',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid');
  });

  test('sendSms journals architect -> user with session id', async () => {
    mockTwilioResponse(201, {
      sid: 'SM999',
      to: '+15551234567',
    });

    const result = await hmSms.sendSms('journal me', {
      TWILIO_ACCOUNT_SID: 'AC_TEST_FAKE_ACCOUNT_SID_DO_NOT_USE',
      TWILIO_AUTH_TOKEN: 'twilio_auth_token_fake_do_not_use',
      TWILIO_PHONE_NUMBER: '+15550001111',
      SMS_RECIPIENT: '+15551234567',
    }, {
      sessionId: 'app-session-2',
    });

    expect(result.ok).toBe(true);
    expect(appendCommsJournalEntry).toHaveBeenCalled();
    expect(appendCommsJournalEntry.mock.calls[0][0]).toEqual(expect.objectContaining({
      channel: 'sms',
      direction: 'outbound',
      senderRole: 'architect',
      targetRole: 'user',
      sessionId: 'app-session-2',
      status: 'recorded',
    }));
  });
});
