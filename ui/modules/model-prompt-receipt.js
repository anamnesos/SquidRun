const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  WORKSPACE_PATH,
  resolveCoordPath,
} = require('../config');

const SEMANTIC_EVENT = 'prompt_submit';
const STATUS_PROMPT_SUBMITTED_IN_BAND = 'prompt_submitted.in_band';
const STATUS_SUBMIT_INFERRED_VISUAL = 'submit_inferred.visual';
const STATUS_ACCEPTED_UNVERIFIED = 'accepted.unverified';

const PROOF_RANKS = Object.freeze({
  [STATUS_PROMPT_SUBMITTED_IN_BAND]: 300,
  [STATUS_SUBMIT_INFERRED_VISUAL]: 200,
  [STATUS_ACCEPTED_UNVERIFIED]: 100,
  'delivered.verified': 250,
  'delivered.websocket': 150,
  unrouted: 0,
});

const VERSION_FLOOR_MAPPINGS = Object.freeze([
  {
    runtime: 'codex',
    versionFloor: '0.139.0',
    hookEventName: 'UserPromptSubmit',
    semanticEvent: SEMANTIC_EVENT,
    status: STATUS_PROMPT_SUBMITTED_IN_BAND,
  },
  {
    runtime: 'gemini',
    versionFloor: '0.46.0',
    hookEventName: 'BeforeAgent',
    semanticEvent: SEMANTIC_EVENT,
    status: STATUS_PROMPT_SUBMITTED_IN_BAND,
  },
  {
    runtime: 'claude',
    versionFloor: '2.1.170',
    hookEventName: 'UserPromptSubmit',
    semanticEvent: SEMANTIC_EVENT,
    status: STATUS_PROMPT_SUBMITTED_IN_BAND,
  },
]);

const RECEIPT_MARKER_PREFIX = '[SQUIDRUN_RECEIPT';
const DEFAULT_STATE = Object.freeze({
  receiptsByDeliveryId: {},
  deliveryIdByMessageId: {},
  duplicateCounts: {},
  stats: {
    receiptCount: 0,
    duplicateReceiptCount: 0,
  },
});

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeRuntime(value) {
  const normalized = toNonEmptyString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function getReceiptDir() {
  const envDir = toNonEmptyString(process.env.SQUIDRUN_MODEL_PROMPT_RECEIPT_DIR);
  if (envDir) return path.resolve(envDir);
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('runtime', 'model-prompt-receipts'), { forWrite: true });
  }
  return path.join(WORKSPACE_PATH || process.cwd(), '.squidrun', 'runtime', 'model-prompt-receipts');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getReceiptPaths() {
  const dir = getReceiptDir();
  return {
    dir,
    sinkPath: path.join(dir, 'receipts.jsonl'),
    statePath: path.join(dir, 'receipts-state.json'),
    trustPath: path.join(dir, 'trust-checks.jsonl'),
  };
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function readState(statePath = getReceiptPaths().statePath) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      receiptsByDeliveryId: parsed.receiptsByDeliveryId && typeof parsed.receiptsByDeliveryId === 'object'
        ? parsed.receiptsByDeliveryId
        : {},
      deliveryIdByMessageId: parsed.deliveryIdByMessageId && typeof parsed.deliveryIdByMessageId === 'object'
        ? parsed.deliveryIdByMessageId
        : {},
      duplicateCounts: parsed.duplicateCounts && typeof parsed.duplicateCounts === 'object'
        ? parsed.duplicateCounts
        : {},
      stats: {
        receiptCount: Number(parsed.stats?.receiptCount || 0),
        duplicateReceiptCount: Number(parsed.stats?.duplicateReceiptCount || 0),
      },
    };
  } catch (_err) {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function writeState(state, statePath = getReceiptPaths().statePath) {
  ensureDir(path.dirname(statePath));
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function parseMarkerTokens(tokenText) {
  const parsed = {};
  const tokenPattern = /([A-Za-z0-9_.-]+)=("([^"]*)"|'([^']*)'|[^\s\]]+)/g;
  let match;
  while ((match = tokenPattern.exec(tokenText))) {
    const key = match[1];
    const value = match[3] ?? match[4] ?? match[2];
    parsed[key] = value;
  }
  return parsed;
}

function extractReceiptMarker(promptText) {
  const text = typeof promptText === 'string' ? promptText : '';
  if (!text.includes(RECEIPT_MARKER_PREFIX)) return null;
  const markerMatch = text.match(/\[SQUIDRUN_RECEIPT\s+([^\]]+)\]/);
  if (!markerMatch) return null;
  const fields = parseMarkerTokens(markerMatch[1]);
  const semanticEvent = toNonEmptyString(fields.event) || SEMANTIC_EVENT;
  if (semanticEvent !== SEMANTIC_EVENT) return null;
  const deliveryId = toNonEmptyString(fields.deliveryId) || toNonEmptyString(fields.delivery_id);
  const messageId = toNonEmptyString(fields.messageId) || toNonEmptyString(fields.message_id);
  const receiptId = deliveryId || messageId;
  if (!receiptId) return null;
  return {
    semanticEvent,
    deliveryId: receiptId,
    rawDeliveryId: deliveryId || null,
    messageId: messageId || receiptId,
    fields,
  };
}

