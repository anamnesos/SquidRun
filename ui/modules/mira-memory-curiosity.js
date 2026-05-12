'use strict';

const fs = require('fs');
const path = require('path');
const { openDatabase } = require('./sqlite-compat');
const { resolveDefaultCognitiveMemoryDbPath } = require('./cognitive-memory-store');

const MIRA_MEMORY_CURIOSITY_SCHEMA = 'squidrun.mira.memory_curiosity_read_v0';

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function tokenize(value) {
  return trimText(value).toLowerCase().match(/[a-z0-9_]+/g) || [];
}

function selectColumns(existingColumns, candidates) {
  return candidates.filter((column) => existingColumns.has(column));
}

function valueFromRow(row, ...keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return null;
}

function excerpt(value, max = 220) {
  const text = trimText(value).replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

function scoreMemoryRow(row, queryTokens) {
  const haystack = [
    row.category,
    row.title,
    row.heading,
    row.source_type,
    row.source_path,
    row.content,
  ].map(trimText).join(' ').toLowerCase();
  const tokenHits = queryTokens.filter((token) => haystack.includes(token)).length;
  const confidence = Number(valueFromRow(row, 'confidence_score', 'confidence') || 0);
  const accessCount = Number(valueFromRow(row, 'access_count') || 0);
  return tokenHits + Math.min(1, confidence) + Math.min(1, accessCount / 20);
}

function readMiraMemoryCuriosity(payload = {}, options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || payload.projectRoot || process.cwd()));
  const dbPath = path.resolve(String(options.dbPath || payload.dbPath || resolveDefaultCognitiveMemoryDbPath({ projectRoot })));
  const query = trimText(payload.query || 'Mira current lane source action substrate continuity');
  const limit = Math.max(1, Math.min(12, Number(payload.limit || options.limit || 5) || 5));
  if (!fs.existsSync(dbPath)) {
    return {
      schema: MIRA_MEMORY_CURIOSITY_SCHEMA,
      ok: false,
      decision: 'unavailable_in_this_runtime',
      reason: 'memory_db_missing',
      db_path: dbPath,
      query,
      results: [],
      result_count: 0,
      no_mutation_performed: true,
    };
  }

  let db;
  try {
    db = openDatabase(dbPath);
    const nodeInfo = db.prepare("PRAGMA table_info('nodes')").all();
    const existingColumns = new Set(nodeInfo.map((row) => String(row.name || '')));
    if (!existingColumns.has('node_id') || !existingColumns.has('content')) {
      return {
        schema: MIRA_MEMORY_CURIOSITY_SCHEMA,
        ok: false,
        decision: 'unavailable_in_this_runtime',
        reason: 'memory_nodes_table_missing',
        db_path: dbPath,
        query,
        results: [],
        result_count: 0,
        no_mutation_performed: true,
      };
    }
    const columns = selectColumns(existingColumns, [
      'node_id',
      'category',
      'title',
      'heading',
      'source_type',
      'source_path',
      'content',
      'confidence_score',
      'access_count',
      'salience_score',
      'last_accessed_at',
      'last_reconsolidated_at',
      'updated_at_ms',
    ]);
    const orderParts = [];
    if (existingColumns.has('updated_at_ms')) orderParts.push('COALESCE(updated_at_ms, 0) DESC');
    if (existingColumns.has('last_accessed_at')) orderParts.push("COALESCE(last_accessed_at, '') DESC");
    if (existingColumns.has('last_reconsolidated_at')) orderParts.push("COALESCE(last_reconsolidated_at, '') DESC");
    orderParts.push('node_id ASC');
    const rows = db.prepare(`
      SELECT ${columns.map((column) => `"${column}"`).join(', ')}
      FROM nodes
      ORDER BY ${orderParts.join(', ')}
      LIMIT 200
    `).all();
    const queryTokens = tokenize(query);
    const results = rows
      .map((row) => ({
        nodeId: row.node_id,
        category: valueFromRow(row, 'category'),
        title: valueFromRow(row, 'title', 'heading'),
        heading: valueFromRow(row, 'heading'),
        sourceType: valueFromRow(row, 'source_type'),
        sourcePath: valueFromRow(row, 'source_path'),
        confidenceScore: Number(valueFromRow(row, 'confidence_score') || 0),
        accessCount: Number(valueFromRow(row, 'access_count') || 0),
        salienceScore: Number(valueFromRow(row, 'salience_score') || 0),
        contentExcerpt: excerpt(row.content),
        score: scoreMemoryRow(row, queryTokens),
      }))
      .filter((row) => row.score > 0 || queryTokens.length === 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
    return {
      schema: MIRA_MEMORY_CURIOSITY_SCHEMA,
      ok: true,
      decision: 'memory_retrieved_read_only',
      db_path: dbPath,
      query,
      result_count: results.length,
      results,
      no_mutation_performed: true,
      consequence_controls: {
        internal_only: true,
        read_only: true,
        memory_write_performed: false,
        lease_created: false,
        access_log_updated: false,
        external_send_performed: false,
      },
    };
  } catch (err) {
    return {
      schema: MIRA_MEMORY_CURIOSITY_SCHEMA,
      ok: false,
      decision: 'unavailable_in_this_runtime',
      reason: 'memory_read_failed',
      error: err?.message || String(err),
      db_path: dbPath,
      query,
      results: [],
      result_count: 0,
      no_mutation_performed: true,
    };
  } finally {
    try { if (db) db.close(); } catch {}
  }
}

module.exports = {
  MIRA_MEMORY_CURIOSITY_SCHEMA,
  readMiraMemoryCuriosity,
};
