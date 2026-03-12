const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseMarkdownTable,
  buildSessionHandoffSources,
  MemorySearchIndex,
} = require('../modules/memory-search');

function makeVectorForText(text) {
  const vector = new Array(384).fill(0);
  const normalized = String(text || '').toLowerCase();
  const tokens = normalized.match(/[a-z0-9_]+/g) || [];
  for (const token of tokens) {
    const slot = token.includes('plumb') ? 0
      : token.includes('telegram') ? 1
      : token.includes('memory') ? 2
      : token.includes('decision') ? 3
      : 4;
    vector[slot] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0)) || 1;
  return vector.map((value) => value / norm);
}

const mockEmbedder = {
  model: 'mock-mini',
  dim: 384,
  async embed(text) {
    return makeVectorForText(text);
  },
};

const maybeDescribe = (() => {
  try {
    require('node:sqlite');
    require('sqlite-vec');
    return describe;
  } catch {
    return describe.skip;
  }
})();

maybeDescribe('memory-search', () => {
  let tempDir;
  let workspaceDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-memory-search-'));
    workspaceDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(path.join(workspaceDir, 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'handoffs'), { recursive: true });

    fs.writeFileSync(path.join(workspaceDir, 'knowledge', 'user-context.md'), [
      '# User Context',
      '',
      '## Plumbing',
      '',
      'James runs a plumbing business and wants practical automation.',
      '',
      '## Messaging',
      '',
      'Telegram notifications should stay readable and short.',
      '',
    ].join('\n'));

    fs.writeFileSync(path.join(workspaceDir, 'handoffs', 'session.md'), [
      '# Session Handoff Index',
      '',
      '## Decision Digest',
      '| session_id | latest_at | decisions | findings | highlights |',
      '| --- | --- | --- | --- | --- |',
      '| app-session-170 | 2026-02-21T22:32:39.337Z | Add shutdown button | Menu cleanup | James prefers one clear shutdown path |',
      '',
      '## Cross-Session Decisions',
      '| sent_at | session_id | tag | message_id | trace_id | sender | target | detail |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      '| 2026-02-21T22:32:39.337Z | app-session-159 | TASK | hm-123 | trace-123 | cli | builder | Landing page polish and brand integration |',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('parses markdown tables into row objects', () => {
    const rows = parseMarkdownTable([
      '| a | b |',
      '| --- | --- |',
      '| one | two |',
    ].join('\n'));

    expect(rows).toEqual([{ a: 'one', b: 'two' }]);
  });

  test('extracts decision digest and cross-session sources from handoff markdown', () => {
    const sources = buildSessionHandoffSources({
      workspaceDir,
      handoffPath: path.join(workspaceDir, 'handoffs', 'session.md'),
    });

    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: 'decision_digest',
        title: 'Decision Digest',
      }),
      expect.objectContaining({
        sourceType: 'cross_session_decision',
        title: 'Cross-Session Decisions',
      }),
    ]));
  });

  test('indexes workspace sources and returns hybrid search results', async () => {
    const index = new MemorySearchIndex({
      workspaceDir,
      embedder: mockEmbedder,
    });

    try {
      const indexResult = await index.indexAll({ force: true });
      expect(indexResult.ok).toBe(true);
      expect(indexResult.indexedGroups).toBeGreaterThanOrEqual(2);
      expect(indexResult.status.document_count).toBeGreaterThan(0);

      const searchResult = await index.search('plumbing business automation', { limit: 3 });
      expect(searchResult.ok).toBe(true);
      expect(searchResult.results).toHaveLength(3);
      expect(searchResult.results[0]).toEqual(expect.objectContaining({
        sourceType: 'knowledge',
        sourcePath: 'knowledge/user-context.md',
      }));

      const decisionSearch = await index.search('shutdown button clear path', { limit: 2 });
      expect(decisionSearch.results[0]).toEqual(expect.objectContaining({
        sourceType: 'decision_digest',
      }));
    } finally {
      index.close();
    }
  });
});
