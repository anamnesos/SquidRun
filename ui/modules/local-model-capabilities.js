const fs = require('fs');
const os = require('os');
const path = require('path');
const { getProjectRoot, resolveCoordPath } = require('../config');

const DEFAULT_ANTHROPIC_BASE_URL = String(process.env.SQUIDRUN_ANTHROPIC_BASE_URL || 'https://api.anthropic.com').trim();
const DEFAULT_EXTRACTION_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.SQUIDRUN_EXTRACTION_TIMEOUT_MS || '30000', 10) || 30000
);
const DEFAULT_SLEEP_EXTRACTION_MODEL = String(process.env.SQUIDRUN_SLEEP_EXTRACTION_MODEL || 'claude-opus-4-6').trim();

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

function hasKey(value) {
  return typeof value === 'string' && value.trim().length > 0;
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

function buildAnthropicExtractionCommand(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || getProjectRoot() || process.cwd()));
  const model = toNonEmptyString(options.model) || DEFAULT_SLEEP_EXTRACTION_MODEL;
  if (!model) return '';
  const scriptPath = path.join(projectRoot, 'ui', 'scripts', 'claude-extract.js');
  const args = [
    process.execPath,
    scriptPath,
    '--model',
    model,
    '--base-url',
    toNonEmptyString(options.baseUrl) || DEFAULT_ANTHROPIC_BASE_URL,
    '--timeout',
    String(Math.max(1000, Number.parseInt(String(options.timeoutMs || DEFAULT_EXTRACTION_TIMEOUT_MS), 10) || DEFAULT_EXTRACTION_TIMEOUT_MS)),
  ];
  return args.map(quoteShellArg).join(' ');
}

function buildSystemCapabilitiesSnapshot(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || getProjectRoot() || process.cwd()));
  const settings = (options.settings && typeof options.settings === 'object') ? options.settings : {};
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const cpuInfo = Array.isArray(os.cpus()) ? os.cpus() : [];
  const localModelEnabled = settings.localModelEnabled === true;
  const anthropicApiKey = toNonEmptyString(options.anthropicApiKey)
    || toNonEmptyString(process.env.ANTHROPIC_API_KEY);
  const sleepExtractionModel = toNonEmptyString(options.sleepExtractionModel)
    || DEFAULT_SLEEP_EXTRACTION_MODEL;
  const extractionAvailable = hasKey(anthropicApiKey);
  const extractionCommand = extractionAvailable
    ? buildAnthropicExtractionCommand({
      projectRoot,
      model: sleepExtractionModel,
      baseUrl: options.anthropicBaseUrl,
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
      sleepExtraction: {
        enabled: extractionAvailable,
        available: extractionAvailable,
        provider: extractionAvailable ? 'anthropic' : 'fallback',
        model: extractionAvailable ? sleepExtractionModel : null,
        timeoutMs: Math.max(1000, Number.parseInt(String(options.extractionTimeoutMs || DEFAULT_EXTRACTION_TIMEOUT_MS), 10) || DEFAULT_EXTRACTION_TIMEOUT_MS),
        command: extractionCommand || null,
        path: extractionAvailable ? 'anthropic-api' : 'fallback',
        reason: extractionAvailable
          ? 'anthropic_api_configured'
          : 'anthropic_api_key_missing',
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
  DEFAULT_SLEEP_EXTRACTION_MODEL,
  DEFAULT_ANTHROPIC_BASE_URL,
  buildAnthropicExtractionCommand,
  buildSystemCapabilitiesSnapshot,
  readSystemCapabilitiesSnapshot,
  resolveSleepExtractionCommandFromSnapshot,
  resolveSystemCapabilitiesPath,
  writeSystemCapabilitiesSnapshot,
};
