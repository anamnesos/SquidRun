const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDatabaseSync, openDatabase } = require('./sqlite-compat');
const sqliteVec = require('sqlite-vec');
const log = require('./logger');
const { getProjectRoot } = require('../config');

const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_EMBEDDING_DIM = 384;
const DEFAULT_CHUNK_CHARS = 2200;
const DEFAULT_CHUNK_OVERLAP_CHARS = 250;
const DEFAULT_RRF_K = 60;
const DEFAULT_KEYWORD_WEIGHT = 2.1;
const DEFAULT_SEMANTIC_WEIGHT = 0.9;
const DEFAULT_TOKEN_COVERAGE_WEIGHT = 0.03;
const DEFAULT_PHRASE_MATCH_WEIGHT = 0.015;
const DEFAULT_TITLE_MATCH_WEIGHT = 0.01;
const DEFAULT_HEADING_MATCH_WEIGHT = 0.008;
const DEFAULT_SEMANTIC_ONLY_PENALTY = 0.01;
const DEFAULT_RECENCY_HALF_LIFE_MS = Math.max(
  86_400_000,
  Number.parseInt(process.env.SQUIDRUN_MEMORY_RECENCY_HALF_LIFE_MS || `${30 * 86_400_000}`, 10) || (30 * 86_400_000)
);
const DEFAULT_MIN_RECENCY_MULTIPLIER = Math.max(
  0.1,
  Math.min(
    1,
    Number.isFinite(Number(process.env.SQUIDRUN_MEMORY_MIN_RECENCY_MULTIPLIER))
      ? Number(process.env.SQUIDRUN_MEMORY_MIN_RECENCY_MULTIPLIER)
      : 0.55
  )
);
const SUPPORTED_KNOWLEDGE_EXTENSIONS = new Set(['.md', '.markdown']);
const SUPPORTED_EVIDENCE_TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.html', '.htm', '.json']);
const SUPPORTED_EVIDENCE_METADATA_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.mp4',
  '.mov',
  '.wav',
  '.mp3',
  '.m4a',
  '.pdf',
  '.zip',
]);
const DEFAULT_CASE_EVIDENCE_FOLDERS = [
  'Jeon Myeongsam Case',
  'Hillstate Case',
  'Korean Fraud',
];

function resolveWorkspacePaths(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || getProjectRoot() || process.cwd()));
  const workspaceDir = path.resolve(String(options.workspaceDir || path.join(projectRoot, 'workspace')));
  const knowledgeDir = path.resolve(String(options.knowledgeDir || path.join(workspaceDir, 'knowledge')));
  const handoffPath = path.resolve(String(options.handoffPath || path.join(projectRoot, '.squidrun', 'handoffs', 'session.md')));
  const memoryDir = path.resolve(String(options.memoryDir || path.join(workspaceDir, 'memory')));
  const dbPath = path.resolve(String(options.dbPath || path.join(memoryDir, 'search-index.db')));
  const modelCacheDir = path.resolve(String(options.modelCacheDir || path.join(memoryDir, 'models')));
  const siblingRoot = path.resolve(String(options.siblingRoot || path.dirname(projectRoot)));
  const caseEvidenceDirs = Array.isArray(options.caseEvidenceDirs) && options.caseEvidenceDirs.length > 0
    ? options.caseEvidenceDirs.map((targetPath) => path.resolve(String(targetPath)))
    : DEFAULT_CASE_EVIDENCE_FOLDERS
      .map((folderName) => path.join(siblingRoot, folderName, 'evidence'))
      .filter((targetPath) => fs.existsSync(targetPath));

  return {
    projectRoot,
    workspaceDir,
    knowledgeDir,
    handoffPath,
    memoryDir,
    dbPath,
    modelCacheDir,
    siblingRoot,
    caseEvidenceDirs,
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

function findBoundaryBefore(text, index, window = 80) {
  const target = Math.max(0, Math.min(text.length, Number(index) || 0));
  const min = Math.max(0, target - Math.max(8, window));
  for (let cursor = target; cursor > min; cursor -= 1) {
    if (/\s/.test(text[cursor - 1] || '')) {
      return cursor;
    }
  }
  return target;
}

function findPreferredChunkEnd(text, start, maxChars) {
  const chunkStart = Math.max(0, Number(start) || 0);
  const hardEnd = Math.min(text.length, chunkStart + maxChars);
  if (hardEnd >= text.length) return text.length;

  const preferredMin = chunkStart + Math.max(1, Math.floor(maxChars * 0.65));
  const window = text.slice(chunkStart, hardEnd);
  const patterns = [
    /\n\s*\n/g,
    /\n/g,
    /[.!?]\s/g,
    /[;:]\s/g,
    /,\s/g,
    /\s/g,
  ];

  let bestEnd = -1;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(window)) !== null) {
      const candidateEnd = chunkStart + match.index + match[0].length;
      if (candidateEnd >= preferredMin) {
        bestEnd = Math.max(bestEnd, candidateEnd);
      }
    }
    if (bestEnd >= preferredMin) {
      return bestEnd;
    }
  }

  return hardEnd;
}

