#!/usr/bin/env node

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  appendBusTraceEvent,
  createPayloadFingerprint,
  resolveTracePath,
} = require('../modules/bus-reliability-trace');

const DEFAULT_SIZES = [3900, 4096, 4100, 7500];
const DEFAULT_TARGETS = ['architect', 'builder', 'oracle'];
const DEFAULT_HEAD_CHARS = 64;
const DEFAULT_TAIL_CHARS = 64;
const PROBE_PREFIX = '[HM-BUS-SENTINEL]';

function buildPayload(byteLen, probeId) {
  const header = `${PROBE_PREFIX} probe=${probeId} bytes=${byteLen}`;
  const tail = `END:${probeId}`;
  const fillerLen = byteLen - Buffer.byteLength(header, 'utf8') - Buffer.byteLength(tail, 'utf8') - 2;
  if (fillerLen < 0) {
    return `${header}\n${tail}`.slice(0, byteLen);
  }
  const filler = '.'.repeat(fillerLen);
  return `${header}\n${filler}\n${tail}`;
}

function parseArgs(argv) {
  const args = { sizes: null, targets: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--size' || arg === '--sizes') {
      const value = argv[i + 1] || '';
      args.sizes = value.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter(Number.isFinite);
      i += 1;
    } else if (arg === '--target' || arg === '--targets') {
      const value = argv[i + 1] || '';
      args.targets = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      i += 1;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    }
  }
  if (!args.sizes || args.sizes.length === 0) args.sizes = DEFAULT_SIZES;
  if (!args.targets || args.targets.length === 0) args.targets = DEFAULT_TARGETS;
  return args;
}

function buildProbeId(target, byteLen) {
  return `${target}-${byteLen}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function runHmSend(target, payloadFile) {
  const hmSend = path.resolve(__dirname, 'hm-send.js');
  const result = spawnSync(process.execPath, [hmSend, target, '--file', payloadFile, '--no-fallback'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function readTraceEntriesAfter(tracePath, sinceMs) {
  if (!fs.existsSync(tracePath)) return [];
  const raw = fs.readFileSync(tracePath, 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((entry) => {
      if (!entry?.ts) return true;
      const ts = Date.parse(entry.ts);
      return Number.isFinite(ts) && ts >= sinceMs;
    });
}

function summarizeTraceForProbe(entries, probeId) {
  const matched = entries.filter((entry) => {
    const text = JSON.stringify(entry).toLowerCase();
    return text.includes(String(probeId).toLowerCase());
  });
  const stages = new Set();
  for (const entry of matched) {
    if (entry?.stage) stages.add(entry.stage);
    if (entry?.event) stages.add(entry.event);
  }
  return {
    matchedCount: matched.length,
    stages: [...stages],
    fingerprints: matched
      .map((entry) => entry?.fingerprint)
      .filter(Boolean),
  };
}

async function runProbe(target, byteLen, options = {}) {
  const probeId = buildProbeId(target, byteLen);
  const payload = buildPayload(byteLen, probeId);
  const expectedFingerprint = createPayloadFingerprint(payload, {
    headChars: DEFAULT_HEAD_CHARS,
    tailChars: DEFAULT_TAIL_CHARS,
  });

  const tmpFile = path.join(require('os').tmpdir(), `hm-bus-sentinel-${probeId}.txt`);
  fs.writeFileSync(tmpFile, payload, 'utf8');

  appendBusTraceEvent({
    stage: 'sentinel.start',
    probeId,
    target,
    requestedBytes: byteLen,
    actualBytes: expectedFingerprint.byteLength,
    expectedFingerprint,
  });

  if (options.dryRun) {
    fs.unlinkSync(tmpFile);
    return {
      probeId,
      target,
      byteLen,
      dryRun: true,
      expectedFingerprint,
    };
  }

  const sinceMs = Date.now() - 1000;
  const sendResult = runHmSend(target, tmpFile);

  try {
    fs.unlinkSync(tmpFile);
  } catch {
    /* ignore */
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));

  const tracePath = resolveTracePath();
  const traceEntries = readTraceEntriesAfter(tracePath, sinceMs);
  const traceSummary = summarizeTraceForProbe(traceEntries, probeId);

  appendBusTraceEvent({
    stage: 'sentinel.end',
    probeId,
    target,
    sendStatus: sendResult.status,
    sendError: sendResult.error,
    traceMatchedCount: traceSummary.matchedCount,
    traceStages: traceSummary.stages,
  });

  const sendOk = sendResult.status === 0;

  return {
    probeId,
    target,
    byteLen,
    sendOk,
    sendError: sendResult.error,
    sendStdout: sendResult.stdout.trim().split('\n').slice(-3).join('\n'),
    expectedFingerprint,
    traceMatchedCount: traceSummary.matchedCount,
    traceStages: traceSummary.stages,
    traceFingerprints: traceSummary.fingerprints,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const results = [];
  for (const target of args.targets) {
    for (const size of args.sizes) {
      // eslint-disable-next-line no-await-in-loop
      const result = await runProbe(target, size, { dryRun: args.dryRun });
      results.push(result);
    }
  }

  const summary = {
    ok: results.every((r) => r.dryRun || r.sendOk),
    total: results.length,
    targets: args.targets,
    sizes: args.sizes,
    dryRun: args.dryRun,
    results,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.ok ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => {
    process.exit(code);
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(2);
  });
}

module.exports = {
  buildPayload,
  buildProbeId,
  parseArgs,
  runProbe,
  DEFAULT_SIZES,
  DEFAULT_TARGETS,
  PROBE_PREFIX,
};
