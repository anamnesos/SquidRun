const fs = require('fs');
const os = require('os');
const path = require('path');
const { getProjectRoot, resolveCoordPath } = require('../config');

const DEFAULT_OLLAMA_BASE_URL = String(process.env.SQUIDRUN_OLLAMA_URL || 'http://127.0.0.1:11434').trim();
const DEFAULT_OLLAMA_TIMEOUT_MS = Math.max(
  250,
  Number.parseInt(process.env.SQUIDRUN_OLLAMA_TIMEOUT_MS || '1500', 10) || 1500
);
const DEFAULT_EXTRACTION_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.SQUIDRUN_OLLAMA_EXTRACTION_TIMEOUT_MS || '30000', 10) || 30000
);
const DEFAULT_PREFERRED_OLLAMA_MODELS = Object.freeze([
  'llama3:8b',
  'llama3.1:8b',
  'llama3.2:3b',
  'phi3:mini',
  'qwen2.5:7b',
  'mistral:7b',
]);

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function quoteShellArg(value) {
  const text = String(value ?? '');
  if (!text) return '""';
  return `"${text.replace(/"/g, '\\"')}"`;
}

function resolveSystemCapabilitiesPath(projectRoot = null) {
  const normalizedProjectRoot = toNonEmptyString(projectRoot);
  if (normalizedProjectRoot) {
    return path.join(path.resolve(normalizedProjectRoot), '.squidrun', 'runtime', 'system-capabilities.json');
  }
  return resolveCoordPath(path.join('runtime', 'system-capabilities.json'), { forWrite: true });
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, payload) {
  ensureDir(filePath);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, filePath);
  return filePath;
}

function normalizePreferredModels(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => toNonEmptyString(entry)).filter(Boolean);
  }
  const raw = toNonEmptyString(value);
  if (!raw) return Array.from(DEFAULT_PREFERRED_OLLAMA_MODELS);
  return raw.split(',').map((entry) => toNonEmptyString(entry)).filter(Boolean);
}

function normalizeModelInventory(payload = {}) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  return models
    .map((entry) => {
      const name = toNonEmptyString(entry?.name);
      if (!name) return null;
      return {
        name,
        size: Number.isFinite(Number(entry?.size)) ? Number(entry.size) : null,
        modifiedAt: toNonEmptyString(entry?.modified_at),
      };
    })
    .filter(Boolean);
}

function pickPreferredModel(pulledModels = [], preferredModels = DEFAULT_PREFERRED_OLLAMA_MODELS) {
  const availableNames = pulledModels.map((entry) => String(entry?.name || '').trim()).filter(Boolean);
  if (availableNames.length === 0) return null;
  for (const preferred of preferredModels) {
    const exact = availableNames.find((name) => name === preferred);
    if (exact) return exact;
    const prefix = availableNames.find((name) => name.startsWith(`${preferred}:`) || name.startsWith(`${preferred}-`));
    if (prefix) return prefix;
  }
  return null;
}

async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch_unavailable');
  }
  const timeoutMs = Math.max(250, Number.parseInt(String(options.timeoutMs || DEFAULT_OLLAMA_TIMEOUT_MS), 10) || DEFAULT_OLLAMA_TIMEOUT_MS);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutHandle = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetchImpl(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      signal: controller ? controller.signal : undefined,
    });
    if (!response || response.ok !== true) {
      throw new Error(`http_${response?.status || 'unknown'}`);
    }
    return await response.json();
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function detectOllamaRuntime(options = {}) {
  const baseUrl = toNonEmptyString(options.baseUrl) || DEFAULT_OLLAMA_BASE_URL;
  const preferredModels = normalizePreferredModels(
    options.preferredModels || process.env.SQUIDRUN_OLLAMA_MODELS
  );
  const checkedAt = new Date(
    Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()
  ).toISOString();

  try {
    const tags = await fetchJson(`${baseUrl}/api/tags`, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
    const pulledModels = normalizeModelInventory(tags);
    const selectedModel = pickPreferredModel(pulledModels, preferredModels);
    return {
      provider: 'ollama',
      checkedAt,
      baseUrl,
      reachable: true,
      running: true,
      pulledModels,
      preferredModels,
      selectedModel,
      suitableModelAvailable: Boolean(selectedModel),
      error: null,
    };
  } catch (err) {
    return {
      provider: 'ollama',
      checkedAt,
      baseUrl,
      reachable: false,
      running: false,
      pulledModels: [],
      preferredModels,
      selectedModel: null,
      suitableModelAvailable: false,
      error: err?.name === 'AbortError'
        ? `timeout_after_${Math.max(250, Number.parseInt(String(options.timeoutMs || DEFAULT_OLLAMA_TIMEOUT_MS), 10) || DEFAULT_OLLAMA_TIMEOUT_MS)}ms`
        : (err?.message || 'ollama_unreachable'),
    };
  }
}

function buildOllamaExtractionCommand(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || getProjectRoot() || process.cwd()));
  const model = toNonEmptyString(options.model);
  if (!model) return '';
  const scriptPath = path.join(projectRoot, 'ui', 'scripts', 'ollama-extract.js');
  const args = [
    process.execPath,
    scriptPath,
    '--model',
    model,
    '--base-url',
    toNonEmptyString(options.baseUrl) || DEFAULT_OLLAMA_BASE_URL,
    '--timeout',
    String(Math.max(1000, Number.parseInt(String(options.timeoutMs || DEFAULT_EXTRACTION_TIMEOUT_MS), 10) || DEFAULT_EXTRACTION_TIMEOUT_MS)),
  ];
  return args.map(quoteShellArg).join(' ');
}