function alignChunkStart(text, proposedStart, previousStart) {
  const normalizedPreviousStart = Math.max(0, Number(previousStart) || 0);
  const target = Math.max(normalizedPreviousStart + 1, Math.min(text.length, Number(proposedStart) || 0));
  return Math.max(normalizedPreviousStart + 1, findBoundaryBefore(text, target));
}

function buildExcerptWindow(text, start, maxChars) {
  const safeStart = Math.max(0, Math.min(text.length, Number(start) || 0));
  const safeEnd = Math.min(text.length, safeStart + maxChars);
  const prefix = safeStart > 0 ? '...' : '';
  const suffix = safeEnd < text.length ? '...' : '';
  return `${prefix}${text.slice(safeStart, safeEnd).trim()}${suffix}`;
}

function getExcerptTokenWeight(token) {
  const normalized = String(token || '');
  if (!normalized) return 0;
  return 1 + (Math.min(normalized.length, 16) / 12);
}

function collectExcerptTokenMatches(text, queryTokens) {
  const lowered = text.toLowerCase();
  const matches = [];

  for (const token of queryTokens) {
    let fromIndex = 0;
    let hits = 0;
    const weight = getExcerptTokenWeight(token);
    while (fromIndex < lowered.length && hits < 8) {
      const index = lowered.indexOf(token, fromIndex);
      if (index < 0) break;
      matches.push({
        token,
        index,
        end: index + token.length,
        weight,
      });
      fromIndex = index + token.length;
      hits += 1;
    }
  }

  return matches.sort((left, right) => left.index - right.index || right.weight - left.weight);
}

function buildExcerptCandidateStarts(text, maxChars, normalizedQuery, tokenMatches) {
  const candidateStarts = new Set([0]);
  const clusterWindowChars = Math.max(48, Math.floor(maxChars * 0.65));
  const leadingAnchorOffset = Math.max(24, Math.floor(maxChars * 0.22));

  if (normalizedQuery) {
    let fromIndex = 0;
    let hits = 0;
    const lowered = text.toLowerCase();
    while (fromIndex < lowered.length && hits < 4) {
      const phraseIndex = lowered.indexOf(normalizedQuery, fromIndex);
      if (phraseIndex < 0) break;
      candidateStarts.add(Math.max(0, phraseIndex - leadingAnchorOffset));
      fromIndex = phraseIndex + normalizedQuery.length;
      hits += 1;
    }
  }

  for (const match of tokenMatches.slice(0, 32)) {
    candidateStarts.add(Math.max(0, match.index - leadingAnchorOffset));
  }

  for (let left = 0; left < tokenMatches.length; left += 1) {
    let right = left;
    while (right + 1 < tokenMatches.length && (tokenMatches[right + 1].index - tokenMatches[left].index) <= clusterWindowChars) {
      right += 1;
    }

    const first = tokenMatches[left];
    const last = tokenMatches[right];
    const spanStart = first.index;
    const spanEnd = Math.max(first.end, last.end);
    const spanCenter = Math.floor((spanStart + spanEnd) / 2);
    candidateStarts.add(Math.max(0, spanCenter - Math.floor(maxChars / 2)));
    candidateStarts.add(Math.max(0, spanStart - leadingAnchorOffset));
  }

  return Array.from(candidateStarts).sort((left, right) => left - right);
}

