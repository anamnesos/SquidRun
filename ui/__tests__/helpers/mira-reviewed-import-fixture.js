'use strict';

const fs = require('fs');
const path = require('path');

function repoRelativePath(repoRoot, targetPath) {
  return path.relative(repoRoot, targetPath).split(path.sep).join('/');
}

function fixturePayloadFor(record) {
  if (record.source_kind === 'transcript_evidence') {
    return JSON.stringify({ id: record.id, source_kind: record.source_kind, text: 'fixture transcript' }) + '\n';
  }

  if (record.source_kind === 'acceptance_doc') {
    return `# ${record.id}\n\nFixture acceptance document for Mira import tests.\n`;
  }

  return `${JSON.stringify({ id: record.id, source_kind: record.source_kind, fixture: true })}\n`;
}

function createReviewedImportFixture({ repoRoot }) {
  const templateQueuePath = path.join(repoRoot, 'mira', 'imports', 'review-queue.json');
  const templateContractPath = path.join(repoRoot, 'mira', 'state', 'state-root-contract.json');
  const tempRoot = fs.mkdtempSync(path.join(repoRoot, 'mira', '.tmp-reviewed-import-'));
  const sourceRoot = path.join(tempRoot, 'sources');
  const queuePath = path.join(tempRoot, 'review-queue.json');
  const contractPath = path.join(tempRoot, 'state-root-contract.json');
  const stateRoot = path.join(tempRoot, 'state-root');
  const queue = JSON.parse(fs.readFileSync(templateQueuePath, 'utf8'));
  const records = queue.records.map((record, index) => {
    const extension = path.extname(record.source_path || '') || '.txt';
    const sourcePath = path.join(sourceRoot, `${String(index + 1).padStart(2, '0')}-${record.id}${extension}`);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, fixturePayloadFor(record), 'utf8');
    return {
      ...record,
      source_path: repoRelativePath(repoRoot, sourcePath),
    };
  });
  const fixtureQueue = {
    ...queue,
    records,
  };

  fs.writeFileSync(queuePath, JSON.stringify(fixtureQueue, null, 2) + '\n', 'utf8');
  fs.writeFileSync(contractPath, fs.readFileSync(templateContractPath, 'utf8'), 'utf8');

  return {
    contractPath,
    cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
    queue: fixtureQueue,
    queuePath,
    stateRoot,
    tempRoot,
  };
}

module.exports = {
  createReviewedImportFixture,
};
