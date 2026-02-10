/**
 * Image Generation Module Unit Tests
 * Target: modules/image-gen.js
 */

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  mkdirSync: jest.fn(),
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
const { generateImage, resolveProvider, RECRAFT_STYLES, RECRAFT_SIZES, OPENAI_SIZES } = require('../modules/image-gen');

const createResponse = ({ ok = true, status = 200, payload = {} } = {}) => ({
  ok,
  status,
  json: jest.fn().mockResolvedValue(payload),
});

const createImageDownloadResponse = ({ ok = true, status = 200, data = Buffer.from('fake-png') } = {}) => ({
  ok,
  status,
  arrayBuffer: jest.fn().mockResolvedValue(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
});

describe('Image Generation Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.existsSync.mockReturnValue(false);
    fs.readFileSync.mockReturnValue(Buffer.from(''));
    fs.writeFileSync.mockImplementation(() => {});
    fs.renameSync.mockImplementation(() => {});
    fs.mkdirSync.mockImplementation(() => {});
    delete process.env.RECRAFT_API_KEY;
    delete process.env.OPENAI_API_KEY;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
    delete process.env.RECRAFT_API_KEY;
    delete process.env.OPENAI_API_KEY;
    jest.useRealTimers();
  });

  describe('resolveProvider', () => {
    test('returns null when no API keys are set', () => {
      expect(resolveProvider()).toBeNull();
    });

    test('returns recraft when RECRAFT_API_KEY is set', () => {
      process.env.RECRAFT_API_KEY = 'test-recraft-key';
      expect(resolveProvider()).toBe('recraft');
    });

    test('returns openai when only OPENAI_API_KEY is set', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      expect(resolveProvider()).toBe('openai');
    });

    test('prefers recraft when both keys set', () => {
      process.env.RECRAFT_API_KEY = 'test-recraft-key';
      process.env.OPENAI_API_KEY = 'sk-test';
      expect(resolveProvider()).toBe('recraft');
    });

    test('respects preferred provider when key available', () => {
      process.env.RECRAFT_API_KEY = 'test-recraft-key';
      process.env.OPENAI_API_KEY = 'sk-test';
      expect(resolveProvider('openai')).toBe('openai');
    });

    test('falls back when preferred provider key missing', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      expect(resolveProvider('recraft')).toBe('openai');
    });
  });

  describe('generateImage', () => {
    test('throws when prompt is missing', async () => {
      await expect(generateImage()).rejects.toThrow('prompt is required');
    });

    test('throws when prompt is empty', async () => {
      await expect(generateImage({ prompt: '  ' })).rejects.toThrow('prompt is required');
    });

    test('throws when no API keys are available', async () => {
      await expect(generateImage({ prompt: 'a cat' })).rejects.toThrow('No image generation API key available');
    });

    test('generates via Recraft when key is set', async () => {
      process.env.RECRAFT_API_KEY = 'test-recraft-key';

      const recraftPayload = { data: [{ url: 'https://recraft.ai/image.png' }] };
      const imageData = Buffer.from('fake-png-data');

      global.fetch
        .mockResolvedValueOnce(createResponse({ payload: recraftPayload }))
        .mockResolvedValueOnce(createImageDownloadResponse({ data: imageData }));

      const result = await generateImage({ prompt: 'a cat', style: 'realistic_image', size: '1024x1024' });

      expect(result.provider).toBe('recraft');
      expect(result.imagePath).toContain('.png');
      expect(global.fetch).toHaveBeenCalledTimes(2);

      // Verify Recraft API call
      const [recraftUrl, recraftOpts] = global.fetch.mock.calls[0];
      expect(recraftUrl).toBe('https://external.api.recraft.ai/v1/images/generations');
      const body = JSON.parse(recraftOpts.body);
      expect(body.prompt).toBe('a cat');
      expect(body.model).toBe('recraftv3');
      expect(body.style).toBe('realistic_image');
      expect(recraftOpts.headers['Authorization']).toBe('Bearer test-recraft-key');
    });

    test('generates via OpenAI when only OpenAI key is set', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';

      const openaiPayload = { data: [{ b64_json: Buffer.from('fake-png').toString('base64') }] };
      global.fetch.mockResolvedValueOnce(createResponse({ payload: openaiPayload }));

      const result = await generateImage({ prompt: 'a dog' });

      expect(result.provider).toBe('openai');
      expect(result.imagePath).toContain('.png');

      const [openaiUrl, openaiOpts] = global.fetch.mock.calls[0];
      expect(openaiUrl).toBe('https://api.openai.com/v1/images/generations');
      const body = JSON.parse(openaiOpts.body);
      expect(body.prompt).toBe('a dog');
      expect(body.model).toBe('gpt-image-1');
      expect(body.quality).toBe('auto');
      expect(openaiOpts.headers['Authorization']).toBe('Bearer sk-test');
    });

    test('falls back to OpenAI when Recraft fails', async () => {
      process.env.RECRAFT_API_KEY = 'test-recraft-key';
      process.env.OPENAI_API_KEY = 'sk-test';

      // Recraft fails
      global.fetch.mockResolvedValueOnce(createResponse({
        ok: false,
        status: 500,
        payload: { error: { message: 'Internal server error' } },
      }));

      // OpenAI succeeds
      const openaiPayload = { data: [{ b64_json: Buffer.from('fallback-img').toString('base64') }] };
      global.fetch.mockResolvedValueOnce(createResponse({ payload: openaiPayload }));

      const result = await generateImage({ prompt: 'a bird' });

      expect(result.provider).toBe('openai');
      expect(log.warn).toHaveBeenCalledWith('ImageGen', expect.stringContaining('Recraft failed'));
    });

    test('throws when Recraft fails and no OpenAI fallback key', async () => {
      process.env.RECRAFT_API_KEY = 'test-recraft-key';

      global.fetch.mockResolvedValueOnce(createResponse({
        ok: false,
        status: 500,
        payload: { error: { message: 'Server error' } },
      }));

      await expect(generateImage({ prompt: 'a fish' })).rejects.toThrow('Recraft failed');
      await expect(generateImage({ prompt: 'a fish' })).rejects.toThrow('No OpenAI fallback key available');
    });

    test('throws when Recraft returns no image URL', async () => {
      process.env.RECRAFT_API_KEY = 'test-recraft-key';

      global.fetch.mockResolvedValueOnce(createResponse({ payload: { data: [] } }));

      await expect(generateImage({ prompt: 'empty response' })).rejects.toThrow('Recraft returned no image URL');
    });

    test('throws when OpenAI returns no b64_json', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';

      global.fetch.mockResolvedValueOnce(createResponse({ payload: { data: [] } }));

      await expect(generateImage({ prompt: 'empty openai' })).rejects.toThrow('OpenAI returned no image data');
    });

    test('saves image to generated-images directory', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';

      const imageB64 = Buffer.from('test-image-data').toString('base64');
      global.fetch.mockResolvedValueOnce(createResponse({
        payload: { data: [{ b64_json: imageB64 }] },
      }));

      const result = await generateImage({ prompt: 'save test' });

      expect(result.imagePath).toContain('generated-images');
      expect(result.imagePath).toMatch(/\.png$/);
      expect(fs.mkdirSync).toHaveBeenCalled();
      // writeFileSync called for: image save + history tmp file
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('writes history entry after generation', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';

      const imageB64 = Buffer.from('hist-test').toString('base64');
      global.fetch.mockResolvedValueOnce(createResponse({
        payload: { data: [{ b64_json: imageB64 }] },
      }));

      await generateImage({ prompt: 'history test' });

      // safeWriteJson writes to tmp then renames
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('image-gen-history.json.tmp'),
        expect.any(String),
        'utf-8'
      );
      expect(fs.renameSync).toHaveBeenCalled();
    });

    test('defaults style and size for invalid values', async () => {
      process.env.RECRAFT_API_KEY = 'test-recraft-key';

      const recraftPayload = { data: [{ url: 'https://recraft.ai/img.png' }] };
      global.fetch
        .mockResolvedValueOnce(createResponse({ payload: recraftPayload }))
        .mockResolvedValueOnce(createImageDownloadResponse());

      await generateImage({ prompt: 'defaults', style: 'invalid_style', size: '999x999' });

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.style).toBe('realistic_image');
      expect(body.size).toBe('1024x1024');
    });
  });

  describe('retry logic', () => {
    test('retries on 429 and succeeds', async () => {
      jest.useFakeTimers();
      process.env.OPENAI_API_KEY = 'sk-test';

      const rateLimited = createResponse({
        ok: false,
        status: 429,
        payload: { error: { message: 'Rate limit' } },
      });
      const successPayload = { data: [{ b64_json: Buffer.from('ok').toString('base64') }] };

      global.fetch
        .mockResolvedValueOnce(rateLimited)
        .mockResolvedValueOnce(createResponse({ payload: successPayload }));

      const promise = generateImage({ prompt: 'retry test' });
      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.provider).toBe('openai');
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledWith('ImageGen', expect.stringContaining('Rate limited'));
    });

    test('throws after exhausting 429 retries', async () => {
      jest.useFakeTimers();
      process.env.OPENAI_API_KEY = 'sk-test';

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

      const promise = generateImage({ prompt: 'exhaust retries' });
      const expectation = expect(promise).rejects.toThrow('Rate limit');
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(4000);

      await expectation;
    });
  });

  describe('fetch unavailable', () => {
    test('throws when fetch is not available', async () => {
      delete global.fetch;
      process.env.OPENAI_API_KEY = 'sk-test';
      await expect(generateImage({ prompt: 'no fetch' })).rejects.toThrow('global fetch is unavailable');
    });
  });

  describe('exports', () => {
    test('exports expected constants', () => {
      expect(RECRAFT_STYLES).toEqual(['realistic_image', 'digital_illustration', 'vector_illustration']);
      expect(RECRAFT_SIZES).toContain('1024x1024');
      expect(OPENAI_SIZES).toContain('1024x1024');
    });
  });
});
