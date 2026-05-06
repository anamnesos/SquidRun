'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEFAULT_PROFILE,
  namespaceCoordRelPath,
  normalizeProfileName,
} = require('../../profile');

const SCHEMA_VERSION = 'squidrun.mira_core.snapshot.v0';
const REDACTION_POLICY_VERSION = 'mira-core-redaction-v0';
const DEFAULT_LIMITS = Object.freeze({
  canonicalFiles: 8,
  claims: 12,
  memoryObjects: 12,
  recentComms: 12,
  recentInjections: 8,
  handoffPackets: 6,
  compactionSurvival: 6,
  cognitiveNodes: 6,
});

const SYNC_ELIGIBILITY = Object.freeze({
  SAFE: 'core_sync_safe',
  REDACTED: 'core_sync_redacted',
  APPROVAL: 'approval_required',
  LOCAL_ONLY: 'local_only',
  BLOCKED: 'blocked',
});

const REDACTION_STATUS = Object.freeze({
  NONE: 'none',
  REQUIRED: 'required',
  APPLIED: 'applied',
  BLOCKED: 'blocked',
});

const ROLE_PANES = Object.freeze({
  architect: '1',
  builder: '2',
  oracle: '3',
});

let SQLITE_DRIVER = undefined;

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function normalizeProjectRoot(projectRoot) {
  const resolved = path.resolve(String(projectRoot || process.cwd()));
  if (
    safeStat(path.join(resolved, 'ui'))?.isDirectory()
    && safeStat(path.join(resolved, 'ui', 'package.json'))?.isFile()
  ) {
    return resolved;
  }
  if (
    path.basename(resolved).toLowerCase() === 'ui'
    && safeStat(path.join(resolved, 'package.json'))?.isFile()
    && safeStat(path.join(resolved, 'modules'))?.isDirectory()
  ) {
    return path.dirname(resolved);
  }
  if (path.basename(resolved).toLowerCase() === '.squidrun') {
    const parent = path.dirname(resolved);
    if (safeStat(path.join(parent, 'ui', 'package.json'))?.isFile()) {
      return parent;
    }
  }
  return resolved;
}

function projectRel(projectRoot, filePath) {
  if (!filePath) return null;
  const relPath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  if (!relPath || relPath === '.') return '.';
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
    return {
      value: 'local_only',
      reason: 'outside_project_root',
    };
  }
  return relPath;
}

function coordPath(projectRoot, relPath, profileName) {
  return path.join(
    projectRoot,
    '.squidrun',
    namespaceCoordRelPath(relPath, normalizeProfileName(profileName || DEFAULT_PROFILE))
  );
}

function readJsonFile(filePath) {
  const stat = safeStat(filePath);
  if (!stat || !stat.isFile()) {
    return {
      ok: false,
      state: 'missing',
      value: null,
      error: null,
      sizeBytes: 0,
      mtimeMs: null,
    };
  }
  try {
    return {
      ok: true,
      state: 'ok',
      value: JSON.parse(fs.readFileSync(filePath, 'utf8')),
      error: null,
      sizeBytes: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
    };
  } catch (err) {
    return {
      ok: false,
      state: 'degraded',
      value: null,
      error: err.message,
      sizeBytes: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
    };
  }
}

function sourceHealth(projectRoot, filePath, readResult, extra = {}) {
  return {
    state: readResult.state,
    ok: readResult.ok === true,
    path: projectRel(projectRoot, filePath),
    sizeBytes: Number(readResult.sizeBytes || 0),
    mtimeMs: readResult.mtimeMs || null,
    error: readResult.error || null,
    ...extra,
  };
}

function loadSqliteDriver() {
  if (SQLITE_DRIVER !== undefined) return SQLITE_DRIVER;

  try {
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') {
      SQLITE_DRIVER = {
        name: 'node:sqlite',
        createReadOnly(filename) {
          return new mod.DatabaseSync(filename, { readOnly: true });
        },
      };
      return SQLITE_DRIVER;
    }
  } catch {
    // Electron's Node runtime does not expose node:sqlite; fall back below.
  }

  try {
    const BetterSqlite3 = require('better-sqlite3');
    SQLITE_DRIVER = {
      name: 'better-sqlite3',
      createReadOnly(filename) {
        return new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
      },
    };
    return SQLITE_DRIVER;
  } catch {
    SQLITE_DRIVER = null;
    return SQLITE_DRIVER;
  }
}

function quoteSqlIdentifier(identifier) {
  return `"${String(identifier || '').replace(/"/g, '""')}"`;
}

function sqliteValue(db, sql, params = []) {
  return db.prepare(sql).get(...params);
}

function sqliteRows(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function tableExists(db, tableName) {
  const row = sqliteValue(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName]
  );
  return Boolean(row?.name);
}

function tableColumns(db, tableName) {
  if (!tableExists(db, tableName)) return new Set();
  return new Set(sqliteRows(db, `PRAGMA table_info(${quoteSqlIdentifier(tableName)})`)
    .map((row) => String(row.name || '')));
}

function countRows(db, tableName) {
  if (!tableExists(db, tableName)) return 0;
  const row = sqliteValue(db, `SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(tableName)}`);
  return Number(row?.count || 0);
}

function selectExistingColumns(db, tableName, preferredColumns = [], options = {}) {
  const columns = tableColumns(db, tableName);
  if (columns.size === 0) return [];
  const selected = preferredColumns.filter((column) => columns.has(column));
  if (selected.length === 0) return [];

  const orderColumn = (options.orderColumns || []).find((column) => columns.has(column));
  const whereClause = typeof options.whereClause === 'function'
    ? options.whereClause(columns)
    : '';
  const limit = Math.max(1, Math.floor(Number(options.limit || 10)));
  const orderSql = orderColumn
    ? ` ORDER BY ${quoteSqlIdentifier(orderColumn)} DESC`
    : '';
  const sql = [
    `SELECT ${selected.map(quoteSqlIdentifier).join(', ')}`,
    `FROM ${quoteSqlIdentifier(tableName)}`,
    whereClause ? `WHERE ${whereClause}` : '',
    orderSql,
    `LIMIT ${limit}`,
  ].filter(Boolean).join(' ');
  return sqliteRows(db, sql);
}

function inspectSqliteSource(projectRoot, filePath, tableNames = []) {
  const stat = safeStat(filePath);
  if (!stat || !stat.isFile()) {
    return {
      state: 'missing',
      ok: false,
      path: projectRel(projectRoot, filePath),
      sizeBytes: 0,
      mtimeMs: null,
      tables: {},
      error: null,
    };
  }

  let db = null;
  try {
    const driver = loadSqliteDriver();
    if (!driver) {
      return {
        state: 'blocked',
        ok: false,
        path: projectRel(projectRoot, filePath),
        sizeBytes: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs),
        tables: {},
        error: 'sqlite_driver_unavailable',
      };
    }
    db = driver.createReadOnly(filePath);
    const tables = {};
    for (const tableName of tableNames) {
      tables[tableName] = {
        exists: tableExists(db, tableName),
        rowCount: countRows(db, tableName),
      };
    }
    return {
      state: 'ok',
      ok: true,
      path: projectRel(projectRoot, filePath),
      sizeBytes: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
      tables,
      error: null,
    };
  } catch (err) {
    return {
      state: 'degraded',
      ok: false,
      path: projectRel(projectRoot, filePath),
      sizeBytes: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
      tables: {},
      error: err.message,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Read-only snapshotting should not fail because a close call failed.
    }
  }
}

