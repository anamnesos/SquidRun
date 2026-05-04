'use strict';

jest.mock('../scripts/hm-voice-broker', () => ({
  status: jest.fn(() => ({
    running: true,
    broker: {
      address: {
        address: '127.0.0.1',
        port: 57208,
      },
    },
  })),
}));

const {
  buildPhoneUrl,
  getBrokerBaseUrl,
  parseArgs,
} = require('../scripts/hm-phone-voice');

describe('hm-phone-voice', () => {
  test('resolves broker base URL from running voice broker status', () => {
    expect(getBrokerBaseUrl({
      broker: {
        address: {
          address: '127.0.0.1',
          port: 57208,
        },
      },
    })).toBe('http://127.0.0.1:57208');
  });

  test('builds paired phone URL without dropping the token', () => {
    expect(buildPhoneUrl('https://example.trycloudflare.com', 'phone_abc'))
      .toBe('https://example.trycloudflare.com/phone?token=phone_abc');
  });

  test('parses pair options', () => {
    expect(parseArgs(['pair', '--base-url', 'https://mira.example', '--ttl-ms', '600000']))
      .toEqual({
        command: 'pair',
        options: {
          baseUrl: 'https://mira.example',
          ttlMs: 600000,
        },
      });
  });
});
