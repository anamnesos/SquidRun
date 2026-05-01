'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getProjectRoot, resolveCoordPath } = require('../config');
const { stripRecallBlocks } = require('./memory-recall');

const DEFAULT_INDEX_RELATIVE_PATH = path.join('runtime', 'transcript-index.jsonl');
const DEFAULT_META_RELATIVE_PATH = path.join('runtime', 'transcript-index-meta.json');
const DEFAULT_MAX_ENTITIES = 24;

function resolveRuntimeFile(relativePath) {
  try {
    return resolveCoordPath(relativePath, { forWrite: true });
  } catch (_) {
    return path.join(getProjectRoot() || process.cwd(), '.squidrun', relativePath);
  }
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function trimText(value) {
  if (typeof value !== 'string') return '';
  return stripRecallBlocks(value).trim();
}

function slugProjectPath(projectRoot) {
  return String(projectRoot || '')
    .replace(/[:]/g, '-')
    .replace(/[\\/]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function resolveClaudeTranscriptProjectsDir(options = {}) {
  const explicit = trimText(options.projectsDir || process.env.SQUIDRUN_CLAUDE_PROJECTS_DIR);
  if (explicit) return path.resolve(explicit);

  const projectRoot = path.resolve(String(options.projectRoot || getProjectRoot() || process.cwd()));
  const slug = slugProjectPath(projectRoot);
  return path.join(os.homedir(), '.claude', 'projects', slug);
}

function resolveTranscriptIndexPaths(options = {}) {
  return {
    indexPath: path.resolve(String(options.indexPath || resolveRuntimeFile(DEFAULT_INDEX_RELATIVE_PATH))),
    metaPath: path.resolve(String(options.metaPath || resolveRuntimeFile(DEFAULT_META_RELATIVE_PATH))),
  };
}

function tokenizeQuery(value) {
  return String(value || '')
    .toLowerCase()
    .match(/[a-z0-9_\-./\\:]+/g) || [];
}

function extractTextFragments(content, options = {}) {
  const includeToolResults = options.includeToolResults === true;
  if (typeof content === 'string') {
    const text = trimText(content);
    return text ? [text] : [];
  }

  if (!Array.isArray(content)) return [];

  const fragments = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const type = trimText(item.type).toLowerCase();
    if (type === 'text') {
      const text = trimText(item.text);
      if (text) fragments.push(text);
      continue;
    }
    if (includeToolResults && type === 'tool_result') {
      const text = trimText(item.content);
      if (text) fragments.push(text);
    }
  }
  return fragments;
}

function normalizeConversationText(fragments) {
  return fragments
    .map((fragment) => trimText(fragment))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractEntities(text, options = {}) {
  const value = String(text || '');
  if (!value) return [];
  const entities = new Set();
  const patterns = [
    /[A-Za-z]:\\[^\n"'<>|]+/g,
    /\bconsultation-\d+-[a-z0-9]+\b/gi,
    /\b[A-Z]{2,10}\/USD\b/g,
    /\b(?:BTC|ETH|SOL|AVAX|LINK|DOGE|SPY|QQQ|GLD|TLT|XLE|WTI|GOLD)\b/g,
    /\b\d{2,4}-\d{2,4}-\d{2,6}\b/g,
    /\b\d{7,}\b/g,
    /\b(?:[A-Z][A-Z]+(?:\s+[A-Z][A-Z]+){1,4})\b/g,
    /\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\b/g,
  ];

  for (const pattern of patterns) {
    const matches = value.match(pattern) || [];
    for (const match of matches) {
      const normalized = trimText(match);
      if (normalized) entities.add(normalized);
    }
  }

  return Array.from(entities).slice(0, Number(options.maxEntities) || DEFAULT_MAX_ENTITIES);
}

function deriveTags(text, speaker = '') {
  const value = String(text || '');
  const lowered = value.toLowerCase();
  const tags = [];

  if (/(^|\b)(?:correction|actually|that's not|thats not|wrong|misremember|should be|not why|not true)/i.test(value)) {
    tags.push('correction');
  }
  if (/(^|\b)(?:decision:|priority:|must\b|need to\b|ship\b|blocker\b|critical\b|urgent\b)/i.test(value)) {
    tags.push('decision');
  }
  if (/(^|\b)(?:example shop|counterfeit|evidence|ExampleShop)/i.test(value)) {
    tags.push('example_shop_case');
  }
  if (/(^|\b)(?:ExampleProperty|property notice)/i.test(value)) {
    tags.push('example_property_case');
  }
  if (/(^|\b)(?:Example Contact|case contact)/i.test(value)) {
    tags.push('example_contact_case');
  }
  if (/(^|\b)(?:telegram|chat\s*2222222222|2222222222|Scoped|scoped|scoped-contact)/i.test(value)) {
    tags.push('telegram');
  }
  if (/(^|\b)(?:[private-live-ops]|macro regime|consultation|btc\/usd|eth\/usd)/i.test(value)) {
    tags.push('trading');
  }
  if (speaker === 'user' && lowered.includes('james')) {
    tags.push('user_reference');
  }

  return Array.from(new Set(tags));
}

function scoreRecordAgainstQuery(record, query) {
  const normalizedQuery = trimText(query).toLowerCase();
  if (!normalizedQuery) return 0;
  const text = String(record?.text || '').toLowerCase();
  const entities = toArray(record?.entities).map((entity) => String(entity).toLowerCase());
  const tags = toArray(record?.tags).map((tag) => String(tag).toLowerCase());
  const tokens = tokenizeQuery(normalizedQuery);
  let score = 0;

  if (text.includes(normalizedQuery)) score += 50;
  for (const token of tokens) {
    if (!token) continue;
    if (text.includes(token)) score += 8;
    if (entities.some((entity) => entity.includes(token))) score += 12;
    if (tags.some((tag) => tag.includes(token))) score += 6;
  }
  return score;
}

function buildExcerpt(text, query = '', maxChars = 280) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  const normalizedQuery = trimText(query).toLowerCase();
  const lowered = value.toLowerCase();
  if (!normalizedQuery) {
    return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
  }

  const index = lowered.indexOf(normalizedQuery);
  if (index < 0 || value.length <= maxChars) {
    return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
  }

  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, index - half);
  const end = Math.min(value.length, start + maxChars);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < value.length ? '...' : '';
  return `${prefix}${value.slice(start, end).trim()}${suffix}`;
}

function parseClaudeTranscriptRecord(rawRecord, context = {}) {
  if (!rawRecord || typeof rawRecord !== 'object') return null;

  const topLevelType = trimText(rawRecord.type).toLowerCase();
  const message = rawRecord.message && typeof rawRecord.message === 'object' ? rawRecord.message : null;
  const role = trimText(message?.role).toLowerCase();
  const speaker = topLevelType === 'user' && role === 'user'
    ? 'user'
    : (topLevelType === 'assistant' && role === 'assistant' ? 'assistant' : '');
  if (!speaker) return null;

  const fragments = extractTextFragments(message?.content, { includeToolResults: false });
  if (fragments.length === 0 && typeof message?.content === 'string') {
    fragments.push(message.content);
  }

  const text = normalizeConversationText(fragments);
  if (!text) return null;

  const sourceFile = path.resolve(String(context.sourceFile || ''));
  const lineNumber = Number.parseInt(context.lineNumber, 10) || 0;
  const sessionId = trimText(rawRecord.sessionId) || trimText(context.sessionId) || path.basename(sourceFile, '.jsonl');
  const timestamp = trimText(rawRecord.timestamp) || null;
  const tags = deriveTags(text, speaker);
  const entities = extractEntities(text);
  const recordId = crypto
    .createHash('sha1')
    .update(`${sourceFile}:${lineNumber}:${speaker}:${timestamp || ''}:${text}`, 'utf8')
    .digest('hex');

  return {
    id: recordId,
    source: 'claude-project-transcript',
    sourceFile,
    sourceLineNumber: lineNumber,
    sourceCitation: `${sourceFile}:${lineNumber}`,
    sessionId,
    timestamp,
    speaker,
    text,
    entities,
    tags,
    metadata: {
      cwd: trimText(rawRecord.cwd) || null,
      uuid: trimText(rawRecord.uuid) || null,
      requestId: trimText(rawRecord.requestId) || null,
      gitBranch: trimText(rawRecord.gitBranch) || null,
      version: trimText(rawRecord.version) || null,
    },
  };
}

function listClaudeProjectTranscriptFiles(options = {}) {
  const projectsDir = resolveClaudeTranscriptProjectsDir(options);
  if (!fs.existsSync(projectsDir)) return [];
  return fs.readdirSync(projectsDir)
    .filter((name) => name.toLowerCase().endsWith('.jsonl'))
    .map((name) => path.join(projectsDir, name))
    .sort((left, right) => left.localeCompare(right));
}

function parseClaudeTranscriptFile(filePath, options = {}) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const records = [];
  const errors = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = trimText(lines[index]);
    if (!rawLine) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(rawLine);
    } catch (error) {
      errors.push({
        filePath,
        lineNumber: index + 1,
        message: error.message,
      });
      continue;
    }

    const record = parseClaudeTranscriptRecord(parsed, {
      sourceFile: filePath,
      lineNumber: index + 1,
      sessionId: path.basename(filePath, '.jsonl'),
      ...options,
    });
    if (record) records.push(record);
  }

  return { records, errors };
}