function scoreExcerptWindow(text, start, maxChars, normalizedQuery, tokenMatches) {
  const safeStart = Math.max(0, Math.min(text.length, Number(start) || 0));
  const safeEnd = Math.min(text.length, safeStart + maxChars);
  const windowText = text.slice(safeStart, safeEnd).toLowerCase();
  const matchesInWindow = tokenMatches.filter((match) => match.index < safeEnd && match.end > safeStart);

  if (matchesInWindow.length === 0) {
    return normalizedQuery && windowText.includes(normalizedQuery) ? 2 : 0;
  }

  const uniqueTokenWeights = new Map();
  let occurrenceScore = 0;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = -1;

  for (const match of matchesInWindow) {
    occurrenceScore += match.weight * 0.45;
    if (!uniqueTokenWeights.has(match.token)) {
      uniqueTokenWeights.set(match.token, match.weight);
    }
    earliest = Math.min(earliest, match.index);
    latest = Math.max(latest, match.end);
  }

  const coverageScore = Array.from(uniqueTokenWeights.values()).reduce((sum, value) => sum + (value * 5), 0);
  const clusterSpan = Math.max(0, latest - earliest);
  const clusterTightnessBonus = uniqueTokenWeights.size > 1
    ? Math.max(0, 8 - (clusterSpan / Math.max(24, Math.floor(maxChars * 0.12))))
    : 0;
  const phraseBonus = normalizedQuery && windowText.includes(normalizedQuery) ? 10 : 0;
  const clusterCenter = earliest + Math.floor(clusterSpan / 2);
  const windowCenter = safeStart + Math.floor((safeEnd - safeStart) / 2);
  const centerDistance = Math.abs(clusterCenter - windowCenter);
  const centerBonus = Math.max(0, 3 - (centerDistance / Math.max(20, Math.floor(maxChars * 0.15))));

  return coverageScore + occurrenceScore + clusterTightnessBonus + phraseBonus + centerBonus;
}

function createExcerpt(content, query = '', maxChars = 220) {
  const text = normalizeWhitespace(content);
  if (!text) return '';
  if (text.length <= maxChars) return text;

  const lowered = text.toLowerCase();
  const tokens = Array.from(new Set(tokenizeSearchQuery(query))).slice(0, 8);
  const normalizedQuery = normalizeWhitespace(query).toLowerCase();
  const tokenMatches = collectExcerptTokenMatches(text, tokens);
  const candidateStarts = buildExcerptCandidateStarts(text, maxChars, normalizedQuery, tokenMatches);

  let bestExcerpt = buildExcerptWindow(text, 0, maxChars);
  let bestScore = scoreExcerptWindow(text, 0, maxChars, normalizedQuery, tokenMatches);

  for (const start of candidateStarts) {
    const candidate = buildExcerptWindow(text, start, maxChars);
    const score = scoreExcerptWindow(text, start, maxChars, normalizedQuery, tokenMatches);
    if (score > bestScore) {
      bestScore = score;
      bestExcerpt = candidate;
    }
  }

  return bestExcerpt;
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

function listFiles(rootDir) {
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
      results.push(fullPath);
    }
  }
  return results.sort((left, right) => left.localeCompare(right));
}

