const fs = require('fs');
const os = require('os');
const path = require('path');

const { CognitiveMemoryStore } = require('../modules/cognitive-memory-store');
const { MemorySearchIndex } = require('../modules/memory-search');
const { CognitiveMemoryApi } = require('../modules/cognitive-memory-api');

function makeVectorForText(text) {
  const vector = new Array(384).fill(0);
  const normalized = String(text || '').toLowerCase();
  const tokens = normalized.match(/[a-z0-9_]+/g) || [];
  for (const token of tokens) {
    const slot = token.includes('servicetitan') || token.includes('service') || token.includes('auth') ? 0
      : token.includes('supervisor') || token.includes('queue') ? 1
      : token.includes('plumb') ? 2
      : token.includes('memory') ? 3
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

maybeDescribe('cognitive-memory api', () => {
  let tempDir;
  let workspaceDir;
  let store;
  let index;
  let api;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-cogmem-api-'));
    workspaceDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(path.join(workspaceDir, 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'handoffs'), { recursive: true });

    fs.writeFileSync(path.join(workspaceDir, 'knowledge', 'infrastructure.md'), [
      '# Infrastructure',
      '',
      '## ServiceTitan',
      '',
      'ServiceTitan API auth endpoint currently uses /v1/token for internal tooling.',
      '',
      '## Supervisor',
      '',
      'The supervisor queue keeps long-running automation durable for the user.',
      '',
    ].join('\n'));

    fs.writeFileSync(path.join(workspaceDir, 'knowledge', 'user-context.md'), [
      '# User Context',
      '',
      '## Active Focus Areas',
      '',
      'the user runs a plumbing business and wants automation he can trust.',
      '',
    ].join('\n'));

    fs.writeFileSync(path.join(workspaceDir, 'handoffs', 'session.md'), '# Session Handoff Index\n');

    store = new CognitiveMemoryStore({
      workspaceDir,
      dbPath: path.join(workspaceDir, 'memory', 'cognitive-memory.db'),
      pendingPrPath: path.join(tempDir, '.squidrun', 'memory', 'pending-pr.json'),
    });
    index = new MemorySearchIndex({ workspaceDir, embedder: mockEmbedder });
    await index.indexAll({ force: true });
    api = new CognitiveMemoryApi({ cognitiveStore: store, memorySearchIndex: index });
  });

  afterEach(() => {
    try { api?.close(); } catch {}
    try { store?.close(); } catch {}
    try { index?.close(); } catch {}
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('retrieve returns lease-backed results and records access', async () => {
    store.recordTransactiveUse({
      domain: 'service titan api',
      agent_id: 'builder',
      pane_id: '2',
      expertise_delta: 0.3,
    });

    const result = await api.retrieve('ServiceTitan auth endpoint', {
      agentId: 'builder',
      limit: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.seededNodeCount).toBeGreaterThan(0);
    expect(result.results[0]).toEqual(expect.objectContaining({
      leaseId: expect.stringMatching(/^lease-/),
      sourcePath: 'knowledge/infrastructure.md',
    }));
    expect(result.transactive).toEqual(expect.objectContaining({
      ok: true,
      recommendedAgentId: 'builder',
    }));
    expect(result.transactive.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        domain: 'service titan api',
        primaryAgentId: 'builder',
      }),
    ]));

    const node = api.getNode(result.results[0].nodeId);
    expect(node).toEqual(expect.objectContaining({
      accessCount: 1,
      currentVersion: 1,
    }));

    const leaseRow = api.init().prepare('SELECT * FROM memory_leases WHERE lease_id = ?').get(result.results[0].leaseId);
    expect(leaseRow).toEqual(expect.objectContaining({
      node_id: result.results[0].nodeId,
      agent_id: 'builder',
      version_at_lease: 1,
    }));
  });

  test('retrieve returns empty transactive guidance when no expertise matches the query', async () => {
    store.recordTransactiveUse({
      domain: 'relay orchestration',
      agent_id: 'oracle',
      pane_id: '3',
      expertise_delta: 0.25,
    });

    const result = await api.retrieve('plumbing customer context', {
      agentId: 'builder',
      limit: 1,
    });

    expect(result.transactive).toEqual({
      ok: true,
      matches: [],
      recommendedAgentId: null,
    });
  });

  test('ingest creates a node through the first-class runtime API method', async () => {
    const result = await api.ingest({
      content: 'Builder verified that ServiceTitan auth now uses /v2/token.',
      category: 'fact',
      agentId: 'builder',
      sourceType: 'agent-ingest',
      sourcePath: 'agent:builder',
      heading: 'ServiceTitan',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      node: expect.objectContaining({
        nodeId: expect.stringMatching(/^node-/),
        sourcePath: 'agent:builder',
        heading: 'ServiceTitan',
      }),
    }));
    expect(result.node.content).toContain('/v2/token');
  });

  test('searchExistingNodes downranks stale nodes even when they carry more salience', async () => {
    const stale = await api.ingest({
      content: 'ServiceTitan auth endpoint builder token refresh guidance.',
      category: 'fact',
      agentId: 'builder',
      sourceType: 'agent-ingest',
      sourcePath: 'agent:builder:stale',
      heading: 'ServiceTitan',
    });
    const fresh = await api.ingest({
      content: 'ServiceTitan auth endpoint builder token refresh guidance.',
      category: 'fact',
      agentId: 'builder',
      sourceType: 'agent-ingest',
      sourcePath: 'agent:builder:fresh',
      heading: 'ServiceTitan',
    });

    const staleMs = Date.now() - (180 * 24 * 60 * 60 * 1000);
    const freshMs = Date.now();
    api.init().prepare(`
      UPDATE nodes
      SET salience_score = ?,
          confidence_score = ?,
          created_at_ms = ?,
          updated_at_ms = ?
      WHERE node_id = ?
    `).run(5, 0.9, staleMs, staleMs, stale.node.nodeId);
    api.init().prepare(`
      UPDATE nodes
      SET salience_score = ?,
          confidence_score = ?,
          created_at_ms = ?,
          updated_at_ms = ?
      WHERE node_id = ?
    `).run(0, 0.5, freshMs, freshMs, fresh.node.nodeId);

    const queryVector = await api.embedText('ServiceTitan auth endpoint builder token refresh guidance');
    const ranked = api.searchExistingNodes(queryVector, 12)
      .filter((entry) => entry.node.nodeId === stale.node.nodeId || entry.node.nodeId === fresh.node.nodeId);

    expect(ranked).toHaveLength(2);
    expect(ranked[0].node.nodeId).toBe(fresh.node.nodeId);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  test('patch enforces OCC and increments version after reconsolidation', async () => {
    const first = await api.retrieve('ServiceTitan auth endpoint', { agentId: 'builder', limit: 1 });
    const second = await api.retrieve('ServiceTitan auth endpoint', { agentId: 'oracle', limit: 1 });

    const patched = await api.patch(
      first.results[0].leaseId,
      'ServiceTitan API auth endpoint is now /v2/token instead of /v1/token.',
      { agentId: 'builder', reason: 'verified against live auth failure' }
    );

    expect(patched.ok).toBe(true);
    expect(patched.node).toEqual(expect.objectContaining({
      currentVersion: 2,
      content: 'ServiceTitan API auth endpoint is now /v2/token instead of /v1/token.',
    }));
    expect(patched.node.confidenceScore).toBeGreaterThan(0.55);

    const conflict = await api.patch(
      second.results[0].leaseId,
      'ServiceTitan API auth endpoint is still /v1/token.',
      { agentId: 'oracle', reason: 'stale retry' }
    );

    expect(conflict).toEqual(expect.objectContaining({
      ok: false,
      reason: 'conflict',
      nodeId: patched.node.nodeId,
      currentVersion: 2,
      leaseVersion: 1,
    }));
  });

  test('patch syncs linked search index documents immediately', async () => {
    const indexedBefore = await index.search('ServiceTitan auth endpoint', { limit: 2 });
    const linkedDocument = indexedBefore.results.find((entry) => entry.sourcePath === 'knowledge/infrastructure.md');
    expect(linkedDocument).toBeTruthy();

    const retrieved = await api.retrieve('ServiceTitan auth endpoint', { agentId: 'builder', limit: 1 });
    const patched = await api.patch(
      retrieved.results[0].leaseId,
      'ServiceTitan API auth endpoint is now /v2/token instead of /v1/token.',
      { agentId: 'builder', reason: 'verified against live auth failure' }
    );

    expect(patched).toEqual(expect.objectContaining({
      ok: true,
      searchIndexSync: expect.objectContaining({
        ok: true,
        updated: expect.any(Number),
      }),
    }));
    expect(patched.searchIndexSync.updated).toBeGreaterThanOrEqual(1);

    const row = index.init().prepare(`
      SELECT content, metadata_json
      FROM memory_documents
      WHERE document_id = ?
      LIMIT 1
    `).get(linkedDocument.documentId);
    expect(row.content).toContain('/v2/token');
    expect(JSON.parse(row.metadata_json)).toEqual(expect.objectContaining({
      cognitiveNodeId: patched.node.nodeId,
      cognitiveVersion: patched.node.currentVersion,
    }));

    const indexedAfter = await index.search('v2 token', { limit: 3 });
    expect(indexedAfter.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        documentId: linkedDocument.documentId,
        content: expect.stringContaining('/v2/token'),
      }),
    ]));
  });

  test('single retrieval access updates last_accessed_at without reactivating recency', async () => {
    const ingested = await api.ingest({
      content: 'Builder note about stale supervisor retry guidance.',
      category: 'fact',
      agentId: 'builder',
      sourceType: 'agent-ingest',
      sourcePath: 'agent:builder:reactivation-single',
      heading: 'Supervisor',
    });
    const staleMs = Date.now() - (120 * 24 * 60 * 60 * 1000);
    api.init().prepare(`
      UPDATE nodes
      SET created_at_ms = ?,
          updated_at_ms = ?,
          last_accessed_at = NULL
      WHERE node_id = ?
    `).run(staleMs, staleMs, ingested.node.nodeId);

    const result = api.markNodesAccessed([ingested.node.nodeId], {
      accessKind: 'retrieval',
      nowMs: staleMs + 1000,
    });
    const node = api.getNode(ingested.node.nodeId);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      updated: 1,
      reactivated: 0,
    }));
    expect(node.accessCount).toBe(1);
    expect(node.lastAccessedAt).toBe(new Date(staleMs + 1000).toISOString());
    expect(node.updatedAtMs).toBe(staleMs);
  });

  test('repeat retrieval within the reactivation window refreshes recency', async () => {
    const ingested = await api.ingest({
      content: 'Builder note about stale supervisor retry guidance.',
      category: 'fact',
      agentId: 'builder',
      sourceType: 'agent-ingest',
      sourcePath: 'agent:builder:reactivation-repeat',
      heading: 'Supervisor',
    });
    const staleMs = Date.now() - (120 * 24 * 60 * 60 * 1000);
    api.init().prepare(`
      UPDATE nodes
      SET created_at_ms = ?,
          updated_at_ms = ?,
          last_accessed_at = NULL
      WHERE node_id = ?
    `).run(staleMs, staleMs, ingested.node.nodeId);

    api.markNodesAccessed([ingested.node.nodeId], {
      accessKind: 'retrieval',
      nowMs: staleMs + 1000,
    });
    const result = api.markNodesAccessed([ingested.node.nodeId], {
      accessKind: 'retrieval',
      nowMs: staleMs + 2000,
    });
    const node = api.getNode(ingested.node.nodeId);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      updated: 1,
      reactivated: 1,
    }));
    expect(node.accessCount).toBe(2);
    expect(node.updatedAtMs).toBe(staleMs + 2000);
  });

  test('salience field propagates through related nodes and edges', async () => {
    const authNode = await api.ensureNodeFromSearchResult({
      documentId: 101,
      sourceType: 'knowledge',
      sourcePath: 'knowledge/infrastructure.md',
      title: 'Infrastructure',
      heading: 'ServiceTitan',
      content: 'ServiceTitan API auth endpoint currently uses /v1/token for internal tooling.',
      confidence: 0.7,
    });
    const queueNode = await api.ensureNodeFromSearchResult({
      documentId: 102,
      sourceType: 'knowledge',
      sourcePath: 'knowledge/infrastructure.md',
      title: 'Infrastructure',
      heading: 'Supervisor',
      content: 'The supervisor queue keeps long-running automation durable for the user.',
      confidence: 0.65,
    });

    api.linkRelatedNodes([authNode.nodeId, queueNode.nodeId], 'related_to', 1);
    const salience = api.applySalienceField({
      nodeId: authNode.nodeId,
      delta: 0.5,
      decay: 0.5,
      maxDepth: 1,
    });

    expect(salience.ok).toBe(true);
    expect(salience.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: authNode.nodeId, depth: 0, salienceScore: 0.5 }),
      expect.objectContaining({ nodeId: queueNode.nodeId, depth: 1, salienceScore: 0.25 }),
    ]));

    const relatedEdge = api.init().prepare(`
      SELECT * FROM edges
      WHERE ((source_node_id = ? AND target_node_id = ?) OR (source_node_id = ? AND target_node_id = ?))
      LIMIT 1
    `).get(authNode.nodeId, queueNode.nodeId, queueNode.nodeId, authNode.nodeId);
    expect(Number(relatedEdge.weight)).toBeGreaterThan(1);
  });
});
