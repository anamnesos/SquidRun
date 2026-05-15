#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const defaultPort = 47373;
const defaultProvider = 'openai';
const defaultModel = 'gpt-5.5';
const defaultOllamaModel = 'gemma4:31b';
const defaultStateRoot = path.join(repoRoot, 'mira', '.state-dev');
const runtimeTsconfig = path.join(repoRoot, 'mira', 'runtime', 'tsconfig.json');
const serverPath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'server.js');
const tscBin = path.join(repoRoot, 'ui', 'node_modules', 'typescript', 'bin', 'tsc');
const runtimeLogDir = path.join(repoRoot, '.squidrun', 'runtime');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    json: false,
    pull: false,
    noBuild: false,
    noKill: false,
    noStart: false,
    port: defaultPort,
    provider: defaultProvider,
    model: null,
    stateRoot: defaultStateRoot,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--json') {
      args.json = true;
      continue;
    }
    if (token === '--pull') {
      args.pull = true;
      continue;
    }
    if (token === '--no-build') {
      args.noBuild = true;
      continue;
    }
    if (token === '--no-kill') {
      args.noKill = true;
      continue;
    }
    if (token === '--no-start') {
      args.noStart = true;
      continue;
    }
    if (token === '--port' && next) {
      args.port = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (token === '--model' && next) {
      args.model = next;
      index += 1;
      continue;
    }
    if (token === '--provider' && next) {
      const normalized = String(next || '').trim().toLowerCase();
      if (['openai', 'openai_responses', 'gpt'].includes(normalized)) {
        args.provider = 'openai';
      } else if (['ollama', 'ollama_chat', 'local', 'gemma'].includes(normalized)) {
        args.provider = 'ollama';
      } else {
        throw Object.assign(new Error(`Unsupported provider: ${next}`), { code: 'unsupported_provider' });
      }
      index += 1;
      continue;
    }
    if (token === '--state-root' && next) {
      args.stateRoot = next;
      index += 1;
      continue;
    }
    throw Object.assign(new Error(`Unknown or incomplete argument: ${token}`), { code: 'invalid_argument' });
  }

  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw Object.assign(new Error('--port must be a valid TCP port.'), { code: 'invalid_port' });
  }
  if (!args.model) {
    args.model = args.provider === 'ollama' ? defaultOllamaModel : defaultModel;
  }
  if (!args.model.trim()) {
    throw Object.assign(new Error('--model is required.'), { code: 'missing_model' });
  }

  return args;
}

