#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');

const ATTESTATION_SCHEMA = 'squidrun.codex_computer_use_post_tool_attestation.v1';
const LIST_WINDOWS_SCHEMA = 'squidrun.codex_computer_use_list_windows_proof.v1';
const TOOL_NAME = 'mcp__node_repl__js';
const MAX_STDIN_BYTES = 4 * 1024 * 1024;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function requiredEnvironment() {
  const names = [
    'SQUIDRUN_CUA_PROOF_SECRET',
    'SQUIDRUN_CUA_PROOF_JOURNAL',
    'SQUIDRUN_CUA_PROOF_CLAIM_ID',
    'SQUIDRUN_CUA_PROOF_PANE_ID',
    'SQUIDRUN_CUA_PROOF_PROJECT_ROOT',
    'SQUIDRUN_CUA_PROOF_GENERATION_DIGEST',
    'SQUIDRUN_CUA_PROOF_TOOL_INPUT_B64',
    'SQUIDRUN_CUA_PROOF_TOOL_INPUT_SHA256',
    'SQUIDRUN_CUA_PROOF_CLIENT_PATH',
    'SQUIDRUN_CUA_PROOF_CLIENT_SHA256',
    'SQUIDRUN_CUA_PROOF_INTEGRITY_B64',
    'SQUIDRUN_CUA_PROOF_HOOK_AUDIT_DIGEST',
  ];
  const values = {};
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (!value) throw new Error(`missing ${name}`);
    values[name] = value;
  }
  return values;
}

function parsePossibleJson(text) {
  const source = String(text || '').trim();
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch (_) {
    const firstBrace = source.indexOf('{');
    const lastBrace = source.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(source.slice(firstBrace, lastBrace + 1));
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

function findListWindowsProof(value, depth = 0, seen = new Set()) {
  if (depth > 12 || value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const parsed = parsePossibleJson(value);
    return parsed === null ? null : findListWindowsProof(parsed, depth + 1, seen);
  }
  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (value.schema === LIST_WINDOWS_SCHEMA
    && value.operation === 'list_windows'
    && value.ok === true
    && Number.isInteger(value.windowCount)
    && value.windowCount >= 0) {
    return value;
  }
  for (const nested of Object.values(value)) {
    const proof = findListWindowsProof(nested, depth + 1, seen);
    if (proof) return proof;
  }
  return null;
}

function toolSurfaceKind(toolResponse) {
  return toolResponse?._meta?.['codex/toolSurface']?.kind || null;
}

function buildRecord(payload, environment, expectedToolInputJson) {
  const actualToolInputJson = JSON.stringify(payload?.tool_input);
  const expectedInputSha256 = environment.SQUIDRUN_CUA_PROOF_TOOL_INPUT_SHA256;
  const actualInputSha256 = sha256(actualToolInputJson);
  const toolResponse = payload?.tool_response;
  const proof = findListWindowsProof(toolResponse);
  let reason = null;
  if (payload?.tool_name !== TOOL_NAME) {
    reason = 'unexpected_tool_name';
  } else if (actualToolInputJson !== expectedToolInputJson
    || actualInputSha256 !== expectedInputSha256) {
    reason = 'unexpected_node_repl_tool_input';
  } else if (toolResponse?.isError === true || toolResponse?.is_error === true) {
    reason = 'node_repl_tool_refused';
  } else if (toolSurfaceKind(toolResponse) !== 'computerUse') {
    reason = 'computer_use_tool_surface_missing';
  } else if (!proof) {
    reason = 'list_windows_result_missing';
  }
  return {
    schema: ATTESTATION_SCHEMA,
    claimId: environment.SQUIDRUN_CUA_PROOF_CLAIM_ID,
    paneId: environment.SQUIDRUN_CUA_PROOF_PANE_ID,
    projectRoot: environment.SQUIDRUN_CUA_PROOF_PROJECT_ROOT,
    generationDigest: environment.SQUIDRUN_CUA_PROOF_GENERATION_DIGEST,
    sessionId: String(payload?.session_id || ''),
    turnId: String(payload?.turn_id || ''),
    toolUseId: String(payload?.tool_use_id || ''),
    transcriptPath: String(payload?.transcript_path || ''),
    cwd: String(payload?.cwd || ''),
    toolName: String(payload?.tool_name || ''),
    toolInputSha256: actualInputSha256,
    officialClientPath: environment.SQUIDRUN_CUA_PROOF_CLIENT_PATH,
    officialClientSha256: environment.SQUIDRUN_CUA_PROOF_CLIENT_SHA256,
    integrityDigest: sha256(Buffer.from(
      environment.SQUIDRUN_CUA_PROOF_INTEGRITY_B64,
      'base64'
    ).toString('utf8')),
    hookAuditDigest: environment.SQUIDRUN_CUA_PROOF_HOOK_AUDIT_DIGEST,
    verdict: reason ? 'failed' : 'passed',
    reason,
    windowCount: proof?.windowCount ?? null,
    observedAt: new Date().toISOString(),
  };
}

function main() {
  const environment = requiredEnvironment();
  const expectedToolInputJson = Buffer.from(
    environment.SQUIDRUN_CUA_PROOF_TOOL_INPUT_B64,
    'base64'
  ).toString('utf8');
  if (sha256(expectedToolInputJson) !== environment.SQUIDRUN_CUA_PROOF_TOOL_INPUT_SHA256) {
    throw new Error('expected tool input binding is corrupt');
  }
  const chunks = [];
  let bytes = 0;
  process.stdin.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) {
      process.stderr.write('Computer Use proof hook input exceeded the size limit\n');
      process.exitCode = 2;
      process.stdin.destroy();
      return;
    }
    chunks.push(chunk);
  });
  process.stdin.on('end', () => {
    if (process.exitCode) return;
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const record = buildRecord(payload, environment, expectedToolInputJson);
      record.signature = hmac(
        environment.SQUIDRUN_CUA_PROOF_SECRET,
        canonicalJson(record)
      );
      fs.appendFileSync(
        environment.SQUIDRUN_CUA_PROOF_JOURNAL,
        `${JSON.stringify(record)}\n`,
        { encoding: 'utf8', mode: 0o600 }
      );
    } catch (error) {
      process.stderr.write(`Computer Use proof hook failed: ${error?.message || error}\n`);
      process.exitCode = 2;
    }
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`Computer Use proof hook failed: ${error?.message || error}\n`);
  process.exitCode = 2;
}
