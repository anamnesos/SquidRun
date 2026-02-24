const {
  DEFAULT_GEMINI_MODEL_ID,
  buildGeminiCommand,
  ensureGeminiModelFlag,
  parseGeminiIncludeDirectoryFromCommand,
  parseGeminiModelFromCommand,
  resolveGeminiModelId,
} = require('../modules/gemini-command');

describe('gemini-command helpers', () => {
  test('parseGeminiModelFromCommand extracts -m and --model values', () => {
    expect(parseGeminiModelFromCommand('gemini -m gemini-3-pro-preview --yolo')).toBe('gemini-3-pro-preview');
    expect(parseGeminiModelFromCommand('gemini --model=gemini-2.5-pro --yolo')).toBe('gemini-2.5-pro');
  });

  test('resolveGeminiModelId prefers explicit option over command/default', () => {
    expect(resolveGeminiModelId({
      preferredModel: 'gemini-3-pro-preview',
      existingCommand: 'gemini -m gemini-2.5-pro --yolo',
    })).toBe('gemini-3-pro-preview');
  });

  test('resolveGeminiModelId falls back to command model when present', () => {
    expect(resolveGeminiModelId({
      existingCommand: 'gemini --yolo --model gemini-3-pro-preview',
    })).toBe('gemini-3-pro-preview');
  });

  test('parseGeminiIncludeDirectoryFromCommand extracts include path', () => {
    expect(parseGeminiIncludeDirectoryFromCommand('gemini --yolo --include-directories "/tmp/workspace"'))
      .toBe('/tmp/workspace');
  });

  test('ensureGeminiModelFlag appends model while preserving existing args', () => {
    expect(ensureGeminiModelFlag(
      'gemini --yolo --include-directories "<project-root>"',
      { preferredModel: 'gemini-3.1-pro-preview' }
    )).toBe('gemini --yolo --include-directories "<project-root>" --model gemini-3.1-pro-preview');
  });

  test('buildGeminiCommand always includes explicit model', () => {
    const command = buildGeminiCommand();
    expect(command).toMatch(/^gemini --yolo --model /);
    expect(command).not.toContain('--include-directories');
    expect(command).toContain(DEFAULT_GEMINI_MODEL_ID);
  });
});