function resolveOllamaExecutable(env = process.env) {
  const configured = String(env.MIRA_OLLAMA_EXECUTABLE || env.OLLAMA_EXECUTABLE || '').trim();
  if (configured) return configured;

  const localInstall = path.join(env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');
  if (localInstall && fs.existsSync(localInstall)) return localInstall;

  const command = os.platform() === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(command, ['ollama'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const first = String(result.stdout || '').split(/\r?\n/).find(Boolean);
  return first || 'ollama';
}

function buildRuntimeEnv(args, env = process.env) {
  const provider = args.provider === 'ollama' ? 'ollama' : 'openai';
  const runtimeEnv = {
    ...env,
    MIRA_STATE_ROOT: path.resolve(args.stateRoot),
    MIRA_RUNTIME_MODEL_PROVIDER: provider,
    MIRA_RUNTIME_TURN_MODEL: args.model,
    MIRA_RUNTIME_PORT: String(args.port),
  };
  if (provider === 'ollama') {
    runtimeEnv.MIRA_OLLAMA_MODEL = args.model;
  } else {
    runtimeEnv.MIRA_OLLAMA_MODEL = '';
    runtimeEnv.OLLAMA_MODEL = '';
  }
  return runtimeEnv;
}

function runtimeLogPath(name) {
  fs.mkdirSync(runtimeLogDir, { recursive: true });
  return path.join(runtimeLogDir, name);
}

function spawnDetached(executable, args, options = {}) {
  const child = spawn(executable, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    detached: true,
    stdio: options.stdio || 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function requestJson(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'http_error', status: response.status });
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForJson(url, timeoutMs = 12000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await requestJson(url, 2500);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function parseOllamaModels(tagsResponse) {
  if (!tagsResponse || !Array.isArray(tagsResponse.models)) return [];
  return tagsResponse.models
    .map((model) => String(model?.name || model?.model || '').trim())
    .filter(Boolean);
}

function buildServerKillScript() {
  return [
    '$pattern = \'mira[\\\\/]runtime[\\\\/](dist[\\\\/]server\\.js|src[\\\\/]server\\.ts)\';',
    'Get-CimInstance Win32_Process |',
    '  Where-Object { $_.CommandLine -match $pattern } |',
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
  ].join(' ');
}

function killStaleRuntimeServers() {
  if (os.platform() === 'win32') {
    const result = spawnSync('powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      buildServerKillScript(),
    ], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stderr: String(result.stderr || '').trim(),
    };
  }

  return {
    ok: true,
    status: 0,
    stderr: '',
  };
}

function runBuild() {
  execFileSync(process.execPath, [tscBin, '-p', runtimeTsconfig], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
}

function pullModel(ollamaExecutable, model) {
  const result = spawnSync(ollamaExecutable, ['pull', model], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

async function ensureOllama(args, ollamaExecutable) {
  let servePid = null;
  try {
    await requestJson('http://127.0.0.1:11434/api/tags', 2500);
  } catch {
    const outPath = runtimeLogPath('ollama-serve.out.log');
    const errPath = runtimeLogPath('ollama-serve.err.log');
    const out = fs.openSync(outPath, 'a');
    const err = fs.openSync(errPath, 'a');
    servePid = spawnDetached(ollamaExecutable, ['serve'], {
      stdio: ['ignore', out, err],
    });
  }

  let tags = await waitForJson('http://127.0.0.1:11434/api/tags', 20000);
  let models = parseOllamaModels(tags);
  if (!models.includes(args.model) && args.pull) {
    const pull = pullModel(ollamaExecutable, args.model);
    if (!pull.ok) {
      throw Object.assign(new Error(`ollama pull ${args.model} failed.`), {
        code: 'ollama_pull_failed',
        stderr: pull.stderr,
      });
    }
    tags = await waitForJson('http://127.0.0.1:11434/api/tags', 20000);
    models = parseOllamaModels(tags);
  }

  return {
    servePid,
    models,
    modelAvailable: models.includes(args.model),
  };
}

async function startLocalRuntime(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const ollamaExecutable = resolveOllamaExecutable(env);
  const steps = [];
  const runtimeEnv = buildRuntimeEnv(args, env);

  if (args.provider === 'ollama') {
    const ollama = await ensureOllama(args, ollamaExecutable);
    steps.push({
      id: 'ollama',
      modelAvailable: ollama.modelAvailable,
      servePid: ollama.servePid,
    });
    if (!ollama.modelAvailable) {
      throw Object.assign(new Error(`${args.model} is not pulled. Run this command again with --pull.`), {
        code: 'ollama_model_missing',
        model: args.model,
        installedModels: ollama.models,
      });
    }
  } else {
    steps.push({ id: 'provider', provider: 'openai' });
  }

  if (!args.noBuild) {
    runBuild();
    steps.push({ id: 'build', ok: true });
  }

  if (!args.noKill) {
    steps.push({ id: 'kill_stale_runtime', ...killStaleRuntimeServers() });
  }

  let runtimePid = null;
  if (!args.noStart) {
    const out = fs.openSync(runtimeLogPath('mira-runtime-local.out.log'), 'a');
    const err = fs.openSync(runtimeLogPath('mira-runtime-local.err.log'), 'a');
    runtimePid = spawnDetached(process.execPath, [serverPath], {
      env: runtimeEnv,
      stdio: ['ignore', out, err],
    });
    await waitForJson(`http://127.0.0.1:${args.port}/model/status`, 20000);
    steps.push({ id: 'runtime', pid: runtimePid, port: args.port });
  }

  const status = await requestJson(`http://127.0.0.1:${args.port}/model/status`, 5000);
  return {
    ok: true,
    protocol: 'mira.local_runtime_start.v0',
    url: `http://127.0.0.1:${args.port}/`,
    provider: args.provider,
    model: args.model,
    stateRoot: runtimeEnv.MIRA_STATE_ROOT,
    runtimePid,
    steps,
    modelStatus: status,
  };
}

function format(result) {
  return [
    `Mira local runtime: ${result.url}`,
    `provider=${result.provider}`,
    `model=${result.model}`,
    `state_root=${result.stateRoot}`,
    `model_ready=${result.modelStatus.available}`,
    `runtime_pid=${result.runtimePid || 'not started'}`,
  ].join('\n');
}

async function main() {
  try {
    const args = parseArgs();
    const result = await startLocalRuntime(process.argv.slice(2), process.env);
    process.stdout.write(`${args.json ? JSON.stringify(result, null, 2) : format(result)}\n`);
  } catch (error) {
    const payload = {
      ok: false,
      error: {
        code: error?.code || 'start_local_runtime_failed',
        message: error instanceof Error ? error.message : String(error),
        model: error?.model || null,
        installedModels: error?.installedModels || [],
      },
    };
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stderr.write(`${payload.error.message}\n`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildRuntimeEnv,
  buildServerKillScript,
  defaultModel,
  defaultOllamaModel,
  defaultPort,
  defaultProvider,
  defaultStateRoot,
  format,
  parseArgs,
  parseOllamaModels,
  resolveOllamaExecutable,
  startLocalRuntime,
};
