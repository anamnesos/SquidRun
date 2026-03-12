const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const sqliteVec = require('sqlite-vec');
const log = require('./logger');
const { getProjectRoot } = require('../config');

const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_EMBEDDING_DIM = 384;
const DEFAULT_CHUNK_CHARS = 2200;
const DEFAULT_CHUNK_OVERLAP_CHARS = 250;
const DEFAULT_RRF_K = 60;
const SUPPORTED_KNOWLEDGE_EXTENSIONS = new Set(['.md', '.markdown']);

function resolveWorkspacePaths(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || getProjectRoot() || process.cwd()));
  const workspaceDir = path.resolve(String(options.workspaceDir || path.join(projectRoot, 'workspace')));
  const knowledgeDir = path.resolve(String(options.knowledgeDir || path.join(workspaceDir, 'knowledge')));
  const handoffPath = path.resolve(String(options.handoffPath || path.join(workspaceDir, 'handoffs', 'session.md')));
  const memoryDir = path.resolve(String(options.memoryDir || path.join(workspaceDir, 'memory')));
  const dbPath = path.resolve(String(options.dbPath || path.join(memoryDir, 'search-index.db')));
  const modelCacheDir = path.resolve(String(options.modelCacheDir || path.join(memoryDir, 'models')));

  return {
    projectRoot,
    workspaceDir,
    knowledgeDir,
    handoffPath,
    memoryDir,
    dbPath,
    modelCacheDir,
  };
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function toPosInt(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function escapeFtsToken(token) {
  return String(token || '').replace(/"/g, '""');
}

function tokenizeSearchQuery(query) {
  return String(query || '')
    .toLowerCase()
    .match(/[a-z0-9_]+/g) || [];
}

function buildFtsQuery(query) {
  const tokens = tokenizeSearchQuery(query).slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${escapeFtsToken(token)}"`).join(' OR ');
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function createExcerpt(content, query = '', maxChars = 220) {
  const text = normalizeWhitespace(content);
  if (!text) return '';
  if (text.length <= maxChars) return text;

  const lowered = text.toLowerCase();
  const tokens = tokenizeSearchQuery(query);
  let anchor = -1;
  for (const token of tokens) {
    anchor = lowered.indexOf(token);
    if (anchor >= 0) break;
  }

  if (anchor < 0) {
    return `${text.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
  }

  const start = Math.max(0, anchor - Math.floor(maxChars / 3));
  const end = Math.min(text.length, start + maxChars);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function listMarkdownFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SUPPORTED_KNOWLEDGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      results.push(fullPath);
    }
  }
  return results.sort((left, right) => left.localeCompare(right));
}

function getMarkdownTitle(content, fallback = '') {
  const lines = String(content || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^#\s+(.+)$/);
    if (match) return normalizeWhitespace(match[1]);
  }
  return normalizeWhitespace(fallback);
}

function splitMarkdownSections(content, fallbackHeading = '') {
  const text = String(content || '');
  const lines = text.split(/\r?\n/);
  const sections = [];
  let heading = fallbackHeading || '';
  let level = heading ? 1 : 0;
  let buffer = [];

  function flush() {
    const sectionText = buffer.join('\n').trim();
    if (!sectionText) {
      buffer = [];
      return;
    }
    sections.push({
      heading: normalizeWhitespace(heading || fallbackHeading || ''),
      headingLevel: level,
      content: sectionText,
    });
    buffer = [];
  }

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      flush();
      heading = normalizeWhitespace(match[2]);
      level = match[1].length;
      continue;
    }
    buffer.push(line);
  }
  flush();

  if (sections.length === 0 && text.trim()) {
    return [{ heading: normalizeWhitespace(fallbackHeading), headingLevel: 0, content: text.trim() }];
  }
  return sections;
}

function chunkText(content, options = {}) {
  const maxChars = toPosInt(options.maxChars, DEFAULT_CHUNK_CHARS);
  const overlapChars = Math.max(0, Math.min(maxChars / 2, toPosInt(options.overlapChars, DEFAULT_CHUNK_OVERLAP_CHARS)));
  const paragraphs = String(content || '')
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    const trimmed = String(content || '').trim();
    return trimmed ? [trimmed] : [];
  }

  const chunks = [];
  let current = '';

  function flushChunk() {
    const normalized = current.trim();
    if (!normalized) return;
    chunks.push(normalized);
    if (overlapChars <= 0 || normalized.length <= overlapChars) {
      current = '';
      return;
    }
    current = normalized.slice(normalized.length - overlapChars);
  }

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }

    const candidate = `${current}\n\n${paragraph}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    flushChunk();
    if (!current) {
      current = paragraph;
      continue;
    }

    if (current.length + 2 + paragraph.length <= maxChars) {
      current = `${current}\n\n${paragraph}`;
      continue;
    }

    let remaining = paragraph;
    while (remaining.length > maxChars) {
      const slice = remaining.slice(0, maxChars);
      chunks.push(slice.trim());
      remaining = overlapChars > 0
        ? remaining.slice(Math.max(1, maxChars - overlapChars))
        : remaining.slice(maxChars);
    }
    current = remaining;
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

function parseMarkdownTable(sectionText) {
  const lines = String(sectionText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'));
  if (lines.length < 3) return [];

  const header = lines[0]
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);
  if (header.length === 0) return [];

  const rows = [];
  for (const line of lines.slice(2)) {
    const cells = line
      .split('|')
      .map((cell) => cell.trim())
      .filter((_, index, arr) => !(index === 0 && arr[index] === '') && !(index === arr.length - 1 && arr[index] === ''));
    if (cells.length === 0) continue;
    const record = {};
    for (let i = 0; i < header.length; i += 1) {
      const value = cells[i] == null || cells[i] === '-' ? '' : cells[i];
      record[header[i]] = value;
    }
    rows.push(record);
  }
  return rows;
}

function extractMarkdownSection(documentText, heading) {
  const targetHeading = normalizeWhitespace(heading).toLowerCase();
  const sections = splitMarkdownSections(documentText, '');
  const match = sections.find((section) => normalizeWhitespace(section.heading).toLowerCase() === targetHeading);
  return match ? match.content : '';
}

function buildKnowledgeSources(paths, options = {}) {
  const markdownFiles = listMarkdownFiles(paths.knowledgeDir);
  const sources = [];
  for (const filePath of markdownFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const stat = fs.statSync(filePath);
    const relativePath = path.relative(paths.workspaceDir, filePath).replace(/\\/g, '/');
    const title = getMarkdownTitle(content, path.basename(filePath, path.extname(filePath)));
    const sections = splitMarkdownSections(content, title);

    sections.forEach((section, sectionIndex) => {
      const chunks = chunkText(section.content, options);
      chunks.forEach((chunkContent, chunkIndex) => {
        sources.push({
          sourceKey: `knowledge:${relativePath}:${sectionIndex}:${chunkIndex}`,
          sourceGroup: `knowledge:${relativePath}`,
          sourceType: 'knowledge',
          sourcePath: relativePath,
          title,
          heading: section.heading || title,
          content: chunkContent,
          lastModifiedMs: stat.mtimeMs,
          metadata: {
            sectionIndex,
            chunkIndex,
            headingLevel: section.headingLevel,
          },
        });
      });
    });
  }
  return sources;
}

function buildSessionHandoffSources(paths) {
  if (!fs.existsSync(paths.handoffPath)) return [];
  const content = fs.readFileSync(paths.handoffPath, 'utf8');
  const stat = fs.statSync(paths.handoffPath);
  const relativePath = path.relative(paths.workspaceDir, paths.handoffPath).replace(/\\/g, '/');
  const sources = [];

  const decisionRows = parseMarkdownTable(extractMarkdownSection(content, 'Decision Digest'));
  decisionRows.forEach((row, index) => {
    if (!row.session_id || row.session_id === '-') return;
    const chunkContent = [
      `Decision digest for session ${row.session_id}.`,
      row.latest_at ? `Latest activity: ${row.latest_at}.` : '',
      row.decisions ? `Decisions: ${row.decisions}.` : '',
      row.findings ? `Findings: ${row.findings}.` : '',
      row.highlights ? `Highlights: ${row.highlights}.` : '',
    ].filter(Boolean).join(' ');
    if (!chunkContent.trim()) return;
    sources.push({
      sourceKey: `handoff:decision-digest:${row.session_id}:${index}`,
      sourceGroup: `handoff:${relativePath}:decision-digest`,
      sourceType: 'decision_digest',
      sourcePath: relativePath,
      title: 'Decision Digest',
      heading: row.session_id,
      content: chunkContent,
      lastModifiedMs: stat.mtimeMs,
      metadata: row,
    });
  });

  const crossSessionRows = parseMarkdownTable(extractMarkdownSection(content, 'Cross-Session Decisions'));
  crossSessionRows.forEach((row, index) => {
    if (!row.detail || row.detail === '-') return;
    const identity = row.message_id || row.trace_id || String(index);
    const chunkContent = [
      row.sent_at ? `Recorded at ${row.sent_at}.` : '',
      row.session_id ? `Session: ${row.session_id}.` : '',
      row.tag ? `Tag: ${row.tag}.` : '',
      row.sender ? `Sender: ${row.sender}.` : '',
      row.target ? `Target: ${row.target}.` : '',
      `Detail: ${row.detail}.`,
    ].filter(Boolean).join(' ');
    sources.push({
      sourceKey: `handoff:cross-session:${identity}:${index}`,
      sourceGroup: `handoff:${relativePath}:cross-session`,
      sourceType: 'cross_session_decision',
      sourcePath: relativePath,
      title: 'Cross-Session Decisions',
      heading: row.tag || 'decision',
      content: chunkContent,
      lastModifiedMs: stat.mtimeMs,
      metadata: row,
    });
  });

  return sources;
}

let embeddingPipelinePromise = null;

async function loadEmbeddingPipeline(options = {}) {
  if (options.embedder && typeof options.embedder.embed === 'function') {
    return options.embedder;
  }
  if (!embeddingPipelinePromise) {
    embeddingPipelinePromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      if (options.modelCacheDir) {
        env.cacheDir = options.modelCacheDir;
      }
      env.allowLocalModels = true;
      env.useBrowserCache = false;
      const extractor = await pipeline('feature-extraction', options.model || DEFAULT_EMBEDDING_MODEL);
      return {
        model: options.model || DEFAULT_EMBEDDING_MODEL,
        dim: DEFAULT_EMBEDDING_DIM,
        async embed(text) {
          const result = await extractor(String(text || ''), { pooling: 'mean', normalize: true });
          return Array.from(result.data || []);
        },
      };
    })();
  }
  return embeddingPipelinePromise;
}

class MemorySearchIndex {
  constructor(options = {}) {
    this.paths = resolveWorkspacePaths(options);
    this.dbPath = this.paths.dbPath;
    this.model = options.model || DEFAULT_EMBEDDING_MODEL;
    this.chunkChars = toPosInt(options.chunkChars, DEFAULT_CHUNK_CHARS);
    this.chunkOverlapChars = toPosInt(options.chunkOverlapChars, DEFAULT_CHUNK_OVERLAP_CHARS);
    this.embedder = options.embedder || null;
    this.logger = options.logger || log;
    this.db = null;
  }

  async getEmbedder() {
    if (this.embedder) return this.embedder;
    this.embedder = await loadEmbeddingPipeline({
      model: this.model,
      modelCacheDir: this.paths.modelCacheDir,
    });
    return this.embedder;
  }

  init() {
    if (this.db) return this.db;
    ensureDir(this.paths.memoryDir);
    ensureDir(this.paths.modelCacheDir);
    const db = new DatabaseSync(this.dbPath, { allowExtension: true });
    try {
      db.enableLoadExtension(true);
      sqliteVec.load(db);
      db.exec('PRAGMA journal_mode=WAL;');
      db.exec('PRAGMA synchronous=NORMAL;');
      db.exec('PRAGMA temp_store=MEMORY;');
      db.exec('PRAGMA foreign_keys=ON;');
      db.exec('PRAGMA busy_timeout=5000;');
      db.exec(`
      CREATE TABLE IF NOT EXISTS memory_sources (
        source_group TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_path TEXT,
        title TEXT,
        content_hash TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        last_modified_ms INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS memory_documents (
        document_id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_key TEXT NOT NULL UNIQUE,
        source_group TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_path TEXT,
        title TEXT,
        heading TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        last_modified_ms INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 0.5,
        review_count INTEGER NOT NULL DEFAULT 0,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_memory_documents_source_group ON memory_documents(source_group);
      CREATE INDEX IF NOT EXISTS idx_memory_documents_source_type ON memory_documents(source_type);
      CREATE INDEX IF NOT EXISTS idx_memory_documents_access ON memory_documents(last_accessed_at_ms);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_documents_fts USING fts5(
        title,
        heading,
        content,
        source_path,
        source_type
      );
    `);

      const moduleList = db.prepare('PRAGMA module_list').all();
      const hasVec = moduleList.some((row) => String(row.name || '').toLowerCase() === 'vec0');
      if (!hasVec) {
        throw new Error('sqlite_vec_extension_not_loaded');
      }
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_documents_vec USING vec0(
          embedding float[${DEFAULT_EMBEDDING_DIM}]
        );
      `);

      this.db = db;
      return db;
    } catch (err) {
      try { db.close(); } catch {}
      throw err;
    }
  }

  close() {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {}
    this.db = null;
  }

  getStatus() {
    const db = this.init();
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM memory_sources) AS source_count,
        (SELECT COUNT(*) FROM memory_documents) AS document_count,
        (SELECT COUNT(*) FROM memory_documents_vec) AS vector_count,
        (SELECT COUNT(*) FROM memory_documents_fts) AS fts_count
    `).get();
    return {
      dbPath: this.dbPath,
      ...counts,
      embeddingModel: this.model,
    };
  }

  collectSources() {
    const options = {
      maxChars: this.chunkChars,
      overlapChars: this.chunkOverlapChars,
    };
    return [
      ...buildKnowledgeSources(this.paths, options),
      ...buildSessionHandoffSources(this.paths),
    ];
  }

  getExistingSourceRow(sourceGroup) {
    return this.init().prepare(`
      SELECT * FROM memory_sources WHERE source_group = ?
    `).get(String(sourceGroup || '')) || null;
  }

  isSourceFresh(sourceRecords) {
    const records = Array.isArray(sourceRecords) ? sourceRecords : [];
    const first = records[0] || null;
    if (!first) return false;
    const row = this.getExistingSourceRow(first.sourceGroup);
    if (!row) return false;
    const sourceHash = sha256(JSON.stringify(records.map((record) => ({
      sourceKey: record.sourceKey,
      heading: record.heading,
      content: record.content,
      metadata: record.metadata,
    }))));
    return row.content_hash === sourceHash && Number(row.last_modified_ms || 0) === Number(first.lastModifiedMs || 0);
  }

  deleteSourceGroup(sourceGroup) {
    const db = this.init();
    const rows = db.prepare(`
      SELECT document_id FROM memory_documents WHERE source_group = ?
    `).all(String(sourceGroup || ''));
    const docIds = rows.map((row) => BigInt(row.document_id));
    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const documentId of docIds) {
        db.prepare('DELETE FROM memory_documents_vec WHERE rowid = ?').run(documentId);
        db.prepare('DELETE FROM memory_documents_fts WHERE rowid = ?').run(documentId);
      }
      db.prepare('DELETE FROM memory_documents WHERE source_group = ?').run(String(sourceGroup || ''));
      db.prepare('DELETE FROM memory_sources WHERE source_group = ?').run(String(sourceGroup || ''));
      db.exec('COMMIT;');
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw err;
    }
  }

  async replaceSourceGroup(sourceGroup, sourceRecords) {
    const db = this.init();
    const embedder = await this.getEmbedder();
    const records = Array.isArray(sourceRecords) ? sourceRecords.slice() : [];
    const sourceMeta = records[0] || null;
    const nowMs = Date.now();
    const sourceType = sourceMeta?.sourceType || 'unknown';
    const sourcePath = sourceMeta?.sourcePath || null;
    const title = sourceMeta?.title || null;
    const lastModifiedMs = Number(sourceMeta?.lastModifiedMs || 0);
    const contentHash = sha256(JSON.stringify(records.map((record) => ({
      sourceKey: record.sourceKey,
      heading: record.heading,
      content: record.content,
      metadata: record.metadata,
    }))));

    this.deleteSourceGroup(sourceGroup);

    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const record of records) {
        const vector = await embedder.embed(record.content);
        const insertResult = db.prepare(`
          INSERT INTO memory_documents (
            source_key,
            source_group,
            source_type,
            source_path,
            title,
            heading,
            content,
            content_hash,
            last_modified_ms,
            metadata_json,
            created_at_ms,
            updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.sourceKey,
          record.sourceGroup,
          record.sourceType,
          record.sourcePath,
          record.title,
          record.heading,
          record.content,
          sha256(record.content),
          Number(record.lastModifiedMs || 0),
          JSON.stringify(record.metadata || {}),
          nowMs,
          nowMs
        );
        const documentId = BigInt(insertResult.lastInsertRowid);
        db.prepare(`
          INSERT INTO memory_documents_fts (rowid, title, heading, content, source_path, source_type)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(documentId, record.title, record.heading, record.content, record.sourcePath, record.sourceType);
        db.prepare(`
          INSERT INTO memory_documents_vec (rowid, embedding) VALUES (?, ?)
        `).run(documentId, JSON.stringify(vector));
      }

      db.prepare(`
        INSERT INTO memory_sources (
          source_group,
          source_type,
          source_path,
          title,
          content_hash,
          chunk_count,
          last_modified_ms,
          updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sourceGroup,
        sourceType,
        sourcePath,
        title,
        contentHash,
        records.length,
        lastModifiedMs,
        nowMs
      );
      db.exec('COMMIT;');
      return { ok: true, sourceGroup, chunks: records.length };
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw err;
    }
  }

  async indexAll(options = {}) {
    const force = options.force === true;
    const sources = this.collectSources();
    const grouped = new Map();
    for (const source of sources) {
      const list = grouped.get(source.sourceGroup) || [];
      list.push(source);
      grouped.set(source.sourceGroup, list);
    }

    const summary = {
      ok: true,
      dbPath: this.dbPath,
      sourceGroups: grouped.size,
      chunksDiscovered: sources.length,
      indexedGroups: 0,
      skippedGroups: 0,
      removedGroups: 0,
      indexedChunks: 0,
    };

    const existingGroups = this.init().prepare('SELECT source_group FROM memory_sources').all().map((row) => row.source_group);
    const desiredGroups = new Set(grouped.keys());

    for (const sourceGroup of existingGroups) {
      if (!desiredGroups.has(sourceGroup)) {
        this.deleteSourceGroup(sourceGroup);
        summary.removedGroups += 1;
      }
    }

    for (const [sourceGroup, records] of grouped.entries()) {
      const fresh = !force && records.length > 0 && this.isSourceFresh(records);
      if (fresh) {
        summary.skippedGroups += 1;
        continue;
      }
      const result = await this.replaceSourceGroup(sourceGroup, records);
      summary.indexedGroups += 1;
      summary.indexedChunks += Number(result.chunks || 0);
    }

    summary.status = this.getStatus();
    return summary;
  }

  keywordSearch(query, limit = 10) {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    return this.init().prepare(`
      SELECT rowid AS document_id, bm25(memory_documents_fts) AS bm25_score
      FROM memory_documents_fts
      WHERE memory_documents_fts MATCH ?
      ORDER BY bm25_score ASC
      LIMIT ?
    `).all(ftsQuery, toPosInt(limit, 10));
  }

  semanticSearch(vector, limit = 10) {
    return this.init().prepare(`
      SELECT rowid AS document_id, distance
      FROM memory_documents_vec
      WHERE embedding MATCH ?
      ORDER BY distance ASC
      LIMIT ?
    `).all(JSON.stringify(Array.from(vector || [])), toPosInt(limit, 10));
  }

  getDocumentsByIds(documentIds) {
    const ids = Array.from(new Set((documentIds || []).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)));
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.init().prepare(`
      SELECT * FROM memory_documents WHERE document_id IN (${placeholders})
    `).all(...ids);
  }

  markAccessed(documentIds) {
    const ids = Array.from(new Set((documentIds || []).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)));
    if (ids.length === 0) return;
    const nowMs = Date.now();
    const placeholders = ids.map(() => '?').join(', ');
    this.init().prepare(`
      UPDATE memory_documents
      SET access_count = access_count + 1,
          last_accessed_at_ms = ?,
          updated_at_ms = ?
      WHERE document_id IN (${placeholders})
    `).run(nowMs, nowMs, ...ids);
  }

  async search(query, options = {}) {
    const trimmedQuery = String(query || '').trim();
    if (!trimmedQuery) {
      return { ok: false, reason: 'query_required', results: [] };
    }

    const limit = toPosInt(options.limit, 8);
    const candidateLimit = Math.max(limit, toPosInt(options.candidateLimit, 20));
    const keywordRows = this.keywordSearch(trimmedQuery, candidateLimit);
    const embedder = await this.getEmbedder();
    const vector = await embedder.embed(trimmedQuery);
    const semanticRows = this.semanticSearch(vector, candidateLimit);
    const combined = new Map();
    const rrfK = toPosInt(options.rrfK, DEFAULT_RRF_K);

    keywordRows.forEach((row, index) => {
      const id = Number(row.document_id);
      const existing = combined.get(id) || { documentId: id, score: 0, keywordRank: null, semanticRank: null };
      existing.keywordRank = index + 1;
      existing.score += 1 / (rrfK + index + 1);
      combined.set(id, existing);
    });

    semanticRows.forEach((row, index) => {
      const id = Number(row.document_id);
      const existing = combined.get(id) || { documentId: id, score: 0, keywordRank: null, semanticRank: null };
      existing.semanticRank = index + 1;
      existing.distance = Number(row.distance);
      existing.score += 1 / (rrfK + index + 1);
      combined.set(id, existing);
    });

    const documentIds = Array.from(combined.keys());
    const documents = this.getDocumentsByIds(documentIds);
    const docsById = new Map(documents.map((row) => [Number(row.document_id), row]));
    const results = Array.from(combined.values())
      .map((entry) => {
        const doc = docsById.get(entry.documentId);
        if (!doc) return null;
        return {
          documentId: entry.documentId,
          score: Number(entry.score.toFixed(8)),
          keywordRank: entry.keywordRank,
          semanticRank: entry.semanticRank,
          distance: entry.distance ?? null,
          sourceType: doc.source_type,
          sourcePath: doc.source_path,
          title: doc.title,
          heading: doc.heading,
          content: doc.content,
          excerpt: createExcerpt(doc.content, trimmedQuery),
          metadata: JSON.parse(doc.metadata_json || '{}'),
          confidence: Number(doc.confidence || 0),
          accessCount: Number(doc.access_count || 0),
          lastAccessedAtMs: doc.last_accessed_at_ms == null ? null : Number(doc.last_accessed_at_ms),
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score || left.documentId - right.documentId)
      .slice(0, limit);

    this.markAccessed(results.map((result) => result.documentId));

    return {
      ok: true,
      query: trimmedQuery,
      keywordCandidates: keywordRows.length,
      semanticCandidates: semanticRows.length,
      results,
    };
  }
}

module.exports = {
  DEFAULT_EMBEDDING_DIM,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_CHUNK_CHARS,
  DEFAULT_CHUNK_OVERLAP_CHARS,
  resolveWorkspacePaths,
  tokenizeSearchQuery,
  buildFtsQuery,
  splitMarkdownSections,
  chunkText,
  parseMarkdownTable,
  buildKnowledgeSources,
  buildSessionHandoffSources,
  MemorySearchIndex,
};


