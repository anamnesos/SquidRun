const fs = require('fs');
const os = require('os');
const path = require('path');

const { CognitiveMemoryStore } = require('../modules/cognitive-memory-store');
const {
  appendBulletToSection,
  promoteRows,
  resolvePromotionTarget,
} = require('../scripts/hm-memory-promote');

describe('memory promotion helpers', () => {
  let tempDir;
  let workspaceDir;
  let knowledgeDir;
  let pendingPrPath;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-memory-promote-'));
    workspaceDir = path.join(tempDir, 'workspace');
    knowledgeDir = path.join(workspaceDir, 'knowledge');
    pendingPrPath = path.join(tempDir, '.squidrun', 'memory', 'pending-pr.json');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    fs.writeFileSync(path.join(knowledgeDir, 'user-context.md'), '# User Context\n\n## Observed Preferences\n\n');
    fs.writeFileSync(path.join(knowledgeDir, 'workflows.md'), '# Workflows\n\n');
    fs.writeFileSync(path.join(knowledgeDir, 'infrastructure.md'), '# Infrastructure\n\n');
    store = new CognitiveMemoryStore({
      workspaceDir,
      pendingPrPath,
      dbPath: path.join(workspaceDir, 'memory', 'cognitive-memory.db'),
    });
  });

  afterEach(() => {
    if (store) store.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('appendBulletToSection deduplicates repeated statements', () => {
    const target = path.join(knowledgeDir, 'user-context.md');
    const first = appendBulletToSection(target, '## Observed Preferences', 'the user prefers direct execution.');
    const second = appendBulletToSection(target, '## Observed Preferences', 'the user prefers direct execution.');

    expect(first.added).toBe(true);
    expect(second.alreadyPresent).toBe(true);
    const content = fs.readFileSync(target, 'utf8');
    expect(content.match(/the user prefers direct execution\./g)).toHaveLength(1);
  });

  test('promoteRows routes approved memory PRs into the expected knowledge files', () => {
    store.stageMemoryPRs([
      {
        category: 'preference',
        statement: 'the user prefers concise, action-oriented updates.',
        domain: 'user_preferences',
      },
      {
        category: 'system_state',
        statement: 'The durable supervisor owns the memory watcher loop.',
        domain: 'system_architecture',
      },
    ]);

    const pending = store.listPendingPRs({ limit: 10 });
    const touched = promoteRows(pending, workspaceDir);
    const review = store.reviewMemoryPRs({ ids: pending.map((row) => row.pr_id), status: 'promoted' });

    expect(review.ok).toBe(true);
    expect(store.listPendingPRs({ limit: 10 })).toHaveLength(0);
    expect(touched).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: path.join(knowledgeDir, 'user-context.md') }),
      expect.objectContaining({ filePath: path.join(knowledgeDir, 'infrastructure.md') }),
    ]));
    expect(fs.readFileSync(path.join(knowledgeDir, 'user-context.md'), 'utf8')).toContain('the user prefers concise, action-oriented updates.');
    expect(fs.readFileSync(path.join(knowledgeDir, 'infrastructure.md'), 'utf8')).toContain('The durable supervisor owns the memory watcher loop.');
  });

  test('resolvePromotionTarget falls back to memory-pr-promotions for unmapped facts', () => {
    const target = resolvePromotionTarget({ category: 'fact', domain: 'misc' }, workspaceDir);
    expect(target.filePath).toBe(path.join(knowledgeDir, 'memory-pr-promotions.md'));
    expect(target.heading).toBe('# Memory PR Promotions');
  });
});