function collectPromptCandidates(value, seen = new Set()) {
  if (!value || seen.has(value)) return [];
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object') return [];
  seen.add(value);

  const candidates = [];
  for (const key of ['prompt', 'user_prompt', 'userPrompt', 'message', 'input', 'text', 'content']) {
    if (typeof value[key] === 'string') candidates.push(value[key]);
  }
  if (Array.isArray(value.messages)) {
    for (const message of value.messages) {
      candidates.push(...collectPromptCandidates(message, seen));
    }
  }
  if (value.llm_request) candidates.push(...collectPromptCandidates(value.llm_request, seen));
  if (value.request) candidates.push(...collectPromptCandidates(value.request, seen));
  return candidates;
}

function extractPromptText(payload) {
  const candidates = collectPromptCandidates(payload);
  return candidates.find((candidate) => candidate.includes(RECEIPT_MARKER_PREFIX)) || candidates[0] || '';
}

function findMapping(runtime, hookEventName) {
  const normalizedRuntime = normalizeRuntime(runtime);
  const normalizedHookEvent = toNonEmptyString(hookEventName);
  return VERSION_FLOOR_MAPPINGS.find((mapping) => (
    mapping.runtime === normalizedRuntime
    && mapping.hookEventName === normalizedHookEvent
  )) || null;
}