function buildTranscriptIndex(options = {}) {
  const transcriptFiles = options.files || listClaudeProjectTranscriptFiles(options);
  const { indexPath, metaPath } = resolveTranscriptIndexPaths(options);
  const allRecords = [];
  const errors = [];

  for (const filePath of transcriptFiles) {
    const result = parseClaudeTranscriptFile(filePath, options);
    allRecords.push(...result.records);
    errors.push(...result.errors);
  }

  ensureParentDir(indexPath);
  fs.writeFileSync(indexPath, allRecords.map((record) => JSON.stringify(record)).join('\n'));

  const summary = {
    ok: true,
    builtAt: new Date().toISOString(),
    transcriptDir: resolveClaudeTranscriptProjectsDir(options),
    transcriptFileCount: transcriptFiles.length,
    recordCount: allRecords.length,
    errorCount: errors.length,
    errors: errors.slice(0, 100),
    indexPath,
    metaPath,
    sessions: Array.from(new Set(allRecords.map((record) => record.sessionId).filter(Boolean))).length,
    speakers: {
      user: allRecords.filter((record) => record.speaker === 'user').length,
      assistant: allRecords.filter((record) => record.speaker === 'assistant').length,
    },
    taggedCounts: allRecords.reduce((acc, record) => {
      for (const tag of toArray(record.tags)) {
        acc[tag] = (acc[tag] || 0) + 1;
      }
      return acc;
    }, {}),
  };

  ensureParentDir(metaPath);
  fs.writeFileSync(metaPath, JSON.stringify(summary, null, 2));

  return {
    ...summary,
    records: options.includeRecords === true ? allRecords : undefined,
  };
}