function withSqliteReadOnly(filePath, fallback, fn) {
  const stat = safeStat(filePath);
  if (!stat || !stat.isFile()) return fallback;
  let db = null;
  try {
    const driver = loadSqliteDriver();
    if (!driver) return fallback;
    db = driver.createReadOnly(filePath);
    return fn(db);
  } catch {
    return fallback;
  } finally {
    try {
      db?.close();
    } catch {
      // best effort
    }
  }
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function truncateText(value, maxLength = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 15)).trimEnd()} [TRUNCATED]`;
}

function emptyRedactionCounts() {
  return {
    secretLike: 0,
    profileMismatch: 0,
    rawTranscript: 0,
    phoneOrCustomerLike: 0,
    credentialPath: 0,
    pemBlock: 0,
  };
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = Number(target[key] || 0) + Number(value || 0);
  }
  return target;
}

function redactText(value) {
  if (value === null || value === undefined) {
    return {
      text: '',
      status: REDACTION_STATUS.NONE,
      counts: emptyRedactionCounts(),
    };
  }

  let text = String(value);
  const counts = emptyRedactionCounts();
  const replacePattern = (pattern, replacement, countKey) => {
    text = text.replace(pattern, (match) => {
      counts[countKey] += 1;
      return typeof replacement === 'function' ? replacement(match) : replacement;
    });
  };

  replacePattern(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED_PEM_BLOCK]',
    'pemBlock'
  );
  replacePattern(
    /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|SESSION|AUTH|BEARER)[A-Z0-9_]*\s*=\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (match) => {
      const name = String(match).split('=')[0].trim();
      return `${name}=[REDACTED_SECRET]`;
    },
    'secretLike'
  );
  replacePattern(
    /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
    'Authorization: [REDACTED_TOKEN]',
    'secretLike'
  );
  replacePattern(
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g,
    'Bearer [REDACTED_TOKEN]',
    'secretLike'
  );
  replacePattern(
    /\b(?:sk|pk|rk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9]{18,}\b/gi,
    '[REDACTED_TOKEN]',
    'secretLike'
  );
  replacePattern(
    /\b[A-Za-z0-9+/=_-]{40,}\b/g,
    '[REDACTED_TOKEN]',
    'secretLike'
  );
  replacePattern(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi,
    '$1[REDACTED_CREDENTIALS]@',
    'secretLike'
  );
  replacePattern(
    /(?:^|[\s"'`])(?:[A-Za-z]:)?[\\/][^\s"'`]*(?:\.env|credentials|auth|cookie|session|token)[^\s"'`]*/gi,
    ' [REDACTED_CREDENTIAL_PATH]',
    'credentialPath'
  );
  replacePattern(
    /\b(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g,
    '[REDACTED_PHONE]',
    'phoneOrCustomerLike'
  );
  replacePattern(
    /\b\d{3}[\s.-]\d{4}\b/g,
    '[REDACTED_PHONE]',
    'phoneOrCustomerLike'
  );
  replacePattern(
    /\b(?:invoice|customer|address)\s*[:#]?\s*[A-Za-z0-9][A-Za-z0-9 .,#-]{8,80}/gi,
    '[REDACTED_CUSTOMER_TEXT]',
    'phoneOrCustomerLike'
  );

  const applied = Object.values(counts).some((count) => Number(count || 0) > 0);
  return {
    text,
    status: applied ? REDACTION_STATUS.APPLIED : REDACTION_STATUS.NONE,
    counts,
  };
}

function summarizeRedacted(value, maxLength = 220) {
  const redacted = redactText(value);
  return {
    summary: truncateText(redacted.text, maxLength),
    redactionStatus: redacted.status,
    counts: redacted.counts,
  };
}

function classifyMiraCoreSnapshotCandidate(candidate = {}, options = {}) {
  const requestedProfile = normalizeProfileName(options.profileName || options.requestedProfile || DEFAULT_PROFILE);
  const candidateProfile = candidate.profile ? normalizeProfileName(candidate.profile) : requestedProfile;
  const body = firstString(candidate.body, candidate.summary, candidate.candidateClaim, candidate.intent, candidate.candidateSummary) || '';
  const redacted = summarizeRedacted(body, 180);
  const counts = emptyRedactionCounts();
  mergeCounts(counts, redacted.counts);
  const source = String(candidate.source || '').toLowerCase();

  if (candidateProfile !== requestedProfile) {
    counts.profileMismatch += 1;
    return {
      exportDecision: 'blocked_or_local_only',
      syncEligibility: SYNC_ELIGIBILITY.BLOCKED,
      redactionStatus: REDACTION_STATUS.BLOCKED,
      summary: 'Profile mismatch blocked by Snapshot v0.',
      blockedCounts: counts,
      requiredHealthSignal: 'profile_metadata_mismatch',
    };
  }

  if (source === 'terminal_scrollback') {
    counts.rawTranscript += 1;
    return {
      exportDecision: 'blocked_by_default',
      syncEligibility: SYNC_ELIGIBILITY.BLOCKED,
      redactionStatus: REDACTION_STATUS.BLOCKED,
      summary: `Terminal scrollback blocked by Snapshot v0; bodyHash=${stableHash(body).slice(0, 12)}`,
      blockedCounts: counts,
      rawBodyExported: false,
    };
  }

  if (source === 'screen_observation') {
    counts.rawTranscript += 1;
    return {
      exportDecision: 'blocked_by_default',
      syncEligibility: SYNC_ELIGIBILITY.BLOCKED,
      redactionStatus: REDACTION_STATUS.BLOCKED,
      summary: 'Screen observation blocked by Snapshot v0 unless a later task-scoped capture gate allows a redacted evidence ref.',
      blockedCounts: counts,
      rawBodyExported: false,
    };
  }

  if (source === 'future_core_intent') {
    const highRisk = /\b(deploy|send|customer|trade|payment|delete|webhook|auth|secret|production)\b/i.test(body);
    return {
      exportDecision: highRisk ? 'report_only_or_approval_required' : 'report_only',
      syncEligibility: highRisk ? SYNC_ELIGIBILITY.APPROVAL : SYNC_ELIGIBILITY.SAFE,
      redactionStatus: redacted.redactionStatus,
      summary: highRisk ? 'High-risk future intent remains report-only in Snapshot v0.' : redacted.summary,
      riskTier: highRisk ? 'tier3_external_side_effect' : 'tier0_read_only',
      mustNotCreate: ['local job lease', 'server execution claim', 'customer send', 'deploy action'],
      blockedCounts: counts,
    };
  }

  if (source === 'memory_candidate' && candidate.counterEvidence) {
    return {
      exportDecision: 'do_not_export_as_fact',
      syncEligibility: SYNC_ELIGIBILITY.APPROVAL,
      redactionStatus: redacted.redactionStatus,
      summary: 'Memory candidate requires contested/rejected handling because counterevidence is present.',
      counterevidence_checked: true,
      blockedCounts: counts,
    };
  }

  if (source === 'cognitive_memory') {
    return {
      exportDecision: 'approval_required_or_session_scoped',
      syncEligibility: eligibilityForRedaction(SYNC_ELIGIBILITY.APPROVAL, redacted.redactionStatus),
      redactionStatus: redacted.redactionStatus === REDACTION_STATUS.APPLIED
        ? REDACTION_STATUS.REQUIRED
        : REDACTION_STATUS.NONE,
      summary: redacted.summary,
      requiredEvalCoverage: [
        'Suite B anti-flattery',
        'Suite C false-memory refusal',
        'Suite E self-profile-vs-James-profile boundary',
      ],
      blockedCounts: counts,
    };
  }

  if (source === 'comms_journal') {
    counts.rawTranscript += 1;
    return {
      exportDecision: 'ref_or_redacted_excerpt_only',
      syncEligibility: eligibilityForRedaction(SYNC_ELIGIBILITY.SAFE, redacted.redactionStatus),
      redactionStatus: redacted.redactionStatus,
      summary: redacted.redactionStatus === REDACTION_STATUS.APPLIED
        ? `Comms body withheld/redacted; bodyHash=${stableHash(body).slice(0, 12)}`
        : truncateText(redacted.summary, 180),
      blockedCounts: counts,
      rawBodyExported: false,
    };
  }

  return {
    exportDecision: redacted.redactionStatus === REDACTION_STATUS.APPLIED ? 'redact_or_block' : 'export_summary',
    syncEligibility: eligibilityForRedaction(SYNC_ELIGIBILITY.SAFE, redacted.redactionStatus),
    redactionStatus: redacted.redactionStatus,
    summary: redacted.summary,
    blockedCounts: counts,
  };
}

function parseJsonMaybe(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function deriveSessionId(appStatus) {
  return firstString(
    appStatus?.session_id,
    appStatus?.sessionId,
    appStatus?.appSessionId,
    appStatus?.sessionScopeId
  ) || (Number.isFinite(Number(appStatus?.session))
    ? `session-${Number(appStatus.session)}`
    : 'unknown');
}

function detectHiddenPaneReadiness(appStatus) {
  const readyPanes = new Set();
  const candidates = [
    appStatus?.readyPanes,
    appStatus?.hiddenPaneHost?.readyPanes,
    appStatus?.paneHost?.readyPanes,
    appStatus?.panesReady,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const value of candidate) readyPanes.add(String(value));
    }
  }

  const panes = appStatus?.panes && typeof appStatus.panes === 'object'
    ? appStatus.panes
    : {};
  for (const [paneId, pane] of Object.entries(panes)) {
    if (
      pane?.ready === true
      || pane?.hiddenHostReady === true
      || pane?.status === 'ready'
      || pane?.routeStatus === 'ready'
    ) {
      readyPanes.add(String(paneId));
    }
  }

  if (
    appStatus?.hiddenHostReady === true
    || appStatus?.hiddenPaneHost?.ready === true
    || appStatus?.paneHost?.ready === true
  ) {
    readyPanes.add('1');
    readyPanes.add('2');
    readyPanes.add('3');
  }

  return readyPanes;
}

