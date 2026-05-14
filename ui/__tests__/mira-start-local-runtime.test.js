'use strict';

const path = require('path');

const {
  buildRuntimeEnv,
  buildServerKillScript,
  defaultModel,
  defaultPort,
  defaultStateRoot,
  parseArgs,
  parseOllamaModels,
  resolveOllamaExecutable,
} = require('../../mira/tools/start-local-runtime');

describe('Mira local runtime starter', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');

  test('defaults to Gemma 31B on the Mira dev state root', () => {
    const args = parseArgs([]);

    expect(args).toEqual(expect.objectContaining({
      port: defaultPort,
      model: 'gemma4:31b',
      stateRoot: defaultStateRoot,
      pull: false,
    }));
    expect(defaultModel).toBe('gemma4:31b');
  });

  test('builds the runtime env that prevents stale OpenAI/default server confusion', () => {
    const args = parseArgs([]);
    const env = buildRuntimeEnv(args, {
      OPENAI_API_KEY: 'sk-test',
    });

    expect(env).toEqual(expect.objectContaining({
      MIRA_STATE_ROOT: path.join(repoRoot, 'mira', '.state-dev'),
      MIRA_RUNTIME_MODEL_PROVIDER: 'ollama',
      MIRA_OLLAMA_MODEL: 'gemma4:31b',
      MIRA_RUNTIME_PORT: '47373',
      OPENAI_API_KEY: 'sk-test',
    }));
  });

  test('accepts explicit model, port, state root, and pull options', () => {
    const args = parseArgs([
      '--model',
      'gemma4:26b',
      '--port',
      '47444',
      '--state-root',
      'D:\\mira-state',
      '--pull',
      '--no-build',
      '--no-kill',
      '--no-start',
      '--json',
    ]);

    expect(args).toEqual(expect.objectContaining({
      model: 'gemma4:26b',
      port: 47444,
      stateRoot: 'D:\\mira-state',
      pull: true,
      noBuild: true,
      noKill: true,
      noStart: true,
      json: true,
    }));
  });

  test('extracts Ollama model names from tag responses', () => {
    expect(parseOllamaModels({
      models: [
        { name: 'gemma4:31b' },
        { model: 'llama3.2:latest' },
        null,
      ],
    })).toEqual([
      'gemma4:31b',
      'llama3.2:latest',
    ]);
  });

  test('prefers the configured Ollama executable then the local Windows install', () => {
    expect(resolveOllamaExecutable({
      MIRA_OLLAMA_EXECUTABLE: 'D:\\tools\\ollama.exe',
    })).toBe('D:\\tools\\ollama.exe');
  });

  test('kill script targets old dist and tsx runtime servers only', () => {
    const script = buildServerKillScript();

    expect(script).toContain('mira[\\\\/]runtime');
    expect(script).toContain('dist[\\\\/]server\\.js');
    expect(script).toContain('src[\\\\/]server\\.ts');
    expect(script).not.toContain('telegram');
    expect(script).not.toContain('ollama');
  });
});
