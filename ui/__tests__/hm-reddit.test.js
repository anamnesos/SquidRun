/**
 * Tests for scripts/hm-reddit.js
 */

jest.mock('https', () => ({
  request: jest.fn(),
}));

jest.mock('../modules/main/comms-journal', () => ({
  appendCommsJournalEntry: jest.fn(() => ({ ok: true })),
  closeCommsJournalStores: jest.fn(),
}));

const { EventEmitter } = require('events');
const https = require('https');
const {
  parseArgs,
  getRedditConfig,
  getMissingConfigKeys,
  getAccessToken,
  submitPost,
  post,
  main,
} = require('../scripts/hm-reddit');
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

function mockHttpsSequence(responses) {
  let callIndex = 0;
  https.request.mockImplementation((options, onResponse) => {
    const { statusCode, body } = responses[callIndex] || responses[responses.length - 1];
    callIndex += 1;
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

describe('hm-reddit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parseArgs', () => {
    test('parses positional and options', () => {
      const result = parseArgs(['post', '--subreddit', 'ClaudeAI', '--title', 'Hello']);
      expect(result.positional).toEqual(['post']);
      expect(result.options.get('subreddit')).toBe('ClaudeAI');
      expect(result.options.get('title')).toBe('Hello');
    });

    test('handles boolean flags', () => {
      const result = parseArgs(['post', '--draft']);
      expect(result.options.get('draft')).toBe(true);
    });

    test('handles empty args', () => {
      const result = parseArgs([]);
      expect(result.positional).toEqual([]);
      expect(result.options.size).toBe(0);
    });
  });

  describe('getRedditConfig', () => {
    test('reads config from env', () => {
      const config = getRedditConfig({
        REDDIT_CLIENT_ID: 'cid',
        REDDIT_CLIENT_SECRET: 'csec',
        REDDIT_USERNAME: 'user',
        REDDIT_PASSWORD: 'pass',
      });
      expect(config.clientId).toBe('cid');
      expect(config.clientSecret).toBe('csec');
      expect(config.username).toBe('user');
      expect(config.password).toBe('pass');
    });

    test('trims whitespace', () => {
      const config = getRedditConfig({ REDDIT_CLIENT_ID: '  cid  ', REDDIT_CLIENT_SECRET: '', REDDIT_USERNAME: '', REDDIT_PASSWORD: '' });
      expect(config.clientId).toBe('cid');
    });

    test('returns empty strings for missing env', () => {
      const config = getRedditConfig({});
      expect(config.clientId).toBe('');
      expect(config.clientSecret).toBe('');
    });
  });

  describe('getMissingConfigKeys', () => {
    test('returns empty for complete config', () => {
      const missing = getMissingConfigKeys({ clientId: 'a', clientSecret: 'b', username: 'c', password: 'd' });
      expect(missing).toEqual([]);
    });

    test('returns all missing keys for empty config', () => {
      const missing = getMissingConfigKeys({ clientId: '', clientSecret: '', username: '', password: '' });
      expect(missing).toEqual(['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USERNAME', 'REDDIT_PASSWORD']);
    });

    test('returns specific missing keys', () => {
      const missing = getMissingConfigKeys({ clientId: 'a', clientSecret: '', username: 'c', password: '' });
      expect(missing).toEqual(['REDDIT_CLIENT_SECRET', 'REDDIT_PASSWORD']);
    });
  });

  describe('getAccessToken', () => {
    test('returns access token on success', async () => {
      mockHttpsResponse(200, { access_token: 'tok123', token_type: 'bearer' });
      const token = await getAccessToken({ clientId: 'c', clientSecret: 's', username: 'u', password: 'p' });
      expect(token).toBe('tok123');
    });

    test('throws on auth failure', async () => {
      mockHttpsResponse(401, { error: 'invalid_grant' });
      await expect(getAccessToken({ clientId: 'c', clientSecret: 's', username: 'u', password: 'p' }))
        .rejects.toThrow('Reddit auth failed');
    });

    test('throws on missing access_token', async () => {
      mockHttpsResponse(200, { token_type: 'bearer' });
      await expect(getAccessToken({ clientId: 'c', clientSecret: 's', username: 'u', password: 'p' }))
        .rejects.toThrow('Reddit auth failed');
    });
  });

  describe('submitPost', () => {
    test('submits self post successfully', async () => {
      mockHttpsResponse(200, { json: { data: { url: 'https://reddit.com/r/test/123', id: '123', name: 't3_123' }, errors: [] } });
      const result = await submitPost('token', { subreddit: 'test', title: 'Hello', body: 'World' });
      expect(result.ok).toBe(true);
      expect(result.url).toBe('https://reddit.com/r/test/123');
    });

    test('submits link post successfully', async () => {
      mockHttpsResponse(200, { json: { data: { url: 'https://github.com/test', id: '456' }, errors: [] } });
      const result = await submitPost('token', { subreddit: 'test', title: 'Link', url: 'https://github.com/test' });
      expect(result.ok).toBe(true);
    });

    test('returns error on Reddit API errors', async () => {
      mockHttpsResponse(200, { json: { data: {}, errors: [['SUBREDDIT_NOEXIST', 'Subreddit not found', 'sr']] } });
      const result = await submitPost('token', { subreddit: 'nonexistent', title: 'Test' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('SUBREDDIT_NOEXIST');
    });

    test('returns error on HTTP failure', async () => {
      mockHttpsResponse(403, { message: 'Forbidden' });
      const result = await submitPost('token', { subreddit: 'test', title: 'Test' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Forbidden');
    });
  });

  describe('post', () => {
    const validEnv = {
      REDDIT_CLIENT_ID: 'cid',
      REDDIT_CLIENT_SECRET: 'csec',
      REDDIT_USERNAME: 'user',
      REDDIT_PASSWORD: 'pass',
    };

    test('returns error for missing config', async () => {
      const result = await post({ subreddit: 'test', title: 'hi' }, {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Missing required env vars');
    });

    test('returns error for missing subreddit', async () => {
      const result = await post({ title: 'hi' }, validEnv);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('subreddit and title are required');
    });

    test('returns error for missing title', async () => {
      const result = await post({ subreddit: 'test' }, validEnv);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('subreddit and title are required');
    });

    test('posts successfully end-to-end', async () => {
      mockHttpsSequence([
        { statusCode: 200, body: { access_token: 'tok', token_type: 'bearer' } },
        { statusCode: 200, body: { json: { data: { url: 'https://reddit.com/r/test/789', id: '789' }, errors: [] } } },
      ]);

      const result = await post({ subreddit: 'test', title: 'Hello', body: 'World' }, validEnv);
      expect(result.ok).toBe(true);
      expect(result.url).toBe('https://reddit.com/r/test/789');
    });

    test('logs to comms journal on success', async () => {
      mockHttpsSequence([
        { statusCode: 200, body: { access_token: 'tok', token_type: 'bearer' } },
        { statusCode: 200, body: { json: { data: { url: 'https://reddit.com/r/test/1', id: '1' }, errors: [] } } },
      ]);

      await post({ subreddit: 'test', title: 'Hello' }, validEnv);

      const journalCalls = appendCommsJournalEntry.mock.calls;
      expect(journalCalls.length).toBeGreaterThanOrEqual(2);
      expect(journalCalls[0][0].channel).toBe('reddit');
      expect(journalCalls[0][0].status).toBe('recorded');
      const lastCall = journalCalls[journalCalls.length - 1][0];
      expect(lastCall.status).toBe('acked');
    });

    test('logs to comms journal on failure', async () => {
      mockHttpsResponse(401, { error: 'invalid_grant' });

      await post({ subreddit: 'test', title: 'Hello' }, validEnv);

      const journalCalls = appendCommsJournalEntry.mock.calls;
      const failCall = journalCalls.find(c => c[0].status === 'failed');
      expect(failCall).toBeDefined();
      expect(failCall[0].errorCode).toBe('auth_failed');
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

    test('rejects missing --subreddit', async () => {
      await expect(main(['post', '--title', 'hi'], {})).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test('rejects missing --title', async () => {
      await expect(main(['post', '--subreddit', 'test'], {})).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
