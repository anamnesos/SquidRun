'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const queuePath = path.join(repoRoot, 'mira', 'imports', 'review-queue.json');
const contractPath = path.join(repoRoot, 'mira', 'state', 'state-root-contract.json');

const allowedStatuses = new Set(['not_imported', 'reviewed_ready', 'imported', 'rejected']);
const allowedKinds = new Set([
  'profile_state',
  'relationship_state',
  'permission_state',
  'growth_history',
  'growth_audit',
  'acceptance_doc',
  'transcript_evidence',
]);

function normalizeSlashes(value) {
  return value.replace(/\\/g, '/');
}

function isForbiddenDestination(destination, forbiddenDestinations) {
  const normalized = normalizeSlashes(destination).replace(/^\/+/, '');

  if (normalized.startsWith('../') || path.isAbsolute(destination)) {
    return true;
  }

  return forbiddenDestinations.some((pattern) => {
    const cleanPattern = normalizeSlashes(pattern).replace(/\/\*\*$/, '');
    return normalized === cleanPattern || normalized.startsWith(`${cleanPattern}/`);
  });
}

function validateImportQueue(options = {}) {
  const queue = JSON.parse(fs.readFileSync(options.queuePath || queuePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(options.contractPath || contractPath, 'utf8'));
  const errors = [];
  const seenIds = new Set();

  if (queue.schema !== 'mira.import_queue.v1') {
    errors.push('queue schema must be mira.import_queue.v1');
  }

  if (!Array.isArray(queue.records)) {
    errors.push('queue records must be an array');
    return { ok: false, errors };
  }

  for (const record of queue.records) {
    if (!record || typeof record !== 'object') {
      errors.push('record must be an object');
      continue;
    }

    if (!record.id || seenIds.has(record.id)) {
      errors.push(`record has missing or duplicate id: ${record.id || '<missing>'}`);
    }
    seenIds.add(record.id);

    if (!allowedKinds.has(record.source_kind)) {
      errors.push(`${record.id}: invalid source_kind ${record.source_kind}`);
    }

    if (!allowedStatuses.has(record.status)) {
      errors.push(`${record.id}: invalid status ${record.status}`);
    }

    if (record.status !== 'not_imported') {
      errors.push(`${record.id}: first-pass queue entries must remain not_imported`);
    }

    const sourcePath = path.join(repoRoot, record.source_path || '');
    if (!record.source_path || !fs.existsSync(sourcePath)) {
      errors.push(`${record.id}: source_path missing on disk: ${record.source_path}`);
    }

    if (!record.destination || isForbiddenDestination(record.destination, contract.forbidden_destinations || [])) {
      errors.push(`${record.id}: forbidden or missing destination: ${record.destination}`);
    }

    if (!record.selection_policy) {
      errors.push(`${record.id}: selection_policy is required`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    count: queue.records.length,
  };
}

if (require.main === module) {
  const result = validateImportQueue();
  if (!result.ok) {
    console.error(result.errors.join('\n'));
    process.exit(1);
  }
  console.log(`Mira import queue valid (${result.count} records, no live data copied).`);
}

module.exports = {
  isForbiddenDestination,
  validateImportQueue,
};
