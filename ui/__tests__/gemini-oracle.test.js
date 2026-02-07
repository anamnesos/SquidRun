/**
 * Gemini Oracle Unit Tests
 * Target: modules/gemini-oracle.js
 */

const path = require('path');

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
}));

jest.mock('../config', () => require('./helpers/mock-config').mockWorkspaceOnly);

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const fs = require('fs');
const log = require('../modules/logger');
const { analyzeScreenshot, DEFAULT_MODEL } = require('../modules/gemini-oracle');

const createResponse = ({ ok = true, status = 200, payload = {} } = {}) => ({
  ok,
  status,
  json: jest.fn().mockResolvedValue(payload),
});

const flushPromises = () => new Promise(resolve => setImmediate(resolve));

describe('Gemini Oracle', () => {
  const imagePath = '/test/screenshots/test.png';
  const imageBuffer = Buffer.from('fake-image');

  beforeEach(() => {
    jest.clearAllMocks();
    fs.existsSync.mockImplementation(target => target === imagePath);
    fs.readFileSync.mockImplementation(target => {
      if (target === imagePath) {
        return imageBuffer;
      }
      return Buffer.from('');
    });
    fs.writeFileSync.mockImplementation(() => {});
    fs.renameSync.mockImplementation(() => {});
    process.env.GEMINI_API_KEY = 'test-key';
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
    delete process.env.GEMINI_API_KEY;
    jest.useRealTimers();
  });

  test('throws when imagePath is missing', async () => {
    await expect(analyzeScreenshot()).rejects.toThrow('imagePath required');
  });

  test('throws when image does not exist', async () => {
    fs.existsSync.mockReturnValue(false);
    await expect(analyzeScreenshot({ imagePath })).rejects.toThrow(`Image not found: ${imagePath}`);
  });

  test('throws when API key is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    await expect(analyzeScreenshot({ imagePath })).rejects.toThrow('GEMINI_API_KEY is not set');
  });

  test('throws when fetch is unavailable', async () => {
    delete global.fetch;
    await expect(analyzeScreenshot({ imagePath })).rejects.toThrow('global fetch is unavailable in this runtime');
  });

  test('returns analysis and usage on success', async () => {
    const payload = {
      candidates: [
        {
          content: {
            parts: [{ text: 'All good.' }],
          },
        },
      ],
      usageMetadata: {
        totalTokenCount: 5,
        promptTokenCount: 2,
        candidatesTokenCount: 3,
      },
    };
    global.fetch.mockResolvedValueOnce(createResponse({ payload }));

    const result = await analyzeScreenshot({ imagePath, prompt: 'Check UI', model: DEFAULT_MODEL });

    expect(result.analysis).toBe('All good.');
    expect(result.usage).toEqual({ tokens: 5, promptTokens: 2, outputTokens: 3 });
    expect(result.model).toBe(DEFAULT_MODEL);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [endpoint, options] = global.fetch.mock.calls[0];
    expect(endpoint).toContain(DEFAULT_MODEL);
    const body = JSON.parse(options.body);
    expect(body.contents[0].parts[0].text).toBe('Check UI');
  });

  test('uses default prompt when prompt is empty', async () => {
    const payload = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Default prompt used.' }],
          },
        },
      ],
    };
    global.fetch.mockResolvedValueOnce(createResponse({ payload }));

    await analyzeScreenshot({ imagePath, prompt: '  ' });

    const [, options] = global.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.contents[0].parts[0].text).toBe('Analyze this UI screenshot for visual or layout issues.');
  });

  test('throws when Gemini returns empty analysis text', async () => {
    const payload = {
      candidates: [
        {
          content: {
            parts: [{ text: '' }],
          },
        },
      ],
    };
    global.fetch.mockResolvedValueOnce(createResponse({ payload }));

    await expect(analyzeScreenshot({ imagePath })).rejects.toThrow('Gemini returned no analysis text');
  });

  test('retries on 429 and succeeds', async () => {
    jest.useFakeTimers();
    const rateLimited = createResponse({
      ok: false,
      status: 429,
      payload: { error: { message: 'Rate limit' } },
    });
    const successPayload = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Recovered.' }],
          },
        },
      ],
    };

    global.fetch
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(createResponse({ payload: successPayload }));

    const promise = analyzeScreenshot({ imagePath });
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result.analysis).toBe('Recovered.');
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalled();
  });

  test('fails after retrying 429 responses', async () => {
    jest.useFakeTimers();
    const rateLimited = createResponse({
      ok: false,
      status: 429,
      payload: { error: { message: 'Rate limit' } },
    });
    global.fetch
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(rateLimited);

    const promise = analyzeScreenshot({ imagePath });
    const expectation = expect(promise).rejects.toThrow('Rate limit');
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);
    await jest.advanceTimersByTimeAsync(4000);

    await expectation;
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });
});