function normalizeHookReceiptInput(input = {}) {
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : input;
  const runtime = normalizeRuntime(input.runtime || payload.runtime || process.env.SQUIDRUN_HOOK_RUNTIME);
  const hookEventName = toNonEmptyString(input.hookEventName)
    || toNonEmptyString(input.event)
    || toNonEmptyString(payload.hook_event_name)
    || toNonEmptyString(payload.hookEventName);
  const promptText = toNonEmptyString(input.promptText) || extractPromptText(payload);
  return {
    runtime,
    hookEventName,
    payload,
    promptText,
  };
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function appendModelPromptReceipt(input = {}, options = {}) {
  const normalized = normalizeHookReceiptInput(input);
  const mapping = findMapping(normalized.runtime, normalized.hookEventName);
  if (!mapping) {
    return {
      ok: false,
      skipped: true,
      status: 'mapping_mismatch',
      runtime: normalized.runtime || null,
      hookEventName: normalized.hookEventName || null,
    };
  }

  const marker = extractReceiptMarker(normalized.promptText);
  if (!marker) {
    return {
      ok: false,
      skipped: true,
      status: 'marker_missing',
      runtime: mapping.runtime,
      hookEventName: mapping.hookEventName,
    };
  }

  const now = options.now || new Date().toISOString();
  const paths = getReceiptPaths();
  const state = readState(paths.statePath);
  const existing = state.receiptsByDeliveryId[marker.deliveryId];

  if (existing) {
    const duplicateCount = Number(state.duplicateCounts[marker.deliveryId] || 0) + 1;
    state.duplicateCounts[marker.deliveryId] = duplicateCount;
    state.stats.duplicateReceiptCount = Number(state.stats.duplicateReceiptCount || 0) + 1;
    const duplicateRecord = {
      schema: 'modelPromptReceipt.v0',
      timestamp: now,
      duplicate: true,
      status: 'duplicate_ignored',
      duplicateCount,
      deliveryId: marker.deliveryId,
      messageId: marker.messageId,
      firstReceiptTimestamp: existing.timestamp || null,
      runtime: mapping.runtime,
      hookEventName: mapping.hookEventName,
      semanticEvent: mapping.semanticEvent,
    };
    appendJsonl(paths.sinkPath, duplicateRecord);
    writeState(state, paths.statePath);
    return {
      ok: true,
      duplicate: true,
      status: 'duplicate_ignored',
      duplicateCount,
      receipt: existing,
    };
  }

  const receipt = {
    schema: 'modelPromptReceipt.v0',
    timestamp: now,
    status: mapping.status,
    semanticEvent: mapping.semanticEvent,
    runtime: mapping.runtime,
    versionFloor: mapping.versionFloor,
    hookEventName: mapping.hookEventName,
    deliveryId: marker.deliveryId,
    messageId: marker.messageId,
    proofRank: getProofRank(mapping.status),
    promptHash: hashText(normalized.promptText),
    promptBytes: Buffer.byteLength(String(normalized.promptText || ''), 'utf8'),
    payloadDropped: true,
  };
  state.receiptsByDeliveryId[receipt.deliveryId] = receipt;
  if (receipt.messageId) state.deliveryIdByMessageId[receipt.messageId] = receipt.deliveryId;
  state.stats.receiptCount = Number(state.stats.receiptCount || 0) + 1;
  appendJsonl(paths.sinkPath, receipt);
  writeState(state, paths.statePath);
  return {
    ok: true,
    duplicate: false,
    status: receipt.status,
    receipt,
  };
}

function getProofRank(status) {
  return Number(PROOF_RANKS[status] || 0);
}

function getModelPromptReceipt(id) {
  const normalized = toNonEmptyString(id);
  if (!normalized) return null;
  const state = readState();
  const deliveryId = state.receiptsByDeliveryId[normalized]
    ? normalized
    : state.deliveryIdByMessageId[normalized];
  if (!deliveryId) return null;
  return state.receiptsByDeliveryId[deliveryId] || null;
}

function getReceiptForAck(message = {}, handlerAck = null) {
  const ids = [
    message.deliveryId,
    message.messageId,
    handlerAck?.deliveryId,
    handlerAck?.details?.deliveryId,
    handlerAck?.handlerResult?.deliveryId,
  ].map(toNonEmptyString).filter(Boolean);
  for (const id of ids) {
    const receipt = getModelPromptReceipt(id);
    if (receipt) return receipt;
  }
  return null;
}

function applyModelPromptReceiptToAck(ackPayload = {}, message = {}, handlerAck = null) {
  const receipt = getReceiptForAck(message, handlerAck);
  if (!receipt) return ackPayload;
  const receiptRank = getProofRank(receipt.status);
  const currentRank = getProofRank(ackPayload.status);
  if (currentRank > receiptRank) return ackPayload;
  return {
    ...ackPayload,
    ok: true,
    accepted: true,
    queued: true,
    verified: true,
    status: receipt.status,
    userVisible: true,
    modelPromptReceipt: {
      schema: receipt.schema,
      status: receipt.status,
      semanticEvent: receipt.semanticEvent,
      runtime: receipt.runtime,
      versionFloor: receipt.versionFloor,
      hookEventName: receipt.hookEventName,
      deliveryId: receipt.deliveryId,
      messageId: receipt.messageId,
      timestamp: receipt.timestamp,
      proofRank: receipt.proofRank,
      payloadDropped: true,
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForModelPromptReceipt(message = {}, handlerAck = null, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(0, Number(options.timeoutMs))
    : 1200;
  const pollMs = Number.isFinite(Number(options.pollMs))
    ? Math.max(25, Number(options.pollMs))
    : 75;
  const startedAt = Date.now();
  let receipt = getReceiptForAck(message, handlerAck);
  while (!receipt && (Date.now() - startedAt) < timeoutMs) {
    await wait(pollMs);
    receipt = getReceiptForAck(message, handlerAck);
  }
  return receipt;
}

function buildReceiptMarker({ deliveryId = null, messageId = null } = {}) {
  const stableDeliveryId = toNonEmptyString(deliveryId) || toNonEmptyString(messageId);
  const stableMessageId = toNonEmptyString(messageId) || stableDeliveryId;
  if (!stableDeliveryId) return null;
  return `${RECEIPT_MARKER_PREFIX} event=${SEMANTIC_EVENT} deliveryId=${stableDeliveryId} messageId=${stableMessageId}]`;
}

function appendReceiptMarkerToPrompt(promptText, ids = {}) {
  const text = typeof promptText === 'string' ? promptText : String(promptText ?? '');
  if (text.includes(RECEIPT_MARKER_PREFIX)) return text;
  const marker = buildReceiptMarker(ids);
  if (!marker) return text;
  return `${text}\n${marker}`;
}

function readCodexTrustConfig() {
  const envConfig = toNonEmptyString(process.env.CODEX_CONFIG_FILE);
  const configPath = envConfig || path.join(os.homedir(), '.codex', 'config.toml');
  try {
    return {
      configPath,
      raw: fs.readFileSync(configPath, 'utf8'),
    };
  } catch (err) {
    return {
      configPath,
      raw: '',
      error: err.message,
    };
  }
}

function buildCodexTrustCheck(projectDir = process.cwd()) {
  const resolvedProjectDir = path.resolve(projectDir);
  const normalizedProjectDir = resolvedProjectDir.replace(/\\/g, '\\\\');
  const { configPath, raw, error } = readCodexTrustConfig();
  const exactPattern = new RegExp(`\\[projects\\.${escapeRegExp(JSON.stringify(normalizedProjectDir))}\\]`, 'i');
  const singleQuotedPattern = new RegExp(`\\[projects\\.'${escapeRegExp(normalizedProjectDir)}'\\]`, 'i');
  const ok = Boolean(raw && (exactPattern.test(raw) || singleQuotedPattern.test(raw)));
  return {
    schema: 'modelPromptReceipt.trustCheck.v0',
    timestamp: new Date().toISOString(),
    runtime: 'codex',
    cwd: resolvedProjectDir,
    configPath,
    exactCwdTrusted: ok,
    status: ok ? 'codex_exact_cwd_trusted' : 'codex_exact_cwd_trust_missing',
    expectedProjectKey: normalizedProjectDir,
    error: error || null,
  };
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendTrustCheckBreadcrumb(input = {}) {
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const cwd = toNonEmptyString(input.cwd)
    || toNonEmptyString(payload.cwd)
    || toNonEmptyString(payload.workspace)
    || toNonEmptyString(process.env.SQUIDRUN_PROJECT_ROOT)
    || process.cwd();
  const record = buildCodexTrustCheck(cwd);
  const paths = getReceiptPaths();
  appendJsonl(paths.trustPath, record);
  return record;
}

function readJsonConfig(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return JSON.parse(JSON.stringify(fallback));
  }
}

function writeJsonConfig(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeHookCommand(command) {
  return String(command || '').replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
}

function hasHookCommand(hooks, command) {
  const expected = normalizeHookCommand(command);
  return hooks.some((hook) => normalizeHookCommand(hook?.command) === expected);
}

function ensureHookEventCommand(config, eventName, command, options = {}) {
  const hooksRoot = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
  config.hooks = hooksRoot;
  const entries = Array.isArray(hooksRoot[eventName]) ? hooksRoot[eventName] : [];
  hooksRoot[eventName] = entries;

  const matcher = toNonEmptyString(options.matcher);
  let entry = entries.find((candidate) => (
    candidate
    && typeof candidate === 'object'
    && Array.isArray(candidate.hooks)
    && (!matcher || candidate.matcher === matcher)
  ));
  if (!entry) {
    entry = {
      ...(matcher ? { matcher } : {}),
      hooks: [],
    };
    entries.push(entry);
  }

  if (hasHookCommand(entry.hooks, command)) return false;
  entry.hooks.push({
    ...(options.name ? { name: options.name } : {}),
    type: 'command',
    command,
    ...(options.description ? { description: options.description } : {}),
  });
  return true;
}

function installModelPromptReceiptHooks(options = {}) {
  const projectRoot = path.resolve(toNonEmptyString(options.projectRoot) || process.cwd());
  const adapterPath = path.join(projectRoot, 'ui', 'scripts', 'model-prompt-receipt-adapter.js');
  const adapterPathPosix = adapterPath.replace(/\\/g, '/');
  const targets = [
    {
      name: 'codex',
      filePath: path.join(projectRoot, '.codex', 'hooks.json'),
      fallback: { hooks: {} },
      commands: [
        {
          eventName: 'SessionStart',
          matcher: 'startup|resume|clear|compact',
          command: `node '${adapterPath}' --runtime codex --event SessionStart --trust-check-only`,
        },
        {
          eventName: 'UserPromptSubmit',
          command: `node '${adapterPath}' --runtime codex --event UserPromptSubmit`,
        },
      ],
    },
    {
      name: 'claude',
      filePath: path.join(projectRoot, '.claude', 'settings.json'),
      fallback: { hooks: {} },
      commands: [
        {
          eventName: 'UserPromptSubmit',
          command: 'node "$CLAUDE_PROJECT_DIR/ui/scripts/model-prompt-receipt-adapter.js" --runtime claude --event UserPromptSubmit',
        },
      ],
    },
    {
      name: 'gemini',
      filePath: path.join(projectRoot, '.gemini', 'settings.json'),
      fallback: { hooks: {} },
      commands: [
        {
          eventName: 'BeforeAgent',
          name: 'model-prompt-receipt',
          command: `node "${adapterPathPosix}" --runtime gemini --event BeforeAgent`,
          description: 'Record in-band prompt submit receipt for SquidRun delivery proof',
        },
      ],
    },
  ];

  const installed = [];
  for (const target of targets) {
    const config = readJsonConfig(target.filePath, target.fallback);
    let changed = false;
    for (const commandSpec of target.commands) {
      changed = ensureHookEventCommand(config, commandSpec.eventName, commandSpec.command, commandSpec) || changed;
    }
    if (changed) writeJsonConfig(target.filePath, config);
    installed.push({
      runtime: target.name,
      path: target.filePath,
      changed,
    });
  }

  return {
    ok: true,
    projectRoot,
    adapterPath,
    installed,
    changed: installed.some((entry) => entry.changed),
  };
}

module.exports = {
  SEMANTIC_EVENT,
  STATUS_PROMPT_SUBMITTED_IN_BAND,
  STATUS_SUBMIT_INFERRED_VISUAL,
  STATUS_ACCEPTED_UNVERIFIED,
  VERSION_FLOOR_MAPPINGS,
  RECEIPT_MARKER_PREFIX,
  PROOF_RANKS,
  appendModelPromptReceipt,
  applyModelPromptReceiptToAck,
  appendReceiptMarkerToPrompt,
  appendTrustCheckBreadcrumb,
  buildReceiptMarker,
  extractReceiptMarker,
  findMapping,
  getModelPromptReceipt,
  getProofRank,
  getReceiptForAck,
  getReceiptPaths,
  installModelPromptReceiptHooks,
  readState,
  waitForModelPromptReceipt,
};
