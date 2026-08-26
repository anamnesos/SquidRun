/**
 * Whisper Handlers Tests
 * Target: Full coverage of whisper-handlers.js
 */

'use strict';

const { createIpcHarness, createDefaultContext } = require('./helpers/ipc-harness');
const { registerWhisperHandlers } = require('../modules/ipc/whisper-handlers');

describe('whisper handlers', () => {
  const originalEnv = process.env;
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.OPENAI_API_KEY;
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns MISSING_OPENAI_KEY when OPENAI_API_KEY is missing', async () => {
    registerWhisperHandlers(ctx);
    const result = await harness.invoke('voice:transcribe', Buffer.from('audio'));
    expect(result.success).toBe(false);
    expect(result.code).toBe('MISSING_OPENAI_KEY');
  });

  test('returns INVALID_AUDIO_DATA when payload is not a buffer', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
    registerWhisperHandlers(ctx);
    const result = await harness.invoke('voice:transcribe', 'not-a-buffer');
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_AUDIO_DATA');
  });

  test('returns INVALID_AUDIO_DATA for null payload', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
    registerWhisperHandlers(ctx);
    const result = await harness.invoke('voice:transcribe', null);
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_AUDIO_DATA');
  });

  test('successful transcription with Buffer', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
    const mockTranscribe = jest.fn().mockResolvedValue('hello world');
    registerWhisperHandlers(ctx, { callWhisperApi: mockTranscribe });

    const buf = Buffer.from('fake-audio-data');
    const result = await harness.invoke('voice:transcribe', buf);
    expect(result.success).toBe(true);
    expect(result.text).toBe('hello world');
    expect(mockTranscribe).toHaveBeenCalledWith('sk-test-fake-key-do-not-use', buf);
  });

  test('accepts Uint8Array and converts to Buffer', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
    const mockTranscribe = jest.fn().mockResolvedValue('typed array text');
    registerWhisperHandlers(ctx, { callWhisperApi: mockTranscribe });

    const arr = new Uint8Array([1, 2, 3]);
    const result = await harness.invoke('voice:transcribe', arr);
    expect(result.success).toBe(true);
    expect(result.text).toBe('typed array text');
    expect(Buffer.isBuffer(mockTranscribe.mock.calls[0][1])).toBe(true);
  });

  test('maps timeout error to WHISPER_TIMEOUT', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
    registerWhisperHandlers(ctx, {
      callWhisperApi: jest.fn().mockRejectedValue(new Error('Whisper API timeout (30s)')),
    });
    const result = await harness.invoke('voice:transcribe', Buffer.from('audio'));
    expect(result.success).toBe(false);
    expect(result.code).toBe('WHISPER_TIMEOUT');
  });

  test('maps 401 error to OPENAI_AUTH_ERROR', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
    registerWhisperHandlers(ctx, {
      callWhisperApi: jest.fn().mockRejectedValue(new Error('Whisper API 401: unauthorized')),
    });
    const result = await harness.invoke('voice:transcribe', Buffer.from('audio'));
    expect(result.success).toBe(false);
    expect(result.code).toBe('OPENAI_AUTH_ERROR');
  });

  test('maps 403 error to OPENAI_AUTH_ERROR', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
    registerWhisperHandlers(ctx, {
      callWhisperApi: jest.fn().mockRejectedValue(new Error('Whisper API 403: forbidden')),
    });
    const result = await harness.invoke('voice:transcribe', Buffer.from('audio'));
    expect(result.success).toBe(false);
    expect(result.code).toBe('OPENAI_AUTH_ERROR');
  });

  test('maps parse error to WHISPER_RESPONSE_INVALID', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
    registerWhisperHandlers(ctx, {
      callWhisperApi: jest.fn().mockRejectedValue(new Error('Failed to parse Whisper response')),
    });
    const result = await harness.invoke('voice:transcribe', Buffer.from('audio'));
    expect(result.success).toBe(false);
    expect(result.code).toBe('WHISPER_RESPONSE_INVALID');
  });

  test('maps generic error to WHISPER_TRANSCRIPTION_FAILED', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
    registerWhisperHandlers(ctx, {
      callWhisperApi: jest.fn().mockRejectedValue(new Error('Something unexpected')),
    });
    const result = await harness.invoke('voice:transcribe', Buffer.from('audio'));
    expect(result.success).toBe(false);
    expect(result.code).toBe('WHISPER_TRANSCRIPTION_FAILED');
    expect(result.error).toBe('Something unexpected');
  });

  test('maps error with no message property', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-fake-key-do-not-use';
    registerWhisperHandlers(ctx, {
      callWhisperApi: jest.fn().mockRejectedValue({}),
    });
    const result = await harness.invoke('voice:transcribe', Buffer.from('audio'));
    expect(result.success).toBe(false);
    expect(result.code).toBe('WHISPER_TRANSCRIPTION_FAILED');
  });

  // ── unregister ──

  test('unregister removes voice:transcribe handler', () => {
    registerWhisperHandlers(ctx);
    registerWhisperHandlers.unregister({ ipcMain: harness.ipcMain });
    expect(harness.ipcMain.removeHandler).toHaveBeenCalledWith('voice:transcribe');
  });

  test('unregister handles missing ipcMain gracefully', () => {
    expect(() => registerWhisperHandlers.unregister()).not.toThrow();
    expect(() => registerWhisperHandlers.unregister({})).not.toThrow();
  });
});