function createItem(base, context) {
  return {
    id: String(base.id || `${base.kind || 'item'}:${stableHash(base.summary || '').slice(0, 12)}`),
    kind: base.kind || 'item',
    summary: base.summary || '',
    source: base.source || {},
    authority: base.authority || 'derived',
    syncEligibility: base.syncEligibility || SYNC_ELIGIBILITY.LOCAL_ONLY,
    redactionStatus: base.redactionStatus || REDACTION_STATUS.NONE,
    profile: context.profileName,
    sessionId: base.sessionId || context.sessionId || 'unknown',
    deviceId: base.deviceId || context.deviceId || 'unknown',
    freshnessAt: firstNumber(base.freshnessAt, context.nowMs) || null,
    confidence: firstNumber(base.confidence, 0.5),
    evidenceRefs: Array.isArray(base.evidenceRefs) ? base.evidenceRefs : [],
    ...(base.extra && typeof base.extra === 'object' ? base.extra : {}),
  };
}

function eligibilityForRedaction(defaultEligibility, redactionStatus) {
  if (redactionStatus === REDACTION_STATUS.BLOCKED) return SYNC_ELIGIBILITY.BLOCKED;
  if (redactionStatus === REDACTION_STATUS.APPLIED) return SYNC_ELIGIBILITY.REDACTED;
  return defaultEligibility;
}

function eligibilityForClaim(row, redactionStatus) {
  if (redactionStatus === REDACTION_STATUS.APPLIED) return SYNC_ELIGIBILITY.REDACTED;
  const claimType = String(row.claim_type || '').toLowerCase();
  if (claimType === 'fact' || claimType === 'decision') return SYNC_ELIGIBILITY.SAFE;
  return SYNC_ELIGIBILITY.APPROVAL;
}

function eligibilityForMemory(row, redactionStatus) {
  if (redactionStatus === REDACTION_STATUS.APPLIED) return SYNC_ELIGIBILITY.REDACTED;
  const memoryClass = String(row.memory_class || '').toLowerCase();
  if (memoryClass === 'user_preference') return SYNC_ELIGIBILITY.APPROVAL;
  if (memoryClass === 'system_health_state' || memoryClass === 'codebase_inventory') {
    return SYNC_ELIGIBILITY.SAFE;
  }
  if (
    memoryClass === 'active_task_state'
    || memoryClass === 'cross_device_handoff'
    || memoryClass === 'solution_trace'
    || memoryClass === 'historical_outcome'
    || memoryClass === 'architecture_decision'
    || memoryClass === 'procedural_rule'
    || memoryClass === 'environment_quirk'
  ) {
    return SYNC_ELIGIBILITY.REDACTED;
  }
  return SYNC_ELIGIBILITY.APPROVAL;
}

