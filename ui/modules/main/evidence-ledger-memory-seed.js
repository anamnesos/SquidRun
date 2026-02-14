/**
 * Evidence Ledger Memory Seed Utility
 * Imports context snapshot style state into decision memory.
 */

const crypto = require('crypto');

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeList(values) {
  return asArray(values).map((item) => asString(item, '')).filter(Boolean);
}

function toBody(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stableId(prefix, payload) {
  const hash = crypto.createHash('sha1')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 24);
  return `${prefix}_${hash}`;
}

function toMsFromDate(value, fallback = Date.now()) {
  const parsed = Date.parse(asString(value, ''));
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function buildArchitectureDecisions(architecture) {
  const arch = asObject(architecture);
  const rows = [];

  const directDecisions = asArray(arch.decisions);
  for (const item of directDecisions) {
    if (typeof item === 'string') {
      const title = asString(item, '');
      if (title) rows.push({ title, body: '' });
      continue;
    }
    const entry = asObject(item);
    const title = asString(entry.title, '');
    const body = asString(entry.body, '') || toBody(entry.description || entry.note || '');
    if (title) rows.push({ title, body });
  }

  const keys = Object.keys(arch).filter((key) => key !== 'decisions');
  for (const key of keys) {
    const value = arch[key];
    const keyTitle = asString(key, '');
    if (!keyTitle) continue;
    rows.push({
      title: `Architecture: ${keyTitle}`,
      body: toBody(value),
    });
  }

  return rows;
}

function deriveSeedRecords(contextSnapshot, options = {}) {
  const source = asObject(contextSnapshot);
  const sessionNumber = Number(source.session);
  const hasSessionNumber = Number.isInteger(sessionNumber) && sessionNumber > 0;
  const sessionId = asString(
    options.sessionId,
    hasSessionNumber ? `ses_seed_${sessionNumber}` : stableId('ses_seed', { date: source.date || null })
  );

  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const startedAtMs = Number.isFinite(Number(options.startedAtMs))
    ? Number(options.startedAtMs)
    : toMsFromDate(source.date, nowMs);

  const decisions = [];
  const pushDecision = (category, title, body, author = 'system', tags = []) => {
    const normalizedTitle = asString(title, '');
    if (!normalizedTitle) return;
    const normalizedBody = asString(body, '');
    const decisionId = stableId('dec_seed', {
      sessionId,
      category,
      title: normalizedTitle,
      body: normalizedBody,
    });
    decisions.push({
      decisionId,
      sessionId,
      category,
      title: normalizedTitle,
      body: normalizedBody || null,
      author,
      tags: ['seed', 'snapshot', ...tags],
      meta: {
        seededFrom: 'context-snapshot',
      },
    });
  };

  for (const note of normalizeList(source.important_notes)) {
    pushDecision('directive', note, '', 'user');
  }

  for (const item of normalizeList(source.completed)) {
    pushDecision('completion', item, '', 'system');
  }

  const roadmapEntries = new Set([
    ...normalizeList(source.roadmap),
    ...normalizeList(source.not_yet_done),
  ]);
  for (const item of roadmapEntries) {
    pushDecision('roadmap', item, '', 'architect');
  }

  const knownIssues = asObject(source.known_issues);
  for (const [title, rawValue] of Object.entries(knownIssues)) {
    pushDecision('issue', title, toBody(rawValue), 'analyst');
  }

  const architectureDecisions = buildArchitectureDecisions(source.architecture);
  for (const item of architectureDecisions) {
    pushDecision('architecture', item.title, item.body, 'architect');
  }

  return {
    session: {
      sessionId,
      sessionNumber: hasSessionNumber ? sessionNumber : 1,
      mode: asString(source.mode, 'PTY') || 'PTY',
      startedAtMs,
      summary: asString(source.status, ''),
      stats: asObject(source.stats),
      team: asObject(source.team),
      meta: {
        seededFrom: 'context-snapshot',
      },
    },
    decisions,
  };
}

function seedDecisionMemory(memory, contextSnapshot, options = {}) {
  if (!memory || typeof memory.recordDecision !== 'function') {
    return { ok: false, reason: 'memory_required' };
  }

  const records = deriveSeedRecords(contextSnapshot, options);
  const session = records.session;
  const result = {
    ok: true,
    sessionId: session.sessionId,
    sessionStarted: 0,
    sessionExisting: 0,
    sessionEnded: 0,
    inserted: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const start = memory.recordSessionStart(session);
  if (start?.ok) {
    result.sessionStarted += 1;
  } else if (start?.reason === 'conflict') {
    result.sessionExisting += 1;
  } else if (start?.ok === false) {
    result.failed += 1;
    result.errors.push({ stage: 'session-start', ...start });
  }

  for (const decision of records.decisions) {
    const record = memory.recordDecision(decision);
    if (record?.ok) {
      result.inserted += 1;
      continue;
    }
    if (record?.reason === 'conflict') {
      result.skipped += 1;
      continue;
    }
    result.failed += 1;
    result.errors.push({ stage: 'record-decision', decisionId: decision.decisionId, ...record });
  }

  if (options.markSessionEnded === true) {
    const end = memory.recordSessionEnd(session.sessionId, {
      endedAtMs: Number.isFinite(Number(options.endedAtMs)) ? Number(options.endedAtMs) : Date.now(),
      summary: asString(options.summary, '') || asString(contextSnapshot?.status, '') || null,
      stats: asObject(contextSnapshot?.stats),
      team: asObject(contextSnapshot?.team),
      meta: {
        seededFrom: 'context-snapshot',
      },
    });
    if (end?.ok) {
      result.sessionEnded += 1;
    } else if (end?.reason && end.reason !== 'not_found') {
      result.failed += 1;
      result.errors.push({ stage: 'session-end', ...end });
    }
  }

  return result;
}

module.exports = {
  stableId,
  deriveSeedRecords,
  seedDecisionMemory,
};
