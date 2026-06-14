'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');
const { gateHeadline } = require('../../scripts/hm-timeline-gate');

const HEADLINE_CACHE_SCHEMA = 'squidrun.human_timeline.headline_cache.v1';
const DEFAULT_CACHE_RELATIVE_PATH = path.join('runtime', 'human-timeline-headlines.json');

function asText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function ensureSentence(value) {
  const text = asText(value);
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function resolveHeadlineCachePath(options = {}) {
  if (options.headlineCachePath || options.cachePath) {
    return path.resolve(options.headlineCachePath || options.cachePath);
  }
  return resolveCoordPath(DEFAULT_CACHE_RELATIVE_PATH, { forWrite: true });
}

function emptyHeadlineCache(nowMs = Date.now()) {
  return {
    schema: HEADLINE_CACHE_SCHEMA,
    version: 1,
    updatedAt: new Date(nowMs).toISOString(),
    entries: {},
  };
}

function normalizeHeadlineCache(cache = {}) {
  const nowMs = Date.now();
  if (!cache || typeof cache !== 'object') return emptyHeadlineCache(nowMs);
  const entries = cache.entries && typeof cache.entries === 'object' ? cache.entries : {};
  return {
    schema: HEADLINE_CACHE_SCHEMA,
    version: 1,
    updatedAt: asText(cache.updatedAt) || new Date(nowMs).toISOString(),
    entries,
  };
}

function readHeadlineCache(options = {}) {
  if (options.headlineCache && typeof options.headlineCache === 'object') {
    return normalizeHeadlineCache(options.headlineCache);
  }
  const cachePath = resolveHeadlineCachePath(options);
  try {
    return normalizeHeadlineCache(JSON.parse(fs.readFileSync(cachePath, 'utf8')));
  } catch (_) {
    return emptyHeadlineCache();
  }
}

function writeHeadlineCache(cache, options = {}) {
  const cachePath = resolveHeadlineCachePath(options);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(normalizeHeadlineCache(cache), null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, cachePath);
  return cachePath;
}

function sourceKey(source = {}) {
  const kind = asText(source.kind || 'unknown').toLowerCase();
  const id = asText(source.id || source.sha || source.messageId || source.rowId);
  return id ? `${kind}:${id}` : null;
}

function sourceHash(source = {}) {
  return hashText(source.sourceText || source.text || source.subject || '');
}

function sourceFromCommit(commit = {}) {
  const sha = asText(commit.sha);
  if (!sha) return null;
  return {
    kind: 'git_commit',
    id: sha,
    sourceText: asText(commit.subject),
    atMs: commit.atMs || null,
  };
}

function sourceFromTimelineChangeEntry(entry = {}) {
  const sha = asText(entry.refs?.sha);
  if (!sha) return null;
  return {
    kind: 'git_commit',
    id: sha,
    sourceText: asText(entry.detail || entry.refs?.sourceText || entry.headline),
    atMs: entry.at || null,
  };
}

function sourceFromTaskAuditItem(item = {}) {
  const id = asText(item.id || item.itemId);
  if (!id) return null;
  return {
    kind: 'task_audit_item',
    id,
    sourceText: [
      item.title,
      item.nextAction,
      item.rationale,
    ].map(asText).filter(Boolean).join(' '),
    atMs: item.updatedAt || item.createdAt || item.timestamp || null,
  };
}

function cachedHeadlineForSource(source, options = {}) {
  const key = sourceKey(source);
  if (!key) return null;
  const cache = readHeadlineCache(options);
  const entry = cache.entries[key];
  if (!entry || entry.status !== 'approved') return null;
  if (entry.sourceHash !== sourceHash(source)) return null;
  const headline = ensureSentence(entry.headline);
  if (!headline) return null;
  return {
    ...entry,
    key,
    headline,
  };
}

function approveHeadlineCandidate(source, candidate, options = {}) {
  const key = sourceKey(source);
  const headline = ensureSentence(candidate);
  const nowMs = Number(options.nowMs) || Date.now();
  if (!key || !headline) {
    return { ok: false, status: 'rejected', key, headline, reason: 'missing_source_or_headline' };
  }
  const gate = gateHeadline(headline, source.sourceText || '');
  if (!gate.pass) {
    return { ok: false, status: 'rejected', key, headline, gate };
  }
  const cache = readHeadlineCache(options);
  const entry = {
    status: 'approved',
    key,
    kind: source.kind || 'unknown',
    sourceId: source.id || null,
    sourceHash: sourceHash(source),
    sourceText: asText(source.sourceText),
    headline,
    generatedBy: asText(options.generatedBy) || 'human_timeline_headline_generator',
    approvedAt: new Date(nowMs).toISOString(),
    gate,
  };
  cache.entries[key] = entry;
  cache.updatedAt = entry.approvedAt;
  if (options.write !== false) writeHeadlineCache(cache, options);
  return { ok: true, status: 'approved', key, entry, cache };
}

async function refreshHeadlineCache(sources = [], options = {}) {
  const generateHeadline = options.generateHeadline;
  if (typeof generateHeadline !== 'function') {
    throw new Error('refreshHeadlineCache requires options.generateHeadline');
  }
  const results = [];
  for (const source of sources) {
    const key = sourceKey(source);
    if (!key) {
      results.push({ ok: false, status: 'skipped', reason: 'missing_source_key' });
      continue;
    }
    const cached = cachedHeadlineForSource(source, options);
    if (cached && options.force !== true) {
      results.push({ ok: true, status: 'cached', key, entry: cached });
      continue;
    }
    const candidate = await generateHeadline(source);
    results.push(approveHeadlineCandidate(source, candidate, options));
  }
  return {
    ok: results.every((result) => result.ok || result.status === 'cached'),
    results,
  };
}

module.exports = {
  HEADLINE_CACHE_SCHEMA,
  approveHeadlineCandidate,
  cachedHeadlineForSource,
  emptyHeadlineCache,
  readHeadlineCache,
  refreshHeadlineCache,
  resolveHeadlineCachePath,
  sourceKey,
  sourceHash,
  sourceFromCommit,
  sourceFromTaskAuditItem,
  sourceFromTimelineChangeEntry,
  writeHeadlineCache,
};
