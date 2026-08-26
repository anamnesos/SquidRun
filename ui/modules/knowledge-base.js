/**
 * Knowledge Base (RAG) - Minimal JSON + cosine MVP
 * - Ingests md/txt/code files
 * - Chunks by lines/chars
 * - Stores embeddings + metadata in JSON
 * - Simple cosine similarity search
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIM = 128;
const DEFAULT_MAX_CHUNK_CHARS = 1200;
const DEFAULT_MAX_CHUNK_LINES = 120;

const SUPPORTED_EXTS = new Set([
  '.md', '.markdown', '.txt',
  '.js', '.jsx', '.ts', '.tsx',
  '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.cs', '.cpp', '.c', '.h',
  '.json', '.yaml', '.yml',
  '.html', '.css', '.scss', '.less',
  '.sh', '.ps1', '.bat',
]);

class KnowledgeBase {
  constructor(baseDir, options = {}) {
    this.baseDir = baseDir;
    this.indexPath = path.join(baseDir, 'index.json');
    this.embedder = options.embedder || null;
    this.dim = options.dim || this.embedder?.dim || DEFAULT_DIM;
    this.maxChunkChars = options.maxChunkChars || DEFAULT_MAX_CHUNK_CHARS;
    this.maxChunkLines = options.maxChunkLines || DEFAULT_MAX_CHUNK_LINES;
    this.index = this._loadIndex();
    if (this.index?.dim && this.index.dim !== this.dim) {
      this.index = this._createEmptyIndex();
    }
    this.index.dim = this.dim;
  }

  _ensureDir() {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  _loadIndex() {
    this._ensureDir();
    if (!fs.existsSync(this.indexPath)) {
      return this._createEmptyIndex();
    }
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : this._createEmptyIndex();
    } catch {
      return this._createEmptyIndex();
    }
  }

  _createEmptyIndex() {
    return {
      version: 1,
      dim: this.dim,
      updatedAt: new Date().toISOString(),
      documents: {}, // docId -> { path, hash, chunks: [chunkId], updatedAt }
      chunks: {}, // chunkId -> { docId, index, text, vector, source }
    };
  }

  _saveIndex() {
    this.index.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8');
  }

  _hashContent(text) {
    return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
  }

  _isBinary(buffer) {
    const sampleSize = Math.min(buffer.length, 8000);
    for (let i = 0; i < sampleSize; i += 1) {
      if (buffer[i] === 0) return true;
    }
    return false;
  }

  _isSupported(filePath) {
    return SUPPORTED_EXTS.has(path.extname(filePath).toLowerCase());
  }

  _docIdForPath(filePath) {
    const normalized = path.normalize(filePath);
    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  _tokenize(text) {
    const tokens = text.toLowerCase().match(/[a-z0-9_]+/g);
    return tokens || [];
  }

  _hashEmbed(text) {
    const vec = new Array(this.dim).fill(0);
    const tokens = this._tokenize(text);
    for (const token of tokens) {
      let hash = 5381;
      for (let i = 0; i < token.length; i += 1) {
        hash = ((hash << 5) + hash) + token.charCodeAt(i);
        hash |= 0;
      }
      const idx = Math.abs(hash) % this.dim;
      vec[idx] += 1;
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + (v * v), 0)) || 1;
    return vec.map(v => v / norm);
  }

  _resetDim(nextDim) {
    if (!nextDim || !Number.isFinite(nextDim)) return;
    if (this.dim === nextDim) return;
    this.dim = nextDim;
    if (this.index?.dim && this.index.dim !== nextDim) {
      this.index = this._createEmptyIndex();
    }
    this.index.dim = nextDim;
  }

  async _embed(text) {
    if (this.embedder && typeof this.embedder.embed === 'function') {
      try {
        const vec = await this.embedder.embed(text);
        if (Array.isArray(vec) && vec.length > 0) {
          this._resetDim(vec.length);
          return vec;
        }
      } catch {
        // fallback to hash embedding
      }
    }
    return this._hashEmbed(text);
  }

  _cosine(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) {
      sum += a[i] * b[i];
    }
    return sum;
  }

  _chunkByLines(text) {
    const lines = text.split(/\r?\n/);
    const chunks = [];
    let current = [];
    let startLine = 1;
    let charCount = 0;

    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      const lineLen = line.length + 1;
      const nextCharCount = charCount + lineLen;
      const nextLineCount = current.length + 1;

      if (current.length > 0 && (nextCharCount > this.maxChunkChars || nextLineCount > this.maxChunkLines)) {
        const textChunk = current.join('\n');
        chunks.push({ text: textChunk, lineStart: startLine, lineEnd: lineNum - 1 });
        current = [];
        startLine = lineNum;
        charCount = 0;
      }

      current.push(line);
      charCount += lineLen;
    });

    if (current.length > 0) {
      chunks.push({ text: current.join('\n'), lineStart: startLine, lineEnd: lines.length });
    }

    return chunks;
  }

  _removeDoc(docId) {
    const doc = this.index.documents[docId];
    if (!doc) return;
    if (Array.isArray(doc.chunks)) {
      doc.chunks.forEach((chunkId) => {
        delete this.index.chunks[chunkId];
      });
    }
    delete this.index.documents[docId];
  }

  async _ingestFile(filePath) {
    if (!this._isSupported(filePath)) {
      return { filePath, status: 'skipped', reason: 'unsupported' };
    }

    const buffer = fs.readFileSync(filePath);
    if (this._isBinary(buffer)) {
      return { filePath, status: 'skipped', reason: 'binary' };
    }

    const text = buffer.toString('utf-8');
    const hash = this._hashContent(text);
    const docId = this._docIdForPath(filePath);
    const existing = this.index.documents[docId];

    if (existing && existing.hash === hash) {
      return { filePath, status: 'unchanged', docId };
    }

    this._removeDoc(docId);

    const chunks = this._chunkByLines(text);
    const chunkIds = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const chunkId = `${docId}:${index}`;
      const vector = await this._embed(chunk.text);
      this.index.chunks[chunkId] = {
        docId,
        index,
        text: chunk.text,
        vector,
        source: {
          path: filePath,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
        },
      };
      chunkIds.push(chunkId);
    }

    this.index.documents[docId] = {
      path: filePath,
      hash,
      chunks: chunkIds,
      updatedAt: new Date().toISOString(),
    };

    return { filePath, status: 'ingested', docId, chunks: chunkIds.length };
  }

  async ingestDocument(docId, text, source = {}) {
    if (!docId || !text) {
      return { status: 'skipped', reason: 'empty' };
    }

    this._ensureDir();
    const hash = this._hashContent(text);
    const existing = this.index.documents[docId];

    if (existing && existing.hash === hash) {
      return { status: 'unchanged', docId };
    }

    this._removeDoc(docId);

    const chunks = this._chunkByLines(text);
    const chunkIds = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const chunkId = `${docId}:${index}`;
      const vector = await this._embed(chunk.text);
      this.index.chunks[chunkId] = {
        docId,
        index,
        text: chunk.text,
        vector,
        source: {
          ...source,
          docId,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
        },
      };
      chunkIds.push(chunkId);
    }

    this.index.documents[docId] = {
      path: source?.path || source?.name || docId,
      hash,
      chunks: chunkIds,
      updatedAt: new Date().toISOString(),
      source,
    };

    this._saveIndex();
    return { status: 'ingested', docId, chunks: chunkIds.length };
  }

  _walkDir(dirPath, fileList = []) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    entries.forEach((entry) => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        this._walkDir(fullPath, fileList);
      } else if (entry.isFile()) {
        fileList.push(fullPath);
      }
    });
    return fileList;
  }

  async ingestPaths(paths = []) {
    this._ensureDir();
    const results = [];
    const filePaths = [];

    paths.forEach((p) => {
      if (!p) return;
      try {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          this._walkDir(p, filePaths);
        } else if (stat.isFile()) {
          filePaths.push(p);
        }
      } catch {
        results.push({ filePath: p, status: 'error', reason: 'not_found' });
      }
    });

    for (const filePath of filePaths) {
      try {
         
        const result = await this._ingestFile(filePath);
        results.push(result);
      } catch (err) {
        results.push({ filePath, status: 'error', reason: err.message });
      }
    }

    this._saveIndex();
    return {
      total: results.length,
      ingested: results.filter(r => r.status === 'ingested').length,
      unchanged: results.filter(r => r.status === 'unchanged').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      errors: results.filter(r => r.status === 'error').length,
      results,
    };
  }

  async search(query, topK = 5) {
    if (!query || typeof query !== 'string') return [];
    const qVec = await this._embed(query);
    const scored = [];

    Object.entries(this.index.chunks).forEach(([chunkId, chunk]) => {
      const score = this._cosine(qVec, chunk.vector);
      if (Number.isFinite(score)) {
        scored.push({
          chunkId,
          score,
          text: chunk.text,
          source: chunk.source,
        });
      }
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, topK));
  }

  getStats() {
    const docCount = Object.keys(this.index.documents).length;
    const chunkCount = Object.keys(this.index.chunks).length;
    return {
      documents: docCount,
      chunks: chunkCount,
      updatedAt: this.index.updatedAt,
      dim: this.dim,
    };
  }
}

module.exports = KnowledgeBase;
