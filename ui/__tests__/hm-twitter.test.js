/**
 * Tests for scripts/hm-twitter.js
 */

jest.mock('https', () => ({
  request: jest.fn(),
}));

jest.mock('../modules/main/comms-journal', () => ({
  appendCommsJournalEntry: jest.fn(() => ({ ok: true })),
  closeCommsJournalStores: jest.fn(),
}));

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    randomBytes: jest.fn(() => Buffer.from('abcdef0123456789abcdef0123456789', 'hex')),
  };
});

const { EventEmitter } = require('events');
const https = require('https');
const {
  parseArgs,
  getTwitterConfig,
  getMissingConfigKeys,
  percentEncode,
  generateNonce,
  generateTimestamp,
  buildSignatureBaseString,
  signRequest,
  buildOAuthHeader,
  postTweet,
  post,
  main,
} = require('../scripts/hm-twitter');
const { appendCommsJournalEntry } = require('../modules/main/comms-journal');

function mockHttpsResponse(statusCode, body) {
  https.request.mockImplementation((options, onResponse) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;
    const request = new EventEmitter();
    request.write = jest.fn();
    request.end = jest.fn(() => {
      onResponse(response);
      response.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
      response.emit('end');
    });
    return request;
  });
}

describe('hm-twitter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parseArgs', () => {
    test('parses positional and options', () => {
      const result = parseArgs(['post', 'Hello world', '--url', 'https://example.com']);
      expect(result.positional).toEqual(['post', 'Hello world']);
      expect(result.options.get('url')).toBe('https://example.com');
    });

    test('handles boolean flags', () => {
      const result = parseArgs(['post', '--dry-run']);
      expect(result.options.get('dry-run')).toBe(true);
    });

    test('handles empty args', () => {
      const result = parseArgs([]);
      expect(result.positional).toEqual([]);
      expect(result.options.size).toBe(0);
    });
  });

  describe('getTwitterConfig', () => {
    test('reads config from env', () => {
      const config = getTwitterConfig({
        TWITTER_API_KEY: 'ak',
        TWITTER_API_SECRET: 'as',
        TWITTER_ACCESS_TOKEN: 'at',
        TWITTER_ACCESS_SECRET: 'ats',
      });
      expect(config.apiKey).toBe('ak');
      expect(config.apiSecret).toBe('as');
      expect(config.accessToken).toBe('at');
      expect(config.accessSecret).toBe('ats');
    });

    test('trims whitespace', () => {
      const config = getTwitterConfig({
        TWITTER_API_KEY: '  ak  ',
        TWITTER_API_SECRET: '',
        TWITTER_ACCESS_TOKEN: '',
        TWITTER_ACCESS_SECRET: '',
      });
      expect(config.apiKey).toBe('ak');
    });

    test('returns empty strings for missing env', () => {
      const config = getTwitterConfig({});
      expect(config.apiKey).toBe('');
      expect(config.apiSecret).toBe('');
    });
  });

  describe('getMissingConfigKeys', () => {
    test('returns empty for complete config', () => {
      const missing = getMissingConfigKeys({ apiKey: 'a', apiSecret: 'b', accessToken: 'c', accessSecret: 'd' });
      expect(missing).toEqual([]);
    });

    test('returns all missing keys for empty config', () => {
      const missing = getMissingConfigKeys({ apiKey: '', apiSecret: '', accessToken: '', accessSecret: '' });
      expect(missing).toEqual(['TWITTER_API_KEY', 'TWITTER_API_SECRET', 'TWITTER_ACCESS_TOKEN', 'TWITTER_ACCESS_SECRET']);
    });

    test('returns specific missing keys', () => {
      const missing = getMissingConfigKeys({ apiKey: 'a', apiSecret: '', accessToken: 'c', accessSecret: '' });
      expect(missing).toEqual(['TWITTER_API_SECRET', 'TWITTER_ACCESS_SECRET']);
    });
  });

  describe('OAuth 1.0a helpers', () => {
    test('percentEncode handles special characters', () => {
      expect(percentEncode('hello world')).toBe('hello%20world');
      expect(percentEncode('test!')).toBe('test%21');
      expect(percentEncode("it's")).toBe('it%27s');
      expect(percentEncode('(parens)')).toBe('%28parens%29');
      expect(percentEncode('star*')).toBe('star%2A');
    });

    test('generateNonce returns hex string', () => {
      const nonce = generateNonce();
      expect(typeof nonce).toBe('string');
      expect(nonce.length).toBe(32);
    });

    test('generateTimestamp returns numeric string', () => {
      const ts = generateTimestamp();
      expect(typeof ts).toBe('string');
      expect(Number(ts)).toBeGreaterThan(0);
    });

    test('buildSignatureBaseString sorts params', () => {
      const params = new Map([
        ['b', '2'],
        ['a', '1'],
      ]);
      const base = buildSignatureBaseString('POST', 'https://api.example.com/test', params);
      expect(base).toContain('POST');
      expect(base).toContain('a%3D1%26b%3D2');
    });

    test('signRequest returns base64 HMAC', () => {
      const sig = signRequest('base&string', 'consumer_secret', 'token_secret');
      expect(typeof sig).toBe('string');
      expect(sig.length).toBeGreaterThan(0);
    });

    test('buildOAuthHeader returns OAuth header string', () => {
      const config = { apiKey: 'ck', apiSecret: 'cs', accessToken: 'at', accessSecret: 'as' };
      const header = buildOAuthHeader(config, 'POST', 'https://api.twitter.com/2/tweets');
      expect(header).toMatch(/^OAuth /);
      expect(header).toContain('oauth_consumer_key');
      expect(header).toContain('oauth_signature');
    });
  });

  describe('postTweet', () => {
    test('posts tweet successfully', async () => {
      mockHttpsResponse(201, { data: { id: '12345', text: 'Hello world' } });
      const config = { apiKey: 'ck', apiSecret: 'cs', accessToken: 'at', accessSecret: 'as' };
      const result = await postTweet(config, { text: 'Hello world' });
      expect(result.ok).toBe(true);
      expect(result.tweetId).toBe('12345');
      expect(result.text).toBe('Hello world');
    });

    test('posts reply successfully', async () => {
      mockHttpsResponse(201, { data: { id: '67890', text: '@user reply' } });
      const config = { apiKey: 'ck', apiSecret: 'cs', accessToken: 'at', accessSecret: 'as' };
      const result = await postTweet(config, { text: '@user reply', replyToId: '11111' });
      expect(result.ok).toBe(true);

      const writeCall = https.request.mock.calls[0][0];
      expect(writeCall.method).toBe('POST');
    });

    test('returns error on auth failure', async () => {
      mockHttpsResponse(401, { detail: 'Unauthorized' });
      const config = { apiKey: 'ck', apiSecret: 'cs', accessToken: 'at', accessSecret: 'as' };
      const result = await postTweet(config, { text: 'test' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Unauthorized');
    });

    test('returns error on rate limit', async () => {
      mockHttpsResponse(429, { title: 'Too Many Requests' });
      const config = { apiKey: 'ck', apiSecret: 'cs', accessToken: 'at', accessSecret: 'as' };
      const result = await postTweet(config, { text: 'test' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Too Many Requests');
    });

    test('returns HTTP status on unknown error', async () => {
      mockHttpsResponse(500, 'not-json');
      const config = { apiKey: 'ck', apiSecret: 'cs', accessToken: 'at', accessSecret: 'as' };
      const result = await postTweet(config, { text: 'test' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('HTTP 500');
    });
  });

  describe('post', () => {
    const validEnv = {
      TWITTER_API_KEY: 'ak',
      TWITTER_API_SECRET: 'as',
      TWITTER_ACCESS_TOKEN: 'at',
      TWITTER_ACCESS_SECRET: 'ats',
    };

    test('returns error for missing config', async () => {
      const result = await post({ text: 'hello' }, {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Missing required env vars');
    });

    test('returns error for missing text', async () => {
      const result = await post({}, validEnv);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Tweet text is required');
    });

    test('returns error for tweet too long', async () => {
      const result = await post({ text: 'a'.repeat(281) }, validEnv);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('281/280');
    });

    test('appends url to text', async () => {
      mockHttpsResponse(201, { data: { id: '1', text: 'hello https://example.com' } });
      const result = await post({ text: 'hello', url: 'https://example.com' }, validEnv);
      expect(result.ok).toBe(true);
    });

    test('posts successfully end-to-end', async () => {
      mockHttpsResponse(201, { data: { id: '999', text: 'Hello world' } });
      const result = await post({ text: 'Hello world' }, validEnv);
      expect(result.ok).toBe(true);
      expect(result.tweetId).toBe('999');
    });

    test('logs to comms journal on success', async () => {
      mockHttpsResponse(201, { data: { id: '1', text: 'Hello' } });
      await post({ text: 'Hello' }, validEnv);

      const journalCalls = appendCommsJournalEntry.mock.calls;
      expect(journalCalls.length).toBeGreaterThanOrEqual(2);
      expect(journalCalls[0][0].channel).toBe('twitter');
      expect(journalCalls[0][0].status).toBe('recorded');
      const lastCall = journalCalls[journalCalls.length - 1][0];
      expect(lastCall.status).toBe('acked');
    });

    test('logs to comms journal on failure', async () => {
      mockHttpsResponse(401, { detail: 'Unauthorized' });
      await post({ text: 'Hello' }, validEnv);

      const journalCalls = appendCommsJournalEntry.mock.calls;
      const failCall = journalCalls.find(c => c[0].status === 'failed');
      expect(failCall).toBeDefined();
      expect(failCall[0].errorCode).toBe('tweet_failed');
    });
  });

  describe('main', () => {
    let exitSpy;

    beforeEach(() => {
      exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
    });

    afterEach(() => {
      exitSpy.mockRestore();
    });

    test('shows usage with no args', async () => {
      await expect(main([], {})).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test('shows usage with --help', async () => {
      await expect(main(['--help'], {})).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('rejects unknown commands', async () => {
      await expect(main(['delete'], {})).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test('rejects missing tweet text', async () => {
      await expect(main(['post'], {})).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