function buildCanonicalFiles(projectRoot, context, redactionCounts, limit) {
  const files = [];
  const candidates = [
    'ROLES.md',
    'AGENTS.md',
    'workspace/specs/mira-core-architecture.md',
    'workspace/specs/mira-core-evals.md',
  ];
  const knowledgeRoot = path.join(projectRoot, 'workspace', 'knowledge');
  if (safeStat(knowledgeRoot)?.isDirectory()) {
    const knowledgeFiles = fs.readdirSync(knowledgeRoot)
      .filter((name) => /\.md$/i.test(name))
      .sort()
      .map((name) => path.join('workspace', 'knowledge', name));
    candidates.push(...knowledgeFiles);
  }

  for (const relPath of candidates.slice(0, limit)) {
    const absPath = path.join(projectRoot, relPath);
    const stat = safeStat(absPath);
    if (!stat || !stat.isFile()) continue;
    let content = '';
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      content = '';
    }
    const redacted = summarizeRedacted(content.slice(0, 900), 260);
    mergeCounts(redactionCounts, redacted.counts);
    files.push(createItem({
      id: `canonical:${relPath.replace(/\\/g, '/')}`,
      kind: 'canonical_file',
      summary: redacted.summary,
      source: {
        store: 'canonical-file',
        table: null,
        sourcePath: relPath.replace(/\\/g, '/'),
        sha256: stableHash(content),
      },
      authority: 'canonical',
      syncEligibility: eligibilityForRedaction(SYNC_ELIGIBILITY.SAFE, redacted.redactionStatus),
      redactionStatus: redacted.redactionStatus,
      freshnessAt: Math.floor(stat.mtimeMs),
      confidence: 0.9,
      evidenceRefs: [{
        store: 'canonical-file',
        filePath: relPath.replace(/\\/g, '/'),
        relation: 'source_hash',
      }],
    }, context));
  }

  return files;
}

function readEvidenceLedger(evidencePath, context, redactionCounts, limits) {
  return withSqliteReadOnly(evidencePath, {
    ledgerWatermark: {
      db: 'evidence-ledger',
      lastRowId: 0,
      lastEventId: null,
      lastCommsMessageId: null,
    },
    recentComms: [],
  }, (db) => {
    let lastLedger = null;
    if (tableExists(db, 'ledger_events')) {
      const cols = tableColumns(db, 'ledger_events');
      const idCol = cols.has('row_id') ? 'row_id' : null;
      const orderCol = idCol || (cols.has('ts_ms') ? 'ts_ms' : null);
      if (orderCol) {
        lastLedger = sqliteValue(
          db,
          `SELECT ${['row_id', 'event_id', 'ts_ms'].filter((col) => cols.has(col)).map(quoteSqlIdentifier).join(', ')}
           FROM ledger_events ORDER BY ${quoteSqlIdentifier(orderCol)} DESC LIMIT 1`
        );
      }
    }

    let lastComms = null;
    const recentComms = [];
    if (tableExists(db, 'comms_journal')) {
      const commsCols = tableColumns(db, 'comms_journal');
      const orderCol = ['row_id', 'updated_at_ms', 'brokered_at_ms', 'sent_at_ms']
        .find((column) => commsCols.has(column));
      if (orderCol) {
        lastComms = sqliteValue(
          db,
          `SELECT ${['row_id', 'message_id', 'updated_at_ms', 'brokered_at_ms', 'sent_at_ms'].filter((col) => commsCols.has(col)).map(quoteSqlIdentifier).join(', ')}
           FROM comms_journal ORDER BY ${quoteSqlIdentifier(orderCol)} DESC LIMIT 1`
        );
      }
      const rows = selectExistingColumns(db, 'comms_journal', [
        'row_id',
        'message_id',
        'session_id',
        'sender_role',
        'target_role',
        'channel',
        'direction',
        'sent_at_ms',
        'brokered_at_ms',
        'raw_body',
        'body_hash',
        'body_bytes',
        'status',
        'ack_status',
        'error_code',
        'updated_at_ms',
      ], {
        orderColumns: ['brokered_at_ms', 'updated_at_ms', 'sent_at_ms', 'row_id'],
        limit: limits.recentComms,
      });
      for (const row of rows) {
        const bodySummary = summarizeRedacted(row.raw_body || '', 180);
        if (row.raw_body) {
          redactionCounts.rawTranscript += 1;
        }
        mergeCounts(redactionCounts, bodySummary.counts);
        recentComms.push(createItem({
          id: `comms:${row.message_id || row.row_id}`,
          kind: 'comms_ref',
          summary: bodySummary.redactionStatus === REDACTION_STATUS.APPLIED
            ? `Comms body withheld/redacted; bodyHash=${stableHash(row.raw_body || '').slice(0, 12)}`
            : (bodySummary.summary || `Comms ${row.status || 'recorded'} ${row.message_id || row.row_id}`),
          source: {
            store: 'evidence-ledger',
            table: 'comms_journal',
            sourcePath: `evidence-ledger:comms:${row.message_id || row.row_id}`,
            bodyHash: row.body_hash || (row.raw_body ? stableHash(row.raw_body) : null),
            bodyBytes: Number(row.body_bytes || 0),
          },
          authority: 'evidence',
          syncEligibility: eligibilityForRedaction(SYNC_ELIGIBILITY.SAFE, bodySummary.redactionStatus),
          redactionStatus: bodySummary.redactionStatus,
          sessionId: row.session_id || context.sessionId,
          freshnessAt: firstNumber(row.brokered_at_ms, row.updated_at_ms, row.sent_at_ms, context.nowMs),
          confidence: 0.9,
          evidenceRefs: [{
            store: 'evidence-ledger',
            eventId: row.message_id || String(row.row_id || ''),
            relation: 'records_delivery',
          }],
          extra: {
            senderRole: row.sender_role || null,
            targetRole: row.target_role || null,
            channel: row.channel || null,
            direction: row.direction || null,
            status: row.status || null,
            ackStatus: row.ack_status || null,
            errorCode: row.error_code || null,
            rawBodyExported: false,
          },
        }, context));
      }
    }

    return {
      ledgerWatermark: {
        db: 'evidence-ledger',
        lastRowId: Number(lastLedger?.row_id || lastComms?.row_id || 0),
        lastEventId: lastLedger?.event_id || null,
        lastCommsMessageId: lastComms?.message_id || null,
      },
      recentComms,
    };
  });
}

function evidenceRefsFromRow(row) {
  const refs = [];
  const resultRefs = parseJsonMaybe(row.result_refs_json, []);
  if (Array.isArray(resultRefs)) {
    for (const ref of resultRefs.slice(0, 4)) {
      if (typeof ref === 'string') {
        refs.push({ store: 'team-memory', eventId: ref, relation: 'supports' });
      } else if (ref && typeof ref === 'object') {
        refs.push({
          store: ref.store || ref.source || 'team-memory',
          eventId: ref.eventId || ref.event_id || ref.id || ref.ref || null,
          relation: ref.relation || 'supports',
        });
      }
    }
  }
  if (typeof row.source_trace === 'string' && row.source_trace.trim()) {
    refs.push({
      store: 'team-memory',
      eventId: truncateText(row.source_trace, 140),
      relation: 'source_trace',
    });
  }
  return refs;
}

