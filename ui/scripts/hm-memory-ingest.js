#!/usr/bin/env node
/**
 * hm-memory-ingest: strict memory ingest CLI.
 *
 * Accepted input:
 * - strict flags
 * - --json '<payload>'
 * - stdin JSON (when piped)
 */

const { executeOperation, closeRuntime } = require('../modules/team-memory/worker-client');
const { CognitiveMemoryApi } = require('../modules/cognitive-memory-api');

function usage() {
  console.log('Usage: node hm-memory-ingest.js [options]');
  console.log('Required (flags mode):');
  console.log('  --content <text>');
  console.log('  --memory-class <class>');
  console.log('  --provenance-json <json>');
  console.log('  --confidence <0..1>');
  console.log('  --source-trace <trace>');
  console.log('Input modes:');
  console.log('  --json <json>              Full JSON payload');
  console.log('  echo {...} | node hm-memory-ingest.js');
  console.log('Optional:');
  console.log('  --scope-json <json>');
  console.log('  --device-id <id>');
  console.log('  --session-id <id>');
  console.log('  --claim-type <preference|operational_correction|objective_fact>');
  console.log('  --correction-of <id>');
  console.log('  --supersedes <id>');
  console.log('  --dedupe-key <key>');
  console.log('  --expires-at <ms|iso>');
  console.log('  --db-path <path>');
}

function parseArgs(argv) {
  const positional = [];
  const options = new Map();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2).trim();
    const next = argv[i + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) i += 1;
    options.set(key, value);
  }

  return { positional, options };
}

function getOption(options, key, fallback = null) {
  if (!options.has(key)) return fallback;
  return options.get(key);
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized || fallback;
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function shouldMirrorToCognitiveMemory(payload = {}) {
  const claimType = asString(payload.claim_type || payload.claimType || '', '').toLowerCase();
  const memoryClass = asString(payload.memory_class || payload.memoryClass || '', '').toLowerCase();
  if (claimType === 'objective_fact') return true;
  return memoryClass === 'architecture_decision' || memoryClass === 'codebase_inventory';
}

function deriveCognitiveMirrorInput(payload = {}) {
  const provenance = asObject(payload.provenance);
  const scope = asObject(payload.scope);
  const agentId = asString(
    provenance.agent_id,
    provenance.agentId,
    provenance.actor,
    provenance.source_role,
    provenance.role,
    'runtime'
  );
  const memoryClass = asString(payload.memory_class || payload.memoryClass || '', '');
  const claimType = asString(payload.claim_type || payload.claimType || '', '');
  const domain = asString(scope.domain || scope.topic || provenance.domain || memoryClass || claimType || 'team-memory', 'team-memory');
  const sourceRole = asString(provenance.source_role || provenance.role || agentId, agentId).toLowerCase();
  const userSourced = sourceRole === 'user' || sourceRole === 'human';
  return {
    content: asString(payload.content || '', ''),
    category: memoryClass || claimType || 'fact',
    agentId,
    confidence: Number.isFinite(Number(payload.confidence)) ? Number(payload.confidence) : undefined,
    sourceType: userSourced ? 'user-correction' : 'hm-memory-ingest',
    sourcePath: userSourced ? 'user:hm-memory-ingest' : `team-memory:${agentId || 'runtime'}`,
    heading: domain,
    metadata: {
      memory_class: memoryClass || null,
      claim_type: claimType || null,
      domain,
      sourceTrace: asString(payload.source_trace || '', '') || null,
      provenance,
      scope,
      userSourced,
    },
  };
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid ${label}: ${err.message}`);
  }
}

async function readStdinIfPresent() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

function buildPayloadFromFlags(options) {
  const payload = {
    content: asString(getOption(options, 'content', ''), ''),
    memory_class: asString(getOption(options, 'memory-class', ''), ''),
    confidence: Number(getOption(options, 'confidence', '')),
    source_trace: asString(getOption(options, 'source-trace', ''), ''),
  };

  const provenanceJson = asString(getOption(options, 'provenance-json', ''), '');
  if (provenanceJson) payload.provenance = parseJson(provenanceJson, '--provenance-json');

  const scopeJson = asString(getOption(options, 'scope-json', ''), '');
  if (scopeJson) payload.scope = parseJson(scopeJson, '--scope-json');

  const deviceId = asString(getOption(options, 'device-id', ''), '');
  const sessionId = asString(getOption(options, 'session-id', ''), '');
  const claimType = asString(getOption(options, 'claim-type', ''), '');
  const correctionOf = asString(getOption(options, 'correction-of', ''), '');
  const supersedes = asString(getOption(options, 'supersedes', ''), '');
  const dedupeKey = asString(getOption(options, 'dedupe-key', ''), '');
  const expiresAt = getOption(options, 'expires-at', null);

  if (deviceId) payload.device_id = deviceId;
  if (sessionId) payload.session_id = sessionId;
  if (claimType) payload.claim_type = claimType;
  if (correctionOf) payload.correction_of = correctionOf;
  if (supersedes) payload.supersedes = supersedes;
  if (dedupeKey) payload.dedupe_key = dedupeKey;
  if (expiresAt !== null && expiresAt !== undefined && expiresAt !== true) payload.expires_at = expiresAt;

  return payload;
}

async function resolvePayload(options) {
  const jsonArg = asString(getOption(options, 'json', ''), '');
  if (jsonArg) return parseJson(jsonArg, '--json');

  const stdinRaw = await readStdinIfPresent();
  if (stdinRaw) return parseJson(stdinRaw, 'stdin JSON');

  return buildPayloadFromFlags(options);
}

async function main(argv = process.argv.slice(2)) {
  const { options } = parseArgs(argv);
  if (getOption(options, 'help', false) === true) {
    usage();
    return 0;
  }

  const dbPath = asString(getOption(options, 'db-path', ''), '');
  const payload = await resolvePayload(options);
  const runtimeOptions = dbPath
    ? { runtimeOptions: { storeOptions: { dbPath } } }
    : {};

  try {
    const result = await executeOperation('ingest-memory', payload, runtimeOptions);
    let cognitiveMirror = null;
    if (result?.ok && shouldMirrorToCognitiveMemory(payload)) {
      const api = new CognitiveMemoryApi();
      try {
        cognitiveMirror = await api.ingest(deriveCognitiveMirrorInput(payload));
      } catch (error) {
        cognitiveMirror = {
          ok: false,
          reason: 'cognitive_mirror_failed',
          error: error.message,
        };
      } finally {
        api.close();
      }
    }
    if (cognitiveMirror) {
      result.cognitive_memory = cognitiveMirror;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result?.ok ? 0 : 1;
  } finally {
    await closeRuntime({ killTimeoutMs: 250 }).catch(() => {});
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = Number.isInteger(code) ? code : 0;
    })
    .catch((err) => {
      process.stderr.write(`hm-memory-ingest failed: ${err.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  buildPayloadFromFlags,
  main,
  parseArgs,
  resolvePayload,
};
