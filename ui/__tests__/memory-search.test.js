const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseMarkdownTable,
  buildSessionHandoffSources,
  buildEvidenceSources,
  chunkText,
  createExcerpt,
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
  let caseEvidenceDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-memory-search-'));
    workspaceDir = path.join(tempDir, 'workspace');
    caseEvidenceDir = path.join(tempDir, 'cases', 'Example Case', 'evidence');
    fs.mkdirSync(path.join(workspaceDir, 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.squidrun', 'handoffs'), { recursive: true });
    fs.mkdirSync(caseEvidenceDir, { recursive: true });

    fs.writeFileSync(path.join(workspaceDir, 'knowledge', 'user-context.md'), [
      '# User Context',
      '',
      '## Plumbing',
      '',
      'The user runs an operations workflow and wants practical automation.',
      '',
      '## Messaging',
      '',
      'Telegram notifications should stay readable and short.',
      '',
    ].join('\n'));

    fs.writeFileSync(path.join(tempDir, '.squidrun', 'handoffs', 'session.md'), [
      '# Session Handoff Index',
      '',
      '## Decision Digest',
      '| session_id | latest_at | decisions | findings | highlights |',
      '| --- | --- | --- | --- | --- |',
      '| app-session-170 | 2026-02-21T22:32:39.337Z | Add shutdown button | Menu cleanup | The user prefers one clear shutdown path |',
      '',
      '## Cross-Session Decisions',
      '| sent_at | session_id | tag | message_id | trace_id | sender | target | detail |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      '| 2026-02-21T22:32:39.337Z | app-session-159 | TASK | hm-123 | trace-123 | cli | builder | Landing page polish and brand integration |',
      '',
    ].join('\n'));

    fs.writeFileSync(path.join(caseEvidenceDir, 'statement.txt'), [
      'Scoped shared the evidence packet and shipping label timeline.',
      'The investigator needs the payment trail tied to the alias account.',
    ].join('\n'));
    fs.writeFileSync(path.join(caseEvidenceDir, 'shipping-label.png'), 'fake-binary');
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
      handoffPath: path.join(tempDir, '.squidrun', 'handoffs', 'session.md'),
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

  test('builds case evidence sources for text files and binary metadata', () => {
    const sources = buildEvidenceSources({
      projectRoot: tempDir,
      workspaceDir,
      caseEvidenceDirs: [caseEvidenceDir],
    }, {
      maxChars: 2200,
      overlapChars: 250,
    });

    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: 'case_evidence',
        sourcePath: 'cases/Example Case/evidence/statement.txt',
      }),
      expect.objectContaining({
        sourceType: 'case_evidence_asset',
        sourcePath: 'cases/Example Case/evidence/shipping-label.png',
      }),
    ]));
  });

  test('indexes workspace sources and returns hybrid search results', async () => {
    const index = new MemorySearchIndex({
      projectRoot: tempDir,
      workspaceDir,
      caseEvidenceDirs: [caseEvidenceDir],
      embedder: mockEmbedder,
    });

    try {
      const indexResult = await index.indexAll({ force: true });
      expect(indexResult.ok).toBe(true);
      expect(indexResult.indexedGroups).toBeGreaterThanOrEqual(2);
      expect(indexResult.status.document_count).toBeGreaterThan(0);

      const searchResult = await index.search('operations workflow automation', { limit: 3 });
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

      const evidenceSearch = await index.search('evidence packet alias account', { limit: 3 });
      expect(evidenceSearch.results).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sourceType: 'case_evidence',
          sourcePath: 'cases/Example Case/evidence/statement.txt',
        }),
      ]));

      const assetSearch = await index.search('shipping-label png', { limit: 3 });
      expect(assetSearch.results).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sourceType: 'case_evidence_asset',
          sourcePath: 'cases/Example Case/evidence/shipping-label.png',
        }),
      ]));
    } finally {
      index.close();
    }
  });

  test('creates overlapping chunks without splitting keyword phrases across boundaries', () => {
    const prefix = 'intro '.repeat(160);
    const keywordPhrase = 'durable supervisor lease cleanup';
    const suffix = 'outro '.repeat(160);
    const chunks = chunkText(`${prefix}${keywordPhrase} ${suffix}`, {
      maxChars: 220,
      overlapChars: 60,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((chunk) => chunk.includes(keywordPhrase))).toBe(true);
  });

  test('anchors excerpts to the densest literal token cluster inside a chunk', () => {
    const content = [
      '# Workflows',
      '',
      '- Bridge self-replacement flap fix pattern: treat CLOSING as in-flight.',
      '- PTY long-message truncation hardening: chunk payloads >=1KB and pace writes.',
      '- CI monitoring keeps regressions visible.',
      '- Deep research workflow: compare newer releases before claiming a bug is fixed.',
    ].join('\n');

    const excerpt = createExcerpt(content, 'truncation fix', 170).toLowerCase();

    expect(excerpt).toContain('truncation hardening');
    expect(excerpt).toContain('fix pattern');
    expect(excerpt).not.toContain('deep research workflow');
  });

  test('prefers the chunk with literal query terms and anchors excerpt to the matched phrase', async () => {
    const longPrefix = 'semantic neighbor '.repeat(220);
    const literalChunk = [
      'This section explains how to prevent supervisor lease cleanup races.',
      'The durable supervisor lease cleanup path should reclaim expired workers safely.',
      'Pending queue items also need a TTL so stale work does not linger forever.',
    ].join(' ');

    fs.writeFileSync(path.join(workspaceDir, 'knowledge', 'supervisor.md'), [
      '# Supervisor Notes',
      '',
      '## Overview',
      '',
      `${longPrefix}${literalChunk}`,
      '',
    ].join('\n'));

    const index = new MemorySearchIndex({
      workspaceDir,
      embedder: mockEmbedder,
      chunkChars: 260,
      chunkOverlapChars: 80,
    });

    try {
      await index.indexAll({ force: true });
      const result = await index.search('durable supervisor lease cleanup', { limit: 3 });
      expect(result.ok).toBe(true);
      expect(result.results[0]).toEqual(expect.objectContaining({
        sourcePath: 'knowledge/supervisor.md',
      }));
      expect(result.results[0].excerpt.toLowerCase()).toContain('durable supervisor lease cleanup');
      expect(result.results[0].matchSignals.matchedTokenCount).toBeGreaterThan(0);
    } finally {
      index.close();
    }
  });

  test('search downranks stale documents when freshness is the main differentiator', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'knowledge', 'legacy-memory.md'), [
      '# Legacy Memory',
      '',
      'The durable route planner checksum keeps builder dispatches aligned.',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(workspaceDir, 'knowledge', 'current-memory.md'), [
      '# Current Memory',
      '',
      'The durable route planner checksum keeps builder dispatches aligned.',
      '',
    ].join('\n'));

    const index = new MemorySearchIndex({
      workspaceDir,
      embedder: mockEmbedder,
    });

    try {
      await index.indexAll({ force: true });
      const db = index.init();
      const docs = db.prepare(`
        SELECT document_id, source_path
        FROM memory_documents
        WHERE source_path IN (?, ?)
        ORDER BY document_id ASC
      `).all('knowledge/legacy-memory.md', 'knowledge/current-memory.md');

      expect(docs).toHaveLength(2);

      const staleDoc = docs.find((doc) => doc.source_path === 'knowledge/legacy-memory.md');
      const freshDoc = docs.find((doc) => doc.source_path === 'knowledge/current-memory.md');
      const staleMs = Date.now() - (180 * 24 * 60 * 60 * 1000);
      const freshMs = Date.now();

      db.prepare(`
        UPDATE memory_documents
        SET last_modified_ms = ?,
            created_at_ms = ?,
            updated_at_ms = ?
        WHERE document_id = ?
      `).run(staleMs, staleMs, staleMs, staleDoc.document_id);
      db.prepare(`
        UPDATE memory_documents
        SET last_modified_ms = ?,
            created_at_ms = ?,
            updated_at_ms = ?
        WHERE document_id = ?
      `).run(freshMs, freshMs, freshMs, freshDoc.document_id);

      const result = await index.search('durable route planner checksum', { limit: 6 });
      const ranked = result.results.filter((entry) => (
        entry.sourcePath === 'knowledge/legacy-memory.md'
        || entry.sourcePath === 'knowledge/current-memory.md'
      ));

      expect(ranked).toHaveLength(2);
      expect(ranked[0].sourcePath).toBe('knowledge/current-memory.md');
      expect(ranked[1].sourcePath).toBe('knowledge/legacy-memory.md');
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    } finally {
      index.close();
    }
  });

  test('updateDocument refreshes stored content and searchability without a rebuild', async () => {
    const index = new MemorySearchIndex({
      workspaceDir,
      embedder: mockEmbedder,
    });

    try {
      await index.indexAll({ force: true });
      const original = await index.search('operations workflow automation', { limit: 3 });
      const document = original.results.find((entry) => entry.sourcePath === 'knowledge/user-context.md');
      expect(document).toBeTruthy();

      const updated = await index.updateDocument(document.documentId, {
        content: 'The user now wants concise dispatch automation with milestone checkpoints.',
        metadata: { syncedFrom: 'test' },
        nowMs: 5000,
      });

      expect(updated).toEqual(expect.objectContaining({
        ok: true,
        document: expect.objectContaining({
          document_id: document.documentId,
          content: expect.stringContaining('milestone checkpoints'),
        }),
      }));

      const refreshed = await index.search('milestone checkpoints', { limit: 3 });
      expect(refreshed.results).toEqual(expect.arrayContaining([
        expect.objectContaining({
          documentId: document.documentId,
          content: expect.stringContaining('milestone checkpoints'),
        }),
      ]));
    } finally {
      index.close();
    }
  });
});