function buildSystemCapabilitiesSnapshot(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || getProjectRoot() || process.cwd()));
  const settings = (options.settings && typeof options.settings === 'object') ? options.settings : {};
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const ollama = (options.ollama && typeof options.ollama === 'object') ? options.ollama : {
    provider: 'ollama',
    checkedAt: new Date(nowMs).toISOString(),
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
    reachable: false,
    running: false,
    pulledModels: [],
    preferredModels: Array.from(DEFAULT_PREFERRED_OLLAMA_MODELS),
    selectedModel: null,
    suitableModelAvailable: false,
    error: 'not_checked',
  };
  const cpuInfo = Array.isArray(os.cpus()) ? os.cpus() : [];
  const localModelEnabled = settings.localModelEnabled === true;
  const extractionAvailable = localModelEnabled && ollama.running === true && ollama.suitableModelAvailable === true;
  const extractionCommand = extractionAvailable
    ? buildOllamaExtractionCommand({
      projectRoot,
      model: ollama.selectedModel,
      baseUrl: ollama.baseUrl,
      timeoutMs: options.extractionTimeoutMs,
    })
    : '';

  return {
    generatedAt: new Date(nowMs).toISOString(),
    projectRoot,
    path: options.path || resolveSystemCapabilitiesPath(projectRoot),
    hardware: {
      platform: process.platform,
      arch: process.arch,
      cpuCount: cpuInfo.length,
      cpuModel: cpuInfo[0]?.model || null,
      totalMemoryBytes: Number(os.totalmem?.() || 0),
    },
    localModels: {
      enabled: localModelEnabled,
      provider: 'ollama',
      ollama,
      sleepExtraction: {
        enabled: extractionAvailable,
        available: ollama.running === true && ollama.suitableModelAvailable === true,
        model: ollama.selectedModel,
        timeoutMs: Math.max(1000, Number.parseInt(String(options.extractionTimeoutMs || DEFAULT_EXTRACTION_TIMEOUT_MS), 10) || DEFAULT_EXTRACTION_TIMEOUT_MS),
        command: extractionCommand || null,
        path: extractionAvailable ? 'local-ollama' : 'fallback',
        reason: extractionAvailable
          ? 'local_ollama_enabled'
          : (ollama.running !== true
            ? 'ollama_unavailable'
            : (ollama.suitableModelAvailable !== true ? 'model_missing' : 'feature_disabled')),
      },
    },
  };
}

function readSystemCapabilitiesSnapshot(projectRoot = null) {
  const filePath = resolveSystemCapabilitiesPath(projectRoot);
  const snapshot = readJsonFile(filePath);
  return snapshot && typeof snapshot === 'object' ? snapshot : null;
}

function writeSystemCapabilitiesSnapshot(snapshot, filePath = null) {
  const resolvedPath = filePath || snapshot?.path || resolveSystemCapabilitiesPath(snapshot?.projectRoot || null);
  writeJsonFile(resolvedPath, {
    ...(snapshot || {}),
    path: resolvedPath,
  });
  return resolvedPath;
}

function resolveSleepExtractionCommandFromSnapshot(snapshot = null) {
  const command = toNonEmptyString(snapshot?.localModels?.sleepExtraction?.command);
  const enabled = snapshot?.localModels?.sleepExtraction?.enabled === true;
  return enabled ? command : '';
}

module.exports = {
  DEFAULT_EXTRACTION_TIMEOUT_MS,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_TIMEOUT_MS,
  DEFAULT_PREFERRED_OLLAMA_MODELS,
  buildOllamaExtractionCommand,
  buildSystemCapabilitiesSnapshot,
  detectOllamaRuntime,
  fetchJson,
  normalizeModelInventory,
  pickPreferredModel,
  readSystemCapabilitiesSnapshot,
  resolveSleepExtractionCommandFromSnapshot,
  resolveSystemCapabilitiesPath,
  writeSystemCapabilitiesSnapshot,
};
