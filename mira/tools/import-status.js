'use strict';

const fs = require('fs');
const path = require('path');
const { resolveStateRoot } = require('./resolve-state-root');

function readReceipt(filePath) {
  const receipt = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    receipt_id: receipt.receipt_id || path.basename(filePath, '.json'),
    batch_id: receipt.batch_id || null,
    report_id: receipt.report_id || null,
    copied_at: receipt.copied_at || null,
    record_count: Array.isArray(receipt.records) ? receipt.records.length : 0,
    mutation_flags: receipt.mutation_flags || {},
    path: filePath,
  };
}

function getImportStatus(options = {}) {
  const root = resolveStateRoot(options.env || process.env);
  if (!root.ok) {
    return {
      ok: false,
      error: root.error,
      state_root: null,
      receipts_dir: null,
      receipt_count: 0,
      record_count: 0,
      receipts: [],
      continuity_loaded: false,
    };
  }

  const receiptsDir = path.join(root.path, 'imports', 'receipts');
  if (!fs.existsSync(receiptsDir)) {
    return {
      ok: true,
      state_root: root.path,
      receipts_dir: receiptsDir,
      receipt_count: 0,
      record_count: 0,
      receipts: [],
      continuity_loaded: false,
    };
  }

  const receipts = fs.readdirSync(receiptsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readReceipt(path.join(receiptsDir, name)));

  return {
    ok: true,
    state_root: root.path,
    receipts_dir: receiptsDir,
    receipt_count: receipts.length,
    record_count: receipts.reduce((sum, receipt) => sum + receipt.record_count, 0),
    receipts,
    continuity_loaded: false,
  };
}

function formatImportStatus(status) {
  if (!status.ok) {
    return `Mira import status unavailable: ${status.error}`;
  }

  return [
    'Mira import status',
    `state_root=${status.state_root}`,
    `receipt_count=${status.receipt_count}`,
    `record_count=${status.record_count}`,
    'continuity_loaded=false',
  ].join('\n');
}

if (require.main === module) {
  const json = process.argv.includes('--json');
  const status = getImportStatus();

  if (json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(formatImportStatus(status));
  }

  if (!status.ok) {
    process.exit(1);
  }
}

module.exports = {
  formatImportStatus,
  getImportStatus,
  readReceipt,
};