function normalizeSourcePath(filePath, paths) {
  const projectRoot = path.resolve(String(paths?.projectRoot || process.cwd()));
  const workspaceDir = path.resolve(String(paths?.workspaceDir || projectRoot));
  const siblingRoot = path.resolve(String(paths?.siblingRoot || path.dirname(projectRoot)));

  if (filePath.startsWith(workspaceDir + path.sep) || filePath === workspaceDir) {
    return path.relative(workspaceDir, filePath).replace(/\\/g, '/');
  }
  if (filePath.startsWith(projectRoot + path.sep) || filePath === projectRoot) {
    return path.relative(projectRoot, filePath).replace(/\\/g, '/');
  }
  return path.relative(siblingRoot, filePath).replace(/\\/g, '/');
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
  const text = String(content || '').trim();
  if (!text) return [];
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = findPreferredChunkEnd(text, start, maxChars);
    const chunk = text.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (end >= text.length) break;

    if (overlapChars <= 0) {
      start = end;
      continue;
    }

    const nextStart = alignChunkStart(text, end - overlapChars, start);
    start = nextStart > start ? nextStart : end;
  }

  return chunks;
}

function computeDocumentMatchSignals(doc, query) {
  const tokens = Array.from(new Set(tokenizeSearchQuery(query)));
  const normalizedQuery = normalizeWhitespace(query).toLowerCase();
  const titleText = normalizeWhitespace(doc?.title || '').toLowerCase();
  const headingText = normalizeWhitespace(doc?.heading || '').toLowerCase();
  const contentText = normalizeWhitespace(doc?.content || '').toLowerCase();
  const corpus = `${titleText} ${headingText} ${contentText}`.trim();

  if (tokens.length === 0 || !corpus) {
    return {
      matchedTokenCount: 0,
      tokenCoverage: 0,
      phraseMatch: false,
      titleMatch: false,
      headingMatch: false,
    };
  }

  let matchedTokenCount = 0;
  for (const token of tokens) {
    if (corpus.includes(token)) {
      matchedTokenCount += 1;
    }
  }

  return {
    matchedTokenCount,
    tokenCoverage: matchedTokenCount / tokens.length,
    phraseMatch: Boolean(normalizedQuery && corpus.includes(normalizedQuery)),
    titleMatch: tokens.some((token) => titleText.includes(token)),
    headingMatch: tokens.some((token) => headingText.includes(token)),
  };
}

