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
const {
  generateImage,
  removeHistoryEntryByPath,
  resolveProvider,
  RECRAFT_STYLES,
  RECRAFT_SIZES,
  OPENAI_SIZES,
} = require('../modules/image-gen');

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
      process.env.RECRAFT_API_KEY = 'rk-test-fake-key-do-not-use';
      expect(resolveProvider()).toBe('recraft');
    });

    test('returns openai when only OPENAI_API_KEY is set', () => {
      process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
      expect(resolveProvider()).toBe('openai');
    });

    test('prefers recraft when both keys set', () => {
      process.env.RECRAFT_API_KEY = 'rk-test-fake-key-do-not-use';
      process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
      expect(resolveProvider()).toBe('recraft');
    });

    test('respects preferred provider when key available', () => {
      process.env.RECRAFT_API_KEY = 'rk-test-fake-key-do-not-use';
      process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
      expect(resolveProvider('openai')).toBe('openai');
    });

    test('does not substitute another provider when the preferred key is missing', () => {
      process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
      expect(resolveProvider('recraft')).toBeNull();
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
      process.env.RECRAFT_API_KEY = 'rk-test-fake-key-do-not-use';

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
      expect(recraftOpts.headers['Authorization']).toBe('Bearer rk-test-fake-key-do-not-use');
    });

    test('generates via OpenAI when only OpenAI key is set', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';

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
      expect(openaiOpts.headers['Authorization']).toBe('Bearer sk-test-fake-key-do-not-use');
    });

    test('fails closed when Recraft fails instead of switching providers', async () => {
      process.env.RECRAFT_API_KEY = 'rk-test-fake-key-do-not-use';
      process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';

      // Recraft fails
      global.fetch.mockResolvedValueOnce(createResponse({
        ok: false,
        status: 500,
        payload: { error: { message: 'Internal server error' } },
      }));

      await expect(generateImage({ prompt: 'a bird' })).rejects.toThrow('Automatic provider fallback is disabled');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('throws when an explicitly requested provider key is missing', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
      await expect(generateImage({ prompt: 'a fish', provider: 'recraft' }))
        .rejects.toThrow('RECRAFT_API_KEY is not set; automatic provider fallback is disabled');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('throws when Recraft returns no image URL', async () => {
      process.env.RECRAFT_API_KEY = 'rk-test-fake-key-do-not-use';

      global.fetch.mockResolvedValueOnce(createResponse({ payload: { data: [] } }));

      await expect(generateImage({ prompt: 'empty response' })).rejects.toThrow('Recraft returned no image URL');
    });

    test('throws when OpenAI returns no b64_json', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';

      global.fetch.mockResolvedValueOnce(createResponse({ payload: { data: [] } }));

      await expect(generateImage({ prompt: 'empty openai' })).rejects.toThrow('OpenAI returned no image data');
    });

    test('saves image to generated-images directory', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';

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
      process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';

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

    test('rejects invalid style and size instead of silently defaulting', async () => {
      process.env.RECRAFT_API_KEY = 'rk-test-fake-key-do-not-use';
      await expect(generateImage({ prompt: 'defaults', style: 'invalid_style' }))
        .rejects.toThrow('Unsupported Recraft style');
      await expect(generateImage({ prompt: 'defaults', size: '999x999' }))
        .rejects.toThrow('Unsupported Recraft size');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('rejects Recraft-only style options on OpenAI instead of ignoring them', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
      await expect(generateImage({ prompt: 'vector mark', provider: 'openai', style: 'vector_illustration' }))
        .rejects.toThrow('style option is Recraft-only');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('retry logic', () => {
    test('retries on 429 and succeeds', async () => {
      jest.useFakeTimers();
      process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';

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
      process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';

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

  describe('history writer helpers', () => {
    test('removeHistoryEntryByPath drops matching path and rewrites history', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { imagePath: 'workspace\\generated-images\\keep.png' },
        { imagePath: 'workspace\\generated-images\\drop.png' },
      ]));

      removeHistoryEntryByPath('workspace\\generated-images\\drop.png');

      const writeCall = fs.writeFileSync.mock.calls.find(call =>
        String(call[0]).includes('image-gen-history.json.tmp')
      );
      expect(writeCall).toBeTruthy();
      expect(writeCall[1]).toContain('keep.png');
      expect(writeCall[1]).not.toContain('drop.png');
      expect(fs.renameSync).toHaveBeenCalled();
    });
  });

  describe('fetch unavailable', () => {
    test('throws when fetch is not available', async () => {
      delete global.fetch;
      process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
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