function readTeamMemory(teamPath, context, redactionCounts, limits) {
  return withSqliteReadOnly(teamPath, {
    claims: [],
    memoryObjects: [],
    recentInjections: [],
    handoffPackets: [],
    compactionSurvival: [],
    recallFeedback: {
      resultSetCount: 0,
      feedbackCount: 0,
      topMissingSignals: [],
    },
  }, (db) => {
    const claims = [];
    for (const row of selectExistingColumns(db, 'claims', [
      'id',
      'statement',
      'claim_type',
      'owner',
      'confidence',
      'status',
      'session',
      'created_at',
      'updated_at',
    ], {
      orderColumns: ['updated_at', 'created_at'],
      limit: limits.claims,
      whereClause(columns) {
        return columns.has('status') ? "status != 'deprecated'" : '';
      },
    })) {
      const redacted = summarizeRedacted(row.statement || '', 220);
      mergeCounts(redactionCounts, redacted.counts);
      claims.push(createItem({
        id: `claim:${row.id}`,
        kind: 'claim',
        summary: redacted.summary,
        source: {
          store: 'team-memory',
          table: 'claims',
          sourcePath: `team-memory:claim:${row.id}`,
        },
        authority: 'structured',
        syncEligibility: eligibilityForClaim(row, redacted.redactionStatus),
        redactionStatus: redacted.redactionStatus,
        sessionId: row.session || context.sessionId,
        freshnessAt: firstNumber(row.updated_at, row.created_at, context.nowMs),
        confidence: firstNumber(row.confidence, 0.7),
        evidenceRefs: [{
          store: 'team-memory',
          eventId: row.id,
          relation: 'claim_record',
        }],
        extra: {
          claimType: row.claim_type || null,
          owner: row.owner || null,
          status: row.status || null,
        },
      }, context));
    }

    const memoryObjects = [];
    for (const row of selectExistingColumns(db, 'memory_objects', [
      'memory_id',
      'memory_class',
      'tier',
      'status',
      'authority_level',
      'content',
      'provenance_json',
      'source_trace',
      'confidence',
      'scope_json',
      'device_id',
      'session_id',
      'expires_at',
      'result_refs_json',
      'freshness_at',
      'updated_at',
      'claim_type',
      'lifecycle_state',
      'injection_count',
      'last_injected_at',
    ], {
      orderColumns: ['updated_at', 'freshness_at'],
      limit: limits.memoryObjects,
      whereClause(columns) {
        const clauses = [];
        if (columns.has('lifecycle_state')) clauses.push("lifecycle_state NOT IN ('archived', 'rejected')");
        if (columns.has('status')) clauses.push("status NOT IN ('rejected', 'expired')");
        return clauses.join(' AND ');
      },
    })) {
      const redacted = summarizeRedacted(row.content || '', 240);
      mergeCounts(redactionCounts, redacted.counts);
      memoryObjects.push(createItem({
        id: `memory:${row.memory_id}`,
        kind: 'memory_object',
        summary: redacted.summary,
        source: {
          store: 'team-memory',
          table: 'memory_objects',
          sourcePath: `team-memory:memory:${row.memory_id}`,
        },
        authority: row.authority_level || 'structured',
        syncEligibility: eligibilityForMemory(row, redacted.redactionStatus),
        redactionStatus: redacted.redactionStatus,
        sessionId: row.session_id || context.sessionId,
        deviceId: row.device_id || context.deviceId,
        freshnessAt: firstNumber(row.freshness_at, row.updated_at, context.nowMs),
        confidence: firstNumber(row.confidence, 0.7),
        evidenceRefs: evidenceRefsFromRow(row),
        extra: {
          memoryClass: row.memory_class || null,
          tier: row.tier || null,
          status: row.status || null,
          claimType: row.claim_type || null,
          lifecycleState: row.lifecycle_state || null,
          expiresAt: row.expires_at || null,
          injectionCount: Number(row.injection_count || 0),
          lastInjectedAt: row.last_injected_at || null,
        },
      }, context));
    }

    const recentInjections = [];
    for (const row of selectExistingColumns(db, 'memory_injection_events', [
      'injection_id',
      'pane_id',
      'agent_role',
      'session_id',
      'trigger_type',
      'trigger_event_id',
      'memory_id',
      'memory_class',
      'injection_reason',
      'source_tier',
      'authoritative',
      'confidence',
      'freshness_at',
      'status',
      'created_at',
      'updated_at',
    ], {
      orderColumns: ['created_at', 'updated_at'],
      limit: limits.recentInjections,
    })) {
      const redacted = summarizeRedacted(row.injection_reason || '', 180);
      mergeCounts(redactionCounts, redacted.counts);
      recentInjections.push(createItem({
        id: `injection:${row.injection_id}`,
        kind: 'memory_injection',
        summary: redacted.summary || `Injection ${row.injection_id}`,
        source: {
          store: 'team-memory',
          table: 'memory_injection_events',
          sourcePath: `team-memory:injection:${row.injection_id}`,
        },
        authority: 'delivery',
        syncEligibility: eligibilityForRedaction(SYNC_ELIGIBILITY.SAFE, redacted.redactionStatus),
        redactionStatus: redacted.redactionStatus,
        sessionId: row.session_id || context.sessionId,
        freshnessAt: firstNumber(row.freshness_at, row.updated_at, row.created_at, context.nowMs),
        confidence: firstNumber(row.confidence, 0.6),
        evidenceRefs: [{
          store: 'team-memory',
          eventId: row.trigger_event_id || row.injection_id,
          relation: 'delivery_memory',
        }],
        extra: {
          paneId: row.pane_id || null,
          agentRole: row.agent_role || null,
          triggerType: row.trigger_type || null,
          memoryId: row.memory_id || null,
          memoryClass: row.memory_class || null,
          status: row.status || null,
          modelProcessingProofRequired: true,
        },
      }, context));
    }

    const handoffPackets = [];
    for (const row of selectExistingColumns(db, 'memory_handoff_packets', [
      'packet_id',
      'source_memory_id',
      'session_id',
      'source_device',
      'target_device',
      'packet_json',
      'status',
      'expires_at_session',
      'sent_at',
      'received_at',
      'created_at',
      'updated_at',
    ], {
      orderColumns: ['updated_at', 'created_at'],
      limit: limits.handoffPackets,
    })) {
      const packet = parseJsonMaybe(row.packet_json, {});
      const redacted = summarizeRedacted(packet?.summary || row.packet_json || '', 200);
      mergeCounts(redactionCounts, redacted.counts);
      handoffPackets.push(createItem({
        id: `handoff:${row.packet_id}`,
        kind: 'handoff_packet',
        summary: redacted.summary || `Handoff ${row.packet_id}`,
        source: {
          store: 'team-memory',
          table: 'memory_handoff_packets',
          sourcePath: `team-memory:handoff:${row.packet_id}`,
        },
        authority: 'delivery',
        syncEligibility: eligibilityForRedaction(SYNC_ELIGIBILITY.REDACTED, redacted.redactionStatus),
        redactionStatus: redacted.redactionStatus,
        sessionId: row.session_id || context.sessionId,
        deviceId: row.source_device || context.deviceId,
        freshnessAt: firstNumber(row.updated_at, row.created_at, context.nowMs),
        confidence: 0.75,
        evidenceRefs: [{
          store: 'team-memory',
          eventId: row.packet_id,
          relation: 'handoff_packet',
        }],
        extra: {
          sourceMemoryId: row.source_memory_id || null,
          targetDevice: row.target_device || null,
          status: row.status || null,
          expiresAtSession: row.expires_at_session || null,
          rawPacketExported: false,
        },
      }, context));
    }

    const compactionSurvival = [];
    for (const row of selectExistingColumns(db, 'memory_compaction_survival', [
      'survival_id',
      'pane_id',
      'session_id',
      'note_memory_id',
      'summary_json',
      'status',
      'created_at',
      'updated_at',
    ], {
      orderColumns: ['updated_at', 'created_at'],
      limit: limits.compactionSurvival,
    })) {
      const summaryJson = parseJsonMaybe(row.summary_json, {});
      const redacted = summarizeRedacted(summaryJson?.summary || row.summary_json || '', 200);
      mergeCounts(redactionCounts, redacted.counts);
      compactionSurvival.push(createItem({
        id: `compaction:${row.survival_id}`,
        kind: 'compaction_survival',
        summary: redacted.summary || `Compaction survival ${row.survival_id}`,
        source: {
          store: 'team-memory',
          table: 'memory_compaction_survival',
          sourcePath: `team-memory:compaction:${row.survival_id}`,
        },
        authority: 'delivery',
        syncEligibility: eligibilityForRedaction(SYNC_ELIGIBILITY.REDACTED, redacted.redactionStatus),
        redactionStatus: redacted.redactionStatus,
        sessionId: row.session_id || context.sessionId,
        freshnessAt: firstNumber(row.updated_at, row.created_at, context.nowMs),
        confidence: 0.7,
        evidenceRefs: [{
          store: 'team-memory',
          eventId: row.survival_id,
          relation: 'compaction_survival',
        }],
        extra: {
          paneId: row.pane_id || null,
          noteMemoryId: row.note_memory_id || null,
          status: row.status || null,
          rawSummaryExported: false,
        },
      }, context));
    }

    const recallFeedback = {
      resultSetCount: countRows(db, 'memory_recall_sets'),
      feedbackCount: countRows(db, 'memory_recall_feedback_events'),
      topMissingSignals: [],
    };
    if (tableExists(db, 'memory_recall_feedback_events')) {
      const cols = tableColumns(db, 'memory_recall_feedback_events');
      if (cols.has('feedback_type')) {
        const reasonExpr = cols.has('reason') ? 'COALESCE(reason, feedback_type)' : 'feedback_type';
        const rows = sqliteRows(
          db,
          `SELECT ${reasonExpr} AS signal, COUNT(*) AS count
           FROM memory_recall_feedback_events
           WHERE feedback_type = 'missing'
           GROUP BY ${reasonExpr}
           ORDER BY count DESC, signal ASC
           LIMIT 5`
        );
        recallFeedback.topMissingSignals = rows.map((row) => ({
          signal: truncateText(row.signal || 'missing', 80),
          count: Number(row.count || 0),
        }));
      }
    }

    return {
      claims,
      memoryObjects,
      recentInjections,
      handoffPackets,
      compactionSurvival,
      recallFeedback,
    };
  });
}

