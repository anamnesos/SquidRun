/**
 * Whisper IPC handler structured error tests.
 */

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
    process.env.OPENAI_API_KEY = 'sk-test-key';
    registerWhisperHandlers(ctx);

    const result = await harness.invoke('voice:transcribe', 'not-a-buffer');

    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_AUDIO_DATA');
  });

  test('maps transcription errors to structured codes', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';
    registerWhisperHandlers(ctx, {
      callWhisperApi: jest.fn().mockRejectedValue(new Error('Whisper API timeout (30s)')),
    });

    const result = await harness.invoke('voice:transcribe', Buffer.from('audio'));

    expect(result.success).toBe(false);
    expect(result.code).toBe('WHISPER_TIMEOUT');
  });
});
