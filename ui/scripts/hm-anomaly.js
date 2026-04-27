#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCoordPath } = require('../config');

const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'hard']);
const DEFAULT_ANOMALY_PATH = resolveCoordPath('coord/anomalies.jsonl', { forWrite: true });

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    type: null,
    src: process.env.SQUIDRUN_ROLE || 'unknown',
    severity: 'medium',
    details: {},
    sessionId: null,
    json: false,
    filePath: DEFAULT_ANOMALY_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token) continue;
    if (token === '--json') {
      args.json = true;
      continue;
    }
    if (token === '--path' && argv[index + 1]) {
      args.filePath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (!token.includes('=') && !args.type) {
      args.type = token;
      continue;
    }

    const equalsIndex = token.indexOf('=');
    if (equalsIndex === -1) continue;
    const key = token.slice(0, equalsIndex).trim();
    const value = token.slice(equalsIndex + 1).trim();
    if (key === 'type') args.type = value;
    else if (key === 'src') args.src = value;
    else if (key === 'sev' || key === 'severity') args.severity = value;
    else if (key === 'sessionId') args.sessionId = Number.parseInt(value, 10);
    else if (key === 'details') args.details = parseDetails(value);
    else args.details[key] = value;
  }

  return args;
}

function parseDetails(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : { value: parsed };
  } catch (_) {
    return { note: value };
  }
}

function normalizeSeverity(value) {
  const severity = String(value || '').trim().toLowerCase();
  return VALID_SEVERITIES.has(severity) ? severity : 'medium';
}

function buildAnomaly(options = {}) {
  const type = String(options.type || '').trim();
  if (!type) {
    throw new Error('Anomaly type is required. Usage: node ui/scripts/hm-anomaly.js type=message_clipped src=oracle sev=medium details="{...}"');
  }

  const payload = {
    ts: new Date().toISOString(),
    src: String(options.src || process.env.SQUIDRUN_ROLE || 'unknown').trim() || 'unknown',
    type,
    severity: normalizeSeverity(options.severity),
    details: options.details && typeof options.details === 'object' ? options.details : {},
  };

  const sessionId = Number(options.sessionId);
  if (Number.isInteger(sessionId) && sessionId >= 0) {
    payload.sessionId = sessionId;
  }

  return payload;
}

function appendJsonLine(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const anomaly = buildAnomaly(args);
  appendJsonLine(args.filePath, anomaly);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, path: args.filePath, anomaly }, null, 2)}\n`);
  } else {
    console.log(`Anomaly recorded: ${anomaly.type} (${anomaly.severity}) -> ${args.filePath}`);
  }
  return { ok: true, path: args.filePath, anomaly };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('Error:', error?.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_ANOMALY_PATH,
  parseArgs,
  buildAnomaly,
  appendJsonLine,
  main,
};