function readCognitiveMemory(cognitivePath, context, redactionCounts, limits) {
  return withSqliteReadOnly(cognitivePath, {
    nodeCount: 0,
    selectedNodes: [],
  }, (db) => {
    const nodeTable = tableExists(db, 'nodes') ? 'nodes' : (tableExists(db, 'memory_nodes') ? 'memory_nodes' : null);
    if (!nodeTable) {
      return {
        nodeCount: 0,
        selectedNodes: [],
      };
    }
    const columns = tableColumns(db, nodeTable);
    const idCol = ['node_id', 'id', 'memory_id'].find((column) => columns.has(column));
    const contentCol = ['content', 'summary', 'text'].find((column) => columns.has(column));
    const updatedCol = ['updated_at', 'created_at', 'freshness_at'].find((column) => columns.has(column));
    const nodeCount = countRows(db, nodeTable);
    const selectedNodes = [];
    if (idCol && contentCol) {
      const rows = sqliteRows(
        db,
        `SELECT ${quoteSqlIdentifier(idCol)} AS id, ${quoteSqlIdentifier(contentCol)} AS content${updatedCol ? `, ${quoteSqlIdentifier(updatedCol)} AS updated_at` : ''}
         FROM ${quoteSqlIdentifier(nodeTable)}
         ${updatedCol ? `ORDER BY ${quoteSqlIdentifier(updatedCol)} DESC` : ''}
         LIMIT ${Math.max(1, Math.floor(Number(limits.cognitiveNodes || 6)))}`
      );
      for (const row of rows) {
        const redacted = summarizeRedacted(row.content || '', 180);
        mergeCounts(redactionCounts, redacted.counts);
        selectedNodes.push(createItem({
          id: `cognitive:${row.id}`,
          kind: 'cognitive_node',
          summary: redacted.summary,
          source: {
            store: 'cognitive-memory',
            table: nodeTable,
            sourcePath: `cognitive-memory:${row.id}`,
          },
          authority: 'derived',
          syncEligibility: eligibilityForRedaction(SYNC_ELIGIBILITY.APPROVAL, redacted.redactionStatus),
          redactionStatus: redacted.redactionStatus,
          freshnessAt: firstNumber(row.updated_at, context.nowMs),
          confidence: 0.45,
          evidenceRefs: [{
            store: 'cognitive-memory',
            eventId: String(row.id || ''),
            relation: 'derived_node',
          }],
        }, context));
      }
    }
    return {
      nodeCount,
      selectedNodes,
    };
  });
}

function summarizeMemoryConsistency(memoryConsistency) {
  if (memoryConsistency && typeof memoryConsistency === 'object' && !Array.isArray(memoryConsistency)) {
    return {
      status: memoryConsistency.status || (memoryConsistency.synced === true ? 'in_sync' : 'unknown'),
      missing: Number(
        memoryConsistency.missing
        ?? memoryConsistency.summary?.missingInCognitiveCount
        ?? memoryConsistency.summary?.missing
        ?? 0
      ),
      orphans: Number(
        memoryConsistency.orphans
        ?? memoryConsistency.summary?.orphanedNodeCount
        ?? memoryConsistency.summary?.orphans
        ?? 0
      ),
      duplicates: Number(
        memoryConsistency.duplicates
        ?? memoryConsistency.summary?.duplicateKnowledgeHashCount
        ?? memoryConsistency.summary?.duplicates
        ?? 0
      ),
      synced: memoryConsistency.synced === true,
      error: memoryConsistency.error || null,
    };
  }
  return {
    status: 'unknown',
    missing: 0,
    orphans: 0,
    duplicates: 0,
    synced: false,
    error: null,
  };
}

