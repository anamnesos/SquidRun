#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  buildBeliefSnapshotCandidate,
  planBeliefSnapshotPrune,
} = require('../modules/belief-snapshot-prune');

function usage(stream = process.stdout) {
  stream.write([
    'Usage:',
    '  node ui/scripts/hm-belief-snapshot-prune.js plan --source <team-memory.sqlite>',
    '  node ui/scripts/hm-belief-snapshot-prune.js build --source <team-memory.sqlite> --output <candidate.sqlite> [--receipt <proof.json>]',
    '',
    'plan is read-only. build creates and verifies a NEW candidate file only.',
    'This command never replaces, swaps, or deletes the source database.',
    '',
  ].join('\n'));
}

function parseOptions(args, command) {
  const allowed = command === 'plan'
    ? new Set(['--source'])
    : new Set(['--source', '--output', '--receipt']);
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name)) return { error: `unknown_option:${name}` };
    if (!value || value.startsWith('--')) return { error: `missing_option_value:${name}` };
    if (Object.hasOwn(values, name)) return { error: `duplicate_option:${name}` };
    values[name] = value;
  }
  return { values };
}

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertFreshReceiptPath(receiptPath) {
  const resolved = path.resolve(receiptPath);
  if (lstatOrNull(resolved)) throw new Error(`receipt_already_exists:${resolved}`);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) throw new Error(`receipt_parent_missing:${parent}`);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`receipt_parent_not_regular:${parent}`);
  }
  if (path.resolve(fs.realpathSync(parent)).toLowerCase() !== path.resolve(parent).toLowerCase()) {
    throw new Error(`receipt_parent_is_reparse_path:${parent}`);
  }
  return resolved;
}

function writeReceipt(receiptPath, result) {
  const resolved = assertFreshReceiptPath(receiptPath);
  fs.writeFileSync(resolved, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return resolved;
}

function usageError(message) {
  process.stderr.write(`[belief-snapshot-prune] ${message}\n`);
  usage(process.stderr);
  process.exitCode = 2;
}

function normalizedPath(value) {
  return path.resolve(String(value)).replace(/\\/g, '/').toLowerCase();
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }
  const command = args[0];
  if (!['plan', 'build'].includes(command)) return usageError(`unknown_command:${command || ''}`);
  const parsed = parseOptions(args, command);
  if (parsed.error) return usageError(parsed.error);
  const sourcePath = parsed.values['--source'];
  if (!sourcePath) return usageError('missing_required_option:--source');
  let result;
  if (command === 'plan') {
    result = planBeliefSnapshotPrune({ sourcePath });
  } else {
    const outputPath = parsed.values['--output'];
    if (!outputPath) return usageError('missing_required_option:--output');
    const receiptPath = parsed.values['--receipt'];
    if (receiptPath && normalizedPath(receiptPath) === normalizedPath(outputPath)) {
      return usageError('receipt_must_differ_from_candidate');
    }
    if (receiptPath) assertFreshReceiptPath(receiptPath);
    result = buildBeliefSnapshotCandidate({ sourcePath, outputPath });
    if (receiptPath) result.receiptPath = writeReceipt(receiptPath, result);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`[belief-snapshot-prune] ${error.stack || error.message}\n`);
  process.exitCode = 1;
}