function computeRecencyMultiplier(referenceMs, nowMs = Date.now()) {
  const normalizedReferenceMs = Number(referenceMs || 0);
  if (!Number.isFinite(normalizedReferenceMs) || normalizedReferenceMs <= 0) {
    return DEFAULT_MIN_RECENCY_MULTIPLIER;
  }

  const ageMs = Math.max(0, Number(nowMs || Date.now()) - normalizedReferenceMs);
  if (ageMs === 0) return 1;

  const freshness = Math.exp((-Math.log(2) * ageMs) / DEFAULT_RECENCY_HALF_LIFE_MS);
  return DEFAULT_MIN_RECENCY_MULTIPLIER
    + ((1 - DEFAULT_MIN_RECENCY_MULTIPLIER) * freshness);
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

function buildEvidenceSources(paths, options = {}) {
  const evidenceDirs = Array.isArray(paths.caseEvidenceDirs) ? paths.caseEvidenceDirs : [];
  const sources = [];

  for (const evidenceDir of evidenceDirs) {
    if (!fs.existsSync(evidenceDir)) continue;
    const caseName = path.basename(path.dirname(evidenceDir));
    const filePaths = listFiles(evidenceDir);

    for (const filePath of filePaths) {
      const extension = path.extname(filePath).toLowerCase();
      const stat = fs.statSync(filePath);
      const sourcePath = normalizeSourcePath(filePath, paths);
      const sourceGroup = `case_evidence:${sourcePath}`;
      const title = path.basename(filePath);
      const heading = `${caseName} evidence`;

      if (SUPPORTED_EVIDENCE_TEXT_EXTENSIONS.has(extension)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const chunks = chunkText(content, options);
        chunks.forEach((chunkContent, chunkIndex) => {
          sources.push({
            sourceKey: `case_evidence:${sourcePath}:${chunkIndex}`,
            sourceGroup,
            sourceType: 'case_evidence',
            sourcePath,
            title,
            heading,
            content: chunkContent,
            lastModifiedMs: stat.mtimeMs,
            metadata: {
              caseName,
              extension,
              chunkIndex,
              indexedMode: 'text',
            },
          });
        });
        continue;
      }

      if (!SUPPORTED_EVIDENCE_METADATA_EXTENSIONS.has(extension)) {
        continue;
      }

      sources.push({
        sourceKey: `case_evidence:${sourcePath}:metadata`,
        sourceGroup,
        sourceType: 'case_evidence_asset',
        sourcePath,
        title,
        heading,
        content: [
          `${caseName} evidence asset ${title}.`,
          `Relative path: ${sourcePath}.`,
          `File type: ${extension.replace(/^\./, '') || 'unknown'}.`,
        ].join(' '),
        lastModifiedMs: stat.mtimeMs,
        metadata: {
          caseName,
          extension,
          indexedMode: 'metadata',
          sizeBytes: stat.size,
        },
      });
    }
  }

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
    const db = openDatabase(this.dbPath, { allowExtension: true });
    try {
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
      ...buildEvidenceSources(this.paths, options),
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

  getDocumentById(documentId) {
    const normalizedId = Number(documentId);
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) return null;
    return this.init().prepare(`
      SELECT * FROM memory_documents WHERE document_id = ? LIMIT 1
    `).get(normalizedId) || null;
  }

  async updateDocument(documentId, patch = {}) {
    const normalizedId = Number(documentId);
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      return { ok: false, reason: 'document_id_required' };
    }

    const existing = this.getDocumentById(normalizedId);
    if (!existing) {
      return { ok: false, reason: 'document_not_found', documentId: normalizedId };
    }

    const nextContent = normalizeWhitespace(
      Object.prototype.hasOwnProperty.call(patch, 'content')
        ? patch.content
        : existing.content
    );
    if (!nextContent) {
      return { ok: false, reason: 'content_required', documentId: normalizedId };
    }

    const nowMs = Number.isFinite(Number(patch.nowMs)) ? Math.floor(Number(patch.nowMs)) : Date.now();
    const nextMetadata = patch.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata)
      ? patch.metadata
      : (() => { try { return existing.metadata_json ? JSON.parse(existing.metadata_json) : {}; } catch { return {}; } })();
    const nextTitle = Object.prototype.hasOwnProperty.call(patch, 'title') ? patch.title : existing.title;
    const nextHeading = Object.prototype.hasOwnProperty.call(patch, 'heading') ? patch.heading : existing.heading;
    const nextSourceType = Object.prototype.hasOwnProperty.call(patch, 'sourceType') ? patch.sourceType : existing.source_type;
    const nextSourcePath = Object.prototype.hasOwnProperty.call(patch, 'sourcePath') ? patch.sourcePath : existing.source_path;
    const nextConfidence = Number.isFinite(Number(patch.confidence)) ? Number(patch.confidence) : Number(existing.confidence || 0.5);
    const nextAccessCount = Number.isFinite(Number(patch.accessCount)) ? Math.max(0, Math.floor(Number(patch.accessCount))) : Number(existing.access_count || 0);
    const nextLastAccessedAtMs = Object.prototype.hasOwnProperty.call(patch, 'lastAccessedAtMs')
      ? (patch.lastAccessedAtMs == null ? null : Math.floor(Number(patch.lastAccessedAtMs)))
      : (existing.last_accessed_at_ms == null ? null : Number(existing.last_accessed_at_ms));
    const nextLastModifiedMs = Number.isFinite(Number(patch.lastModifiedMs))
      ? Math.floor(Number(patch.lastModifiedMs))
      : nowMs;
    const vector = await this.getEmbedder().then((embedder) => embedder.embed(nextContent));
    const db = this.init();

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(`
        UPDATE memory_documents
        SET source_type = ?,
            source_path = ?,
            title = ?,
            heading = ?,
            content = ?,
            content_hash = ?,
            last_modified_ms = ?,
            metadata_json = ?,
            confidence = ?,
            access_count = ?,
            last_accessed_at_ms = ?,
            updated_at_ms = ?
        WHERE document_id = ?
      `).run(
        nextSourceType,
        nextSourcePath,
        nextTitle,
        nextHeading,
        nextContent,
        sha256(nextContent),
        nextLastModifiedMs,
        JSON.stringify(nextMetadata),
        nextConfidence,
        nextAccessCount,
        nextLastAccessedAtMs,
        nowMs,
        normalizedId
      );
      db.prepare('DELETE FROM memory_documents_fts WHERE rowid = ?').run(BigInt(normalizedId));
      db.prepare(`
        INSERT INTO memory_documents_fts (rowid, title, heading, content, source_path, source_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(BigInt(normalizedId), nextTitle, nextHeading, nextContent, nextSourcePath, nextSourceType);
      db.prepare('DELETE FROM memory_documents_vec WHERE rowid = ?').run(BigInt(normalizedId));
      db.prepare(`
        INSERT INTO memory_documents_vec (rowid, embedding) VALUES (?, ?)
      `).run(BigInt(normalizedId), JSON.stringify(vector));
      db.exec('COMMIT;');
      return {
        ok: true,
        document: this.getDocumentById(normalizedId),
      };
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw err;
    }
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

    const nowMs = Date.now();
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
      const existing = combined.get(id) || {
        documentId: id,
        score: 0,
        keywordScore: 0,
        semanticScore: 0,
        keywordRank: null,
        semanticRank: null,
      };
      existing.keywordRank = index + 1;
      existing.keywordScore = 1 / (rrfK + index + 1);
      combined.set(id, existing);
    });

    semanticRows.forEach((row, index) => {
      const id = Number(row.document_id);
      const existing = combined.get(id) || {
        documentId: id,
        score: 0,
        keywordScore: 0,
        semanticScore: 0,
        keywordRank: null,
        semanticRank: null,
      };
      existing.semanticRank = index + 1;
      existing.distance = Number(row.distance);
      existing.semanticScore = 1 / (rrfK + index + 1);
      combined.set(id, existing);
    });

    const documentIds = Array.from(combined.keys());
    const documents = this.getDocumentsByIds(documentIds);
    const docsById = new Map(documents.map((row) => [Number(row.document_id), row]));
    const results = Array.from(combined.values())
      .map((entry) => {
        const doc = docsById.get(entry.documentId);
        if (!doc) return null;
        const signals = computeDocumentMatchSignals(doc, trimmedQuery);
        const keywordScore = Number(entry.keywordScore || 0);
        const semanticScore = Number(entry.semanticScore || 0);
        const baseScore = (
          (keywordScore * DEFAULT_KEYWORD_WEIGHT)
          + (semanticScore * DEFAULT_SEMANTIC_WEIGHT)
          + (signals.tokenCoverage * DEFAULT_TOKEN_COVERAGE_WEIGHT)
          + (signals.phraseMatch ? DEFAULT_PHRASE_MATCH_WEIGHT : 0)
          + (signals.titleMatch ? DEFAULT_TITLE_MATCH_WEIGHT : 0)
          + (signals.headingMatch ? DEFAULT_HEADING_MATCH_WEIGHT : 0)
          - ((signals.matchedTokenCount === 0 && keywordScore === 0 && semanticScore > 0)
            ? DEFAULT_SEMANTIC_ONLY_PENALTY
            : 0)
        );
        const recencyMultiplier = computeRecencyMultiplier(
          Math.max(Number(doc.last_modified_ms || 0), Number(doc.created_at_ms || 0)),
          nowMs
        );
        const score = baseScore * recencyMultiplier;
        return {
          documentId: entry.documentId,
          score: Number(score.toFixed(8)),
          keywordScore: Number(keywordScore.toFixed(8)),
          semanticScore: Number(semanticScore.toFixed(8)),
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
          matchSignals: signals,
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
  createExcerpt,
  parseMarkdownTable,
  buildKnowledgeSources,
  buildSessionHandoffSources,
  buildEvidenceSources,
  MemorySearchIndex,
};