function buildBridgeHealth(bridgeStatus = null) {
  const source = bridgeStatus && typeof bridgeStatus === 'object' && !Array.isArray(bridgeStatus)
    ? bridgeStatus
    : {};
  const state = firstString(source.state, source.status, source.mode) || 'unknown';
  const enabled = source.enabled === true;
  const configured = source.configured === true || Boolean(source.relayUrl && source.deviceId);
  const connected = state === 'connected' || state === 'relay_connected' || source.connected === true;
  const discoveredRoles = Array.isArray(source.discoveredRoles)
    ? source.discoveredRoles.map((role) => String(role).toLowerCase())
    : (Array.isArray(source.roles) ? source.roles.map((role) => String(role).toLowerCase()) : []);
  const architectDiscovered = discoveredRoles.includes('architect') || source.architectRoleDiscovery === 'registered';

  return {
    ok: enabled && configured && connected && architectDiscovered,
    mode: enabled ? (connected ? 'connected' : 'connecting') : 'disabled',
    enabled,
    configured,
    connected,
    deviceId: firstString(source.deviceId, source.device_id) || null,
    relayUrl: firstString(source.relayUrl, source.relay_url) || null,
    architectRoleDiscovery: architectDiscovered ? 'registered' : 'unknown',
    targetProof: source.targetProof === true ? 'verified' : 'unverified',
  };
}

function buildLocalArms(appStatus, context) {
  const readyPanes = detectHiddenPaneReadiness(appStatus || {});
  const arms = {};
  for (const [role, paneId] of Object.entries(ROLE_PANES)) {
    const ready = readyPanes.has(String(paneId)) || readyPanes.has(role);
    arms[role] = createItem({
      id: `local-arm:${role}`,
      kind: 'local_arm',
      summary: `${role} pane ${ready ? 'ready' : 'unknown'} for local routing`,
      source: {
        store: 'app-status',
        table: null,
        sourcePath: `app-status:pane:${paneId}`,
      },
      authority: 'runtime',
      syncEligibility: SYNC_ELIGIBILITY.SAFE,
      redactionStatus: REDACTION_STATUS.NONE,
      freshnessAt: context.nowMs,
      confidence: ready ? 0.8 : 0.4,
      evidenceRefs: [{
        store: 'app-status',
        eventId: `pane:${paneId}`,
        relation: 'route_state',
      }],
      extra: {
        role,
        paneId,
        routeStatus: ready ? 'ready' : 'unknown',
        hiddenHostReady: ready,
        modelProcessingProofRequired: true,
      },
    }, context);
  }
  return arms;
}

function buildCapabilityState(localArms, appHealth, supervisorHealth, bridgeHealth) {
  const architectReady = localArms.architect?.hiddenHostReady === true;
  const builderOracleReady = localArms.builder?.hiddenHostReady === true && localArms.oracle?.hiddenHostReady === true;
  const anyLocalArmKnown = Object.values(localArms).some((arm) => arm.hiddenHostReady === true);
  const notes = [];
  if (!architectReady) notes.push('architect_route_unproven');
  if (!builderOracleReady) notes.push('builder_oracle_route_unproven');
  if (bridgeHealth.ok !== true) {
    notes.push('Bridge is green only with role-registration discovery plus target proof.');
  }
  notes.push('WebSocket or PTY acceptance is not recipient model-processing proof.');
  if (supervisorHealth.ok !== true) notes.push('supervisor_missing_or_degraded');

  return {
    canConverse: appHealth.ok === true || anyLocalArmKnown,
    canQueueIntent: true,
    canRouteToArchitect: architectReady,
    canRouteToBuilderOracle: builderOracleReady,
    canExecuteLocal: anyLocalArmKnown,
    canProveModelProcessing: anyLocalArmKnown,
    serverCanExecuteLocal: false,
    notes,
  };
}

function extractSupervisorHealth(supervisorStatus, nowMs) {
  const heartbeatMs = firstNumber(
    supervisorStatus?.heartbeatAtMs,
    supervisorStatus?.heartbeat_at_ms,
    supervisorStatus?.lastHeartbeatMs,
    supervisorStatus?.updatedAtMs
  );
  const pendingTasks = firstNumber(
    supervisorStatus?.pendingTasks,
    supervisorStatus?.queue?.pending,
    supervisorStatus?.tasks?.pending,
    0
  ) || 0;
  const runningTasks = firstNumber(
    supervisorStatus?.runningTasks,
    supervisorStatus?.queue?.running,
    supervisorStatus?.tasks?.running,
    0
  ) || 0;
  const blockedTasks = firstNumber(
    supervisorStatus?.blockedTasks,
    supervisorStatus?.queue?.blocked,
    supervisorStatus?.tasks?.blocked,
    0
  ) || 0;
  return {
    ok: Boolean(supervisorStatus) && (heartbeatMs === null || nowMs - heartbeatMs < 10 * 60 * 1000),
    heartbeatAgeMs: heartbeatMs === null ? null : Math.max(0, nowMs - heartbeatMs),
    pendingTasks,
    runningTasks,
    blockedTasks,
    workerCount: firstNumber(supervisorStatus?.workerCount, supervisorStatus?.workers?.total, 0) || 0,
  };
}

