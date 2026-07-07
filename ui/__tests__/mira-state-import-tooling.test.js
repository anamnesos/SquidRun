'use strict';

const fs = require('fs');
const path = require('path');

describe('Mira state/import tooling', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const { isForbiddenDestination, validateImportQueue } = require('../../mira/tools/validate-import-queue');
  const { resolveStateRoot } = require('../../mira/tools/resolve-state-root');
  const { createReviewedImportFixture } = require('./helpers/mira-reviewed-import-fixture');
  let cleanupFixtures = [];

  afterEach(() => {
    for (const cleanup of cleanupFixtures.splice(0)) {
      cleanup();
    }
  });

  test('keeps all first-pass imports explicit and not imported', () => {
    const fixture = createReviewedImportFixture({ repoRoot });
    cleanupFixtures.push(fixture.cleanup);
    const queuePath = fixture.queuePath;
    const contractPath = fixture.contractPath;
    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    const result = validateImportQueue({ queuePath, contractPath });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      count: queue.records.length,
    }));
    expect(queue.records.length).toBeGreaterThanOrEqual(10);
    expect(queue.records.every((record) => record.status === 'not_imported')).toBe(true);
    expect(queue.records.every((record) => record.destination && !record.destination.includes('.squidrun'))).toBe(true);
  });

  test('rejects SquidRun-owned or escaping destinations', () => {
    const forbidden = ['.squidrun', '.squidrun/**', 'workspace/memory', 'workspace/memory/**'];

    expect(isForbiddenDestination('.squidrun/mira.json', forbidden)).toBe(true);
    expect(isForbiddenDestination('workspace/memory/mira.json', forbidden)).toBe(true);
    expect(isForbiddenDestination('../workspace/memory/mira.json', forbidden)).toBe(true);
    expect(isForbiddenDestination('continuity/mira-self-profile.json', forbidden)).toBe(false);
  });

  test('requires an explicit Mira state root outside .squidrun', () => {
    expect(resolveStateRoot({})).toEqual(expect.objectContaining({
      ok: false,
    }));
    expect(resolveStateRoot({ MIRA_STATE_ROOT: path.join(repoRoot, '.squidrun', 'mira') })).toEqual(expect.objectContaining({
      ok: false,
    }));
    expect(resolveStateRoot({ MIRA_STATE_ROOT: path.join(repoRoot, 'mira', '.state-dev') })).toEqual(expect.objectContaining({
      ok: true,
    }));
  });
});
