const EventEmitter = require('events');

jest.mock('tls', () => ({
  connect: jest.fn(),
}));

jest.mock('net', () => ({
  connect: jest.fn(),
}));

jest.mock('readline', () => ({
  createInterface: jest.fn(),
}));

const tls = require('tls');
const readline = require('readline');
const { createExternalNotifier } = require('../modules/external-notifications');

function createMockSocket() {
  const socket = new EventEmitter();
  socket.write = jest.fn();
  socket.end = jest.fn();
  return socket;
}

describe('external-notifications SMTP TLS config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const responses = [
      '220 smtp ready',
      '250 hello',
      '250 sender accepted',
      '250 recipient accepted',
      '354 start mail input',
      '250 queued',
      '221 bye',
    ];
    readline.createInterface.mockReturnValue({
      on: jest.fn((event, handler) => {
        if (event === 'line') {
          const line = responses.shift() || '250 ok';
          setImmediate(() => handler(line));
        }
      }),
      removeListener: jest.fn(),
      close: jest.fn(),
    });
    tls.connect.mockImplementation(() => createMockSocket());
  });

  test('defaults rejectUnauthorized to true for secure SMTP', async () => {
    const notifier = createExternalNotifier({
      getSettings: () => ({
        externalNotificationsEnabled: true,
        emailNotificationsEnabled: true,
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
        smtpSecure: true,
        smtpFrom: 'from@example.com',
        smtpTo: 'to@example.com',
      }),
      dedupeWindowMs: 0,
    });

    await notifier.notify({ category: 'alert', title: 'A', message: 'B' });

    expect(tls.connect).toHaveBeenCalledWith(
      465,
      'smtp.example.com',
      expect.objectContaining({ rejectUnauthorized: true })
    );
  });

  test('honors smtpRejectUnauthorized=false setting', async () => {
    const notifier = createExternalNotifier({
      getSettings: () => ({
        externalNotificationsEnabled: true,
        emailNotificationsEnabled: true,
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
        smtpSecure: true,
        smtpRejectUnauthorized: false,
        smtpFrom: 'from@example.com',
        smtpTo: 'to@example.com',
      }),
      dedupeWindowMs: 0,
    });

    await notifier.notify({ category: 'completion', title: 'C', message: 'D' });

    expect(tls.connect).toHaveBeenCalledWith(
      465,
      'smtp.example.com',
      expect.objectContaining({ rejectUnauthorized: false })
    );
  });
});