function buildMiraCoreSnapshot(options = {}) {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const profileName = normalizeProfileName(options.profileName || options.profile || DEFAULT_PROFILE);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const limits = {
    ...DEFAULT_LIMITS,
    ...(options.limits && typeof options.limits === 'object' ? options.limits : {}),
  };

  const appStatusPath = coordPath(projectRoot, 'app-status.json', profileName);
  const supervisorStatusPath = coordPath(projectRoot, path.join('runtime', 'supervisor-status.json'), profileName);
  const systemCapabilitiesPath = coordPath(projectRoot, path.join('runtime', 'system-capabilities.json'), profileName);
  const bridgeStatusPath = coordPath(projectRoot, path.join('runtime', 'bridge-status.json'), profileName);
  const memoryConsistencyPath = coordPath(projectRoot, path.join('runtime', 'memory-consistency.json'), profileName);
  const evidencePath = coordPath(projectRoot, path.join('runtime', 'evidence-ledger.db'), profileName);
  const teamMemoryPath = coordPath(projectRoot, path.join('runtime', 'team-memory.sqlite'), profileName);
  const cognitivePath = coordPath(projectRoot, path.join('runtime', 'cognitive-memory.db'), profileName);

  const appStatusRead = readJsonFile(appStatusPath);
  const supervisorRead = readJsonFile(supervisorStatusPath);
  const systemCapabilitiesRead = readJsonFile(systemCapabilitiesPath);
  const bridgeRead = options.bridgeStatus
    ? { ok: true, state: 'ok', value: options.bridgeStatus, error: null, sizeBytes: 0, mtimeMs: null }
    : readJsonFile(bridgeStatusPath);
  const memoryConsistencyRead = options.memoryConsistency
    ? { ok: true, state: 'ok', value: options.memoryConsistency, error: null, sizeBytes: 0, mtimeMs: null }
    : readJsonFile(memoryConsistencyPath);

  const evidenceHealth = inspectSqliteSource(projectRoot, evidencePath, ['ledger_events', 'comms_journal']);
  const teamMemoryHealth = inspectSqliteSource(projectRoot, teamMemoryPath, [
    'claims',
    'memory_objects',
    'memory_injection_events',
    'memory_handoff_packets',
    'memory_compaction_survival',
    'memory_recall_sets',
    'memory_recall_feedback_events',
  ]);
  const cognitiveHealth = inspectSqliteSource(projectRoot, cognitivePath, ['nodes', 'memory_nodes']);

  const appStatus = appStatusRead.value || {};
  const sessionId = deriveSessionId(appStatus);
  const deviceId = firstString(
    options.deviceId,
    appStatus?.deviceId,
    appStatus?.device_id,
    bridgeRead.value?.deviceId,
    process.env.SQUIDRUN_DEVICE_ID,
    os.hostname()
  ) || 'unknown';
  const context = {
    profileName,
    sessionId,
    deviceId,
    nowMs,
  };

  const redactionCounts = emptyRedactionCounts();
  const localArms = buildLocalArms(appStatus, context);
  const bridgeHealth = buildBridgeHealth(bridgeRead.value);
  const supervisorHealth = extractSupervisorHealth(supervisorRead.value, nowMs);
  const memoryConsistency = summarizeMemoryConsistency(memoryConsistencyRead.value);
  const canonicalFiles = buildCanonicalFiles(projectRoot, context, redactionCounts, limits.canonicalFiles);
  const evidenceMemory = readEvidenceLedger(evidencePath, context, redactionCounts, limits);
  const teamMemory = readTeamMemory(teamMemoryPath, context, redactionCounts, limits);
  const cognitiveMemory = readCognitiveMemory(cognitivePath, context, redactionCounts, limits);
  const appHealth = {
    ok: appStatusRead.ok === true,
    sessionNumber: firstNumber(appStatus?.session, appStatus?.session_number, appStatus?.sessionNumber),
    sessionId,
    hiddenPaneHost: Object.values(localArms).every((arm) => arm.hiddenHostReady === true)
      ? 'ready'
      : 'unknown',
    mode: firstString(appStatus?.mode, appStatus?.appMode) || 'unknown',
    error: appStatusRead.error || null,
  };
  const capabilityState = buildCapabilityState(localArms, appHealth, supervisorHealth, bridgeHealth);
  const settingsPath = path.join(projectRoot, 'ui', 'settings.json');
  const settingsRead = readJsonFile(settingsPath);
  const appVersion = (() => {
    const packageRead = readJsonFile(path.join(projectRoot, 'ui', 'package.json'));
    return firstString(appStatus?.version, packageRead.value?.version) || null;
  })();

  const source = {
    projectRoot: 'local_only',
    profileName,
    sourceHealth: {
      appStatus: sourceHealth(projectRoot, appStatusPath, appStatusRead),
      supervisorStatus: sourceHealth(projectRoot, supervisorStatusPath, supervisorRead),
      systemCapabilities: sourceHealth(projectRoot, systemCapabilitiesPath, systemCapabilitiesRead),
      bridgeStatus: options.bridgeStatus
        ? { state: 'ok', ok: true, path: 'option:bridgeStatus', sizeBytes: 0, mtimeMs: null, error: null }
        : sourceHealth(projectRoot, bridgeStatusPath, bridgeRead),
      memoryConsistency: options.memoryConsistency
        ? { state: 'ok', ok: true, path: 'option:memoryConsistency', sizeBytes: 0, mtimeMs: null, error: null }
        : sourceHealth(projectRoot, memoryConsistencyPath, memoryConsistencyRead),
      evidenceLedger: evidenceHealth,
      teamMemory: teamMemoryHealth,
      cognitiveMemory: cognitiveHealth,
      settings: sourceHealth(projectRoot, settingsPath, settingsRead),
    },
  };

  const queue = {
    localSupervisor: {
      pending: supervisorHealth.pendingTasks,
      running: supervisorHealth.runningTasks,
      blocked: supervisorHealth.blockedTasks,
    },
    coreIntentQueue: {
      enabled: false,
      pending: 0,
    },
  };

  const snapshotSeed = {
    schema: SCHEMA_VERSION,
    generatedAt,
    profileName,
    sessionId,
    deviceId,
    watermarks: evidenceMemory.ledgerWatermark,
    teamMemoryRows: teamMemoryHealth.tables,
    cognitiveRows: cognitiveMemory.nodeCount,
  };

  return {
    schema: SCHEMA_VERSION,
    snapshotId: `mira-snap-${nowMs}-${stableHash(snapshotSeed).slice(0, 12)}`,
    generatedAt,
    profile: {
      name: profileName,
      windowKey: profileName,
      sessionScopeId: sessionId,
      syncEligibility: SYNC_ELIGIBILITY.SAFE,
    },
    device: {
      deviceId,
      platform: process.platform,
      appVersion,
      localOnly: true,
    },
    source,
    capabilityState,
    localArms,
    health: {
      app: appHealth,
      supervisor: supervisorHealth,
      bridge: bridgeHealth,
      memoryConsistency,
    },
    memory: {
      canonical: {
        files: canonicalFiles,
      },
      episodic: {
        ledgerWatermark: evidenceMemory.ledgerWatermark,
        recentComms: evidenceMemory.recentComms,
      },
      structured: {
        claims: teamMemory.claims,
        memoryObjects: teamMemory.memoryObjects,
      },
      delivery: {
        recentInjections: teamMemory.recentInjections,
        handoffPackets: teamMemory.handoffPackets,
        compactionSurvival: teamMemory.compactionSurvival,
      },
      recallFeedback: teamMemory.recallFeedback,
      derived: {
        cognitive: cognitiveMemory,
      },
    },
    queue,
    redaction: {
      policyVersion: REDACTION_POLICY_VERSION,
      rawSecretsExported: false,
      rawTerminalExported: false,
      rawCommsExported: false,
      blockedCounts: redactionCounts,
    },
    serverMigration: {
      uploadSafe: false,
      reason: 'local_snapshot_contract_first',
      minimumServerPhase: 'phase_1_snapshot_upload',
    },
  };
}

module.exports = {
  DEFAULT_LIMITS,
  REDACTION_POLICY_VERSION,
  REDACTION_STATUS,
  SCHEMA_VERSION,
  SYNC_ELIGIBILITY,
  buildMiraCoreSnapshot,
  classifyMiraCoreSnapshotCandidate,
  coordPath,
  eligibilityForMemory,
  loadSqliteDriver,
  normalizeProjectRoot,
  projectRel,
  redactText,
};