function readTranscriptIndex(options = {}) {
  const { indexPath, metaPath } = resolveTranscriptIndexPaths(options);
  const records = [];
  if (fs.existsSync(indexPath)) {
    const lines = fs.readFileSync(indexPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = trimText(line);
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch (_) {
        // Skip corrupt lines and let metadata carry build errors.
      }
    }
  }
  const meta = fs.existsSync(metaPath)
    ? JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    : null;
  return { records, meta, indexPath, metaPath };
}

function searchTranscriptIndex(query, options = {}) {
  const limit = Math.max(1, Number.parseInt(options.limit, 10) || 10);
  const { records } = readTranscriptIndex(options);
  const ranked = records
    .map((record) => ({
      ...record,
      score: scoreRecordAgainstQuery(record, query),
    }))
    .filter((record) => record.score > 0)
    .sort((left, right) => right.score - left.score || String(right.timestamp || '').localeCompare(String(left.timestamp || '')))
    .slice(0, limit)
    .map((record) => ({
      ...record,
      excerpt: buildExcerpt(record.text, query),
    }));

  return {
    ok: true,
    query,
    count: ranked.length,
    results: ranked,
  };
}

module.exports = {
  DEFAULT_INDEX_RELATIVE_PATH,
  DEFAULT_META_RELATIVE_PATH,
  resolveClaudeTranscriptProjectsDir,
  resolveTranscriptIndexPaths,
  extractTextFragments,
  extractEntities,
  deriveTags,
  parseClaudeTranscriptRecord,
  listClaudeProjectTranscriptFiles,
  parseClaudeTranscriptFile,
  buildTranscriptIndex,
  readTranscriptIndex,
  searchTranscriptIndex,
  _internals: {
    slugProjectPath,
    tokenizeQuery,
    scoreRecordAgainstQuery,
    buildExcerpt,
  },
};
