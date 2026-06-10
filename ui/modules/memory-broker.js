const crypto = require('crypto');

const DEFAULT_RRF_K = 60;
const DEFAULT_LIMIT = 6;
const DEFAULT_PROVIDER_LIMIT = 5;
const DEFAULT_PROVIDER_TIMEOUT_MS = 900;
const RECALL_START = '[SQUIDRUN MEMORY RECALL]';
const RECALL_END = '[/SQUIDRUN MEMORY RECALL]';
// Memory recall is noise on a trivial one-liner ("what up bro") — it staples 3
// stale session summaries onto a message that references no past work. Gate it:
// recall fires only when the inbound message is substantive (>= this length) OR
// contains a work-referencing token. Both numbers/patterns are tunable here.
const MEMORY_RECALL_MIN_MESSAGE_LENGTH = 24;
const MEMORY_RECALL_WORK_REFERENCE_PATTERN = new RegExp(
  [
    // trading vocabulary + common tickers James references
    'trade|trading|position|order|stop|pnl|wallet|funding|hyperliquid|alpaca',
    'btc|eth|sol|doge|hype|coin|price|long|short|market|chart',
    // build / runtime / ops vocabulary
    'squidrun|squid ?room|pane|arm|restart|commit|deploy|build|fix|bug|test|daemon',
    'memory|recall|status|update|progress|task|spec|gate|review',
    // products / cases / people
    'trustquote|plumbhalo|telegram|invoice|case|eunbyul|eunbyeol|은별|hillstate|qeline',
    // temporal / referential phrasing that points back at prior work
    'earlier|before|yesterday|last (session|time|night|week)|previous|remember|recall',
    "what about|where (are|is|did|were)|did you|how('?s| is| are) (the|it|things)|the one",
  ].join('|'),
  'i'
);

// Decide whether an inbound message plausibly references past work and should
// receive memory recall. Substantive (long) messages always qualify; short ones
// qualify only if they carry a work-referencing token. Trivial greetings/acks
// ("yo", "what up bro", "thanks") fall through to false → inject nothing.
function messageReferencesPastWork(message, options = {}) {
  const text = String(message || '').trim();
  if (!text) return false;
  const minLength = clampInt(options.minLength, MEMORY_RECALL_MIN_MESSAGE_LENGTH, 1, 4000);
  if (text.length >= minLength) return true;
  return MEMORY_RECALL_WORK_REFERENCE_PATTERN.test(text);
}
const PROFILE_SCOPE_KEYS = Object.freeze([
  'profile',
  'profileName',
  'profile_name',
  'windowKey',
  'window_key',
  'targetProfile',
  'target_profile',
  'sourceProfile',
  'source_profile',
]);
const EUNBYEOL_NAME_PATTERN = /\b(eunbyeol|eunbyul)\b|은별/i;
const EUNBYEOL_CASE_SCOPE_PATTERN = /\b(korean fraud|korean case|daegu|customs case|26-05-00420|profile:eunbyeol|window:eunbyeol|runtime-eunbyeol|context-snapshots-eunbyeol|app-status-eunbyeol|settings-eunbyeol)\b/i;
const CASE_SCOPE_PATTERN = /\b(casework|case work|case-note|case note|case_evidence|case evidence)\b/i;

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function oneLine(value, maxLength = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function clampInt(value, fallback, min = 1, max = 100) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .match(/[a-z0-9_./:-]+/g) || [];
}

function normalizeScopeValue(value) {
  return asText(value).toLowerCase();
}

function normalizeScopeList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeScopeValue(entry)).filter(Boolean);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).map((entry) => normalizeScopeValue(entry)).filter(Boolean);
  }
  return normalizeScopeValue(value).split(/[|, ]+/).map((entry) => entry.trim()).filter(Boolean);
}

function recallContextAllowsProfileScope(context = {}, profileKey = '') {
  const expected = normalizeScopeValue(profileKey);
  if (!expected || expected === 'main') return true;
  if (context.allowProfileScopedRecall === true || context.allowCaseRecall === true) return true;
  const candidates = [
    context.profile,
    context.profileName,
    context.profile_name,
    context.windowKey,
    context.window_key,
    context.targetProfile,
    context.target_profile,
    context.sourceProfile,
    context.source_profile,
  ].map((entry) => normalizeScopeValue(entry)).filter(Boolean);
  const sessionScopeId = normalizeScopeValue(context.sessionScopeId || context.session_scope_id);
  if (sessionScopeId && sessionScopeId.split(/[:/-]+/).includes(expected)) return true;
  return candidates.includes(expected);
}

function extractExplicitProfileScope(metadata = {}) {
  const meta = asObject(metadata);
  for (const key of PROFILE_SCOPE_KEYS) {
    const value = normalizeScopeValue(meta[key]);
    if (value && value !== 'main') return value;
  }
  const routing = asObject(meta.routing);
  for (const key of PROFILE_SCOPE_KEYS) {
    const value = normalizeScopeValue(routing[key]);
    if (value && value !== 'main') return value;
  }
  const scopes = normalizeScopeList(meta.scopes || meta.scope);
  if (scopes.includes('case') || scopes.includes('casework') || scopes.includes('case_scope')) {
    return 'case';
  }
  const profileScope = scopes.find((scope) => /^profile[:/-]/.test(scope) || /^window[:/-]/.test(scope));
  if (profileScope) {
    return profileScope.replace(/^(?:profile|window)[:/-]+/, '');
  }
  const sessionScopeId = normalizeScopeValue(meta.sessionScopeId || meta.session_scope_id || meta.sessionId || meta.session_id);
  const sessionParts = sessionScopeId.split(/[:/-]+/).filter(Boolean);
  const scopedPart = sessionParts
    .slice()
    .reverse()
    .find((part) => part && part !== 'app' && part !== 'session' && part !== 'test' && !/^\d+$/.test(part) && part !== 'main');
  return scopedPart || '';
}

function classifyRecallItemScope(item = {}) {
  const metadata = asObject(item.metadata);
  const explicitProfile = extractExplicitProfileScope(metadata);
  if (explicitProfile) {
    return {
      scoped: true,
      profile: explicitProfile,
      reason: 'explicit_profile_scope',
    };
  }

  const scopeText = [
    item.ref,
    item.title,
    item.excerpt,
    item.sourceKind,
    item.source,
    JSON.stringify(metadata),
  ].filter(Boolean).join(' ');

  if (EUNBYEOL_CASE_SCOPE_PATTERN.test(scopeText) || (EUNBYEOL_NAME_PATTERN.test(scopeText) && CASE_SCOPE_PATTERN.test(scopeText))) {
    return {
      scoped: true,
      profile: 'eunbyeol',
      reason: 'eunbyeol_case_scope',
    };
  }
  if (CASE_SCOPE_PATTERN.test(scopeText)) {
    return {
      scoped: true,
      profile: 'case',
      reason: 'case_scope',
    };
  }
  return {
    scoped: false,
    profile: '',
    reason: 'unscoped',
  };
}

function shouldIncludeRecallItemForContext(item = {}, context = {}) {
  const scope = classifyRecallItemScope(item);
  if (!scope.scoped) return true;
  return recallContextAllowsProfileScope(context, scope.profile);
}

function tokenCoverageScore(text, query) {
  const haystack = String(text || '').toLowerCase();
  const tokens = Array.from(new Set(tokenize(query))).slice(0, 16);
  if (tokens.length === 0) return 0;
  const matched = tokens.filter((token) => haystack.includes(token)).length;
  return matched / tokens.length;
}

function toMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function normalizeScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric;
}

function normalizeProviderItem(raw, provider, index) {
  const item = asObject(raw);
  const providerId = asText(provider.id, provider.source, item.source, item.provider, 'unknown');
  const sourceKind = asText(item.sourceKind, item.source_kind, provider.sourceKind, provider.source_kind, providerId);
  const id = asText(
    item.id,
    item.nodeId,
    item.node_id,
    item.claimId,
    item.claim_id,
    item.decisionId,
    item.decision_id,
    item.documentId,
    item.document_id,
    item.messageId,
    item.message_id,
    item.ref
  ) || `${providerId}:${index + 1}`;
  const ref = asText(
    item.ref,
    item.sourcePath,
    item.source_path,
    item.path,
    item.url,
    item.decisionId,
    item.claimId,
    item.nodeId,
    id
  );
  const title = oneLine(asText(
    item.title,
    item.heading,
    item.category,
    item.claimType,
    item.claim_type,
    item.type,
    ref,
    id
  ), 120);
  const excerpt = oneLine(asText(
    item.excerpt,
    item.summary,
    item.content,
    item.statement,
    item.body,
    item.text,
    title
  ), 260);
  const rawScore = normalizeScore(item.score ?? item.confidence ?? item.confidenceScore ?? item.confidence_score);
  const updatedAtMs = toMs(
    item.updatedAtMs
    ?? item.updated_at_ms
    ?? item.updatedAt
    ?? item.updated_at
    ?? item.createdAtMs
    ?? item.created_at_ms
    ?? item.createdAt
    ?? item.created_at
  );
  const canonicalKey = asText(item.canonicalKey, item.canonical_key);
  const key = canonicalKey || [
    sourceKind,
    id || ref || stableHash(`${title}\n${excerpt}`),
  ].join(':');
  const contentKey = asText(item.contentKey, item.content_key)
    || (ref ? `${sourceKind}:ref:${ref}` : `${sourceKind}:content:${stableHash(`${title}\n${excerpt}`)}`);

  return {
    key,
    contentKey,
    source: providerId,
    sourceKind,
    id,
    ref,
    title,
    excerpt,
    rawScore,
    providerRank: clampInt(item.rank, index + 1, 1, 10000),
    updatedAtMs,
    metadata: asObject(item.metadata),
  };
}

function normalizeProviderItems(rawResult, provider) {
  const result = asObject(rawResult);
  const items = Array.isArray(result.items)
    ? result.items
    : (Array.isArray(result.results)
      ? result.results
      : (Array.isArray(result.claims)
        ? result.claims
        : (Array.isArray(result.decisions) ? result.decisions : [])));

  return items
    .map((item, index) => normalizeProviderItem(item, provider, index))
    .filter((item) => item.excerpt || item.title || item.ref)
    .sort((left, right) => {
      const rankDelta = left.providerRank - right.providerRank;
      if (rankDelta !== 0) return rankDelta;
      return right.rawScore - left.rawScore;
    });
}

function mergeProviderResults(sourceResults, options = {}) {
  const rrfK = clampInt(options.rrfK, DEFAULT_RRF_K, 1, 500);
  const limit = clampInt(options.limit, DEFAULT_LIMIT, 1, 50);
  const context = asObject(options.context);
  const merged = new Map();
  const contentKeyToKey = new Map();

  for (const sourceResult of sourceResults || []) {
    if (!sourceResult || sourceResult.ok === false) continue;
    const provider = asObject(sourceResult.provider);
    const weight = Number.isFinite(Number(provider.weight)) ? Number(provider.weight) : 1;
    const items = normalizeProviderItems(sourceResult, provider)
      .filter((item) => shouldIncludeRecallItemForContext(item, context));
    items.forEach((item, index) => {
      const providerRank = item.providerRank || index + 1;
      const mergeKey = contentKeyToKey.get(item.contentKey) || item.key;
      contentKeyToKey.set(item.contentKey, mergeKey);
      const current = merged.get(mergeKey) || {
        ...item,
        score: 0,
        contributors: [],
      };
      const contribution = weight / (rrfK + providerRank);
      current.score += contribution;
      if (!current.excerpt && item.excerpt) current.excerpt = item.excerpt;
      if (!current.title && item.title) current.title = item.title;
      if (!current.ref && item.ref) current.ref = item.ref;
      if (!current.updatedAtMs || (item.updatedAtMs && item.updatedAtMs > current.updatedAtMs)) {
        current.updatedAtMs = item.updatedAtMs;
      }
      current.rawScore = Math.max(current.rawScore || 0, item.rawScore || 0);
      current.contributors.push({
        source: item.source,
        sourceKind: item.sourceKind,
        rank: providerRank,
        rawScore: item.rawScore,
        contribution: Number(contribution.toFixed(8)),
      });
      merged.set(mergeKey, current);
    });
  }

  return Array.from(merged.values())
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) return scoreDelta;
      return Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0);
    })
    .slice(0, limit)
    .map((item, index) => ({
      rank: index + 1,
      score: Number(item.score.toFixed(8)),
      source: item.source,
      sourceKind: item.sourceKind,
      id: item.id,
      ref: item.ref || null,
      title: item.title || null,
      excerpt: item.excerpt || null,
      updatedAtMs: item.updatedAtMs || null,
      metadata: item.metadata || {},
      contributors: item.contributors,
    }));
}

function providerRecallWithTimeout(provider, query, context, options) {
  const timeoutMs = clampInt(options.timeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS, 25, 30_000);
  const startedAtMs = Date.now();
  let timeoutHandle = null;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve({
        ok: false,
        reason: 'provider_timeout',
        provider,
        elapsedMs: Date.now() - startedAtMs,
      });
    }, timeoutMs);
  });
  const run = Promise.resolve()
    .then(() => provider.recall(query, context, options))
    .then((result) => ({
      ...asObject(result),
      ok: result?.ok !== false,
      provider,
      elapsedMs: Date.now() - startedAtMs,
    }))
    .catch((err) => ({
      ok: false,
      reason: 'provider_error',
      error: err.message,
      provider,
      elapsedMs: Date.now() - startedAtMs,
    }));
  return Promise.race([run, timeout])
    .finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    });
}

function createMemoryBroker(options = {}) {
  const providers = Array.isArray(options.providers)
    ? options.providers.filter((provider) => provider && typeof provider.recall === 'function')
    : [];
  const defaultLimit = clampInt(options.limit, DEFAULT_LIMIT, 1, 50);
  const defaultProviderLimit = clampInt(options.providerLimit, DEFAULT_PROVIDER_LIMIT, 1, 50);
  const defaultTimeoutMs = clampInt(options.providerTimeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS, 25, 30_000);
  const rrfK = clampInt(options.rrfK, DEFAULT_RRF_K, 1, 500);

  return {
    providers,
    async recall(query, context = {}, recallOptions = {}) {
      const normalizedQuery = oneLine(query, 1000);
      if (!normalizedQuery) {
        return {
          schema: 'squidrun.memory_broker.recall_v0',
          ok: false,
          reason: 'query_required',
          query: '',
          results: [],
        };
      }

      const limit = clampInt(recallOptions.limit, defaultLimit, 1, 50);
      const providerLimit = clampInt(recallOptions.providerLimit, defaultProviderLimit, 1, 50);
      const timeoutMs = clampInt(recallOptions.timeoutMs, defaultTimeoutMs, 25, 30_000);
      const sourceResults = await Promise.all(providers.map((provider) => providerRecallWithTimeout(
        provider,
        normalizedQuery,
        asObject(context),
        {
          ...recallOptions,
          limit: providerLimit,
          timeoutMs,
        }
      )));
      const recallContext = asObject(context);
      const results = mergeProviderResults(sourceResults, {
        limit,
        rrfK,
        context: recallContext,
      });
      const sources = sourceResults.map((result) => ({
        source: result?.provider?.id || result?.provider?.source || 'unknown',
        sourceKind: result?.provider?.sourceKind || result?.provider?.source_kind || result?.provider?.id || 'unknown',
        ok: result?.ok !== false,
        reason: result?.reason || null,
        itemCount: normalizeProviderItems(result, result?.provider || {}).length,
        elapsedMs: Number(result?.elapsedMs || 0),
      }));

      return {
        schema: 'squidrun.memory_broker.recall_v0',
        ok: true,
        query: normalizedQuery,
        generatedAt: new Date().toISOString(),
        limit,
        sources,
        results,
        consequence_controls: {
          internal_only: true,
          external_send_performed: false,
          autonomous_apply_performed: false,
        },
      };
    },
  };
}

function createCognitiveMemoryProvider(options = {}) {
  const execute = options.execute || null;
  return {
    id: 'cognitive_memory',
    sourceKind: 'vector_cognitive',
    weight: Number.isFinite(Number(options.weight)) ? Number(options.weight) : 1.15,
    async recall(query, context = {}, providerOptions = {}) {
      if (!execute) {
        const fs = require('fs');
        const { getDatabaseSync } = require('./sqlite-compat');
        const { resolveDefaultCognitiveMemoryDbPath } = require('./cognitive-memory-store');
        const dbPath = options.dbPath || resolveDefaultCognitiveMemoryDbPath();
        if (!dbPath || !fs.existsSync(dbPath)) {
          return { ok: false, reason: 'cognitive_memory_db_missing', items: [] };
        }
        const DatabaseSync = getDatabaseSync();
        const db = new DatabaseSync(dbPath);
        try {
          const maxRows = clampInt(options.maxRows, 2000, 1, 50_000);
          const rows = db.prepare('SELECT * FROM nodes LIMIT ?').all(maxRows);
          const items = rows
            .map((row) => {
              const text = [
                row.title,
                row.heading,
                row.category,
                row.content,
                row.source_path,
                row.source_type,
              ].filter(Boolean).join(' ');
              const coverage = tokenCoverageScore(text, query);
              if (coverage <= 0) return null;
              const confidence = Number(row.confidence_score || 0);
              const salience = Number(row.salience_score || 0);
              const score = coverage + (confidence * 0.2) + (salience * 0.05);
              return {
                id: row.node_id,
                title: asText(row.title, row.heading, row.category, row.node_id),
                excerpt: asText(row.content, row.heading, row.title),
                ref: asText(row.source_path, row.source_type, row.node_id),
                score,
                updatedAtMs: row.updated_at_ms || row.created_at_ms || row.classified_at,
                metadata: {
                  category: row.category || null,
                  sourceType: row.source_type || null,
                  confidenceScore: Number.isFinite(confidence) ? confidence : null,
                  fastSql: true,
                },
              };
            })
            .filter(Boolean)
            .sort((left, right) => right.score - left.score)
            .slice(0, clampInt(providerOptions.limit, DEFAULT_PROVIDER_LIMIT, 1, 50));
          return { ok: true, items };
        } catch (err) {
          return { ok: false, reason: 'cognitive_memory_query_failed', error: err.message, items: [] };
        } finally {
          try { db.close(); } catch {}
        }
      }

      const result = await execute('retrieve', {
        query,
        limit: providerOptions.limit,
        agentId: asText(context.role, context.sender, context.agentId, 'memory-broker'),
      }, {
        source: {
          via: 'memory-broker',
          role: asText(context.role, context.sender, 'system'),
        },
      });
      const results = Array.isArray(result?.results) ? result.results : [];
      return {
        ok: result?.ok !== false,
        reason: result?.reason || null,
        items: results.map((entry) => ({
          id: entry.nodeId,
          title: asText(entry.title, entry.heading, entry.category),
          excerpt: asText(entry.excerpt, entry.content),
          ref: asText(entry.sourcePath, entry.sourceType, entry.nodeId),
          score: entry.score,
          updatedAtMs: entry.updatedAtMs || entry.updated_at_ms || entry.lastAccessedAtMs,
          metadata: {
            leaseId: entry.leaseId || null,
            category: entry.category || null,
            sourceType: entry.sourceType || null,
            confidenceScore: entry.confidenceScore ?? null,
          },
        })),
      };
    },
  };
}

function createTeamMemoryProvider(options = {}) {
  const execute = options.execute || require('./team-memory').executeTeamMemoryOperation;
  return {
    id: 'team_memory',
    sourceKind: 'graph_team',
    weight: Number.isFinite(Number(options.weight)) ? Number(options.weight) : 1.05,
    async recall(query, _context = {}, providerOptions = {}) {
      const result = await execute('search-claims', {
        query,
        text: query,
        limit: providerOptions.limit,
      }, {
        useWorker: false,
      });
      const claims = Array.isArray(result?.claims) ? result.claims : [];
      return {
        ok: result?.ok !== false,
        reason: result?.reason || null,
        items: claims.map((claim) => ({
          id: claim.id,
          title: asText(claim.claimType, claim.owner, claim.id),
          excerpt: claim.statement,
          ref: claim.id,
          score: claim.confidence,
          updatedAtMs: claim.updatedAt || claim.updated_at || claim.createdAt,
          metadata: {
            owner: claim.owner || null,
            status: claim.status || null,
            scopes: Array.isArray(claim.scopes) ? claim.scopes.slice(0, 5) : [],
          },
        })),
      };
    },
  };
}

function createEvidenceLedgerProvider(options = {}) {
  const execute = options.execute || require('./ipc/evidence-ledger-handlers').executeEvidenceLedgerOperation;
  return {
    id: 'evidence_ledger',
    sourceKind: 'episodic_ledger',
    weight: Number.isFinite(Number(options.weight)) ? Number(options.weight) : 1,
    async recall(query, _context = {}, providerOptions = {}) {
      const result = await execute('search-decisions', {
        query,
        limit: providerOptions.limit,
      }, {
        useWorker: false,
        source: {
          via: 'memory-broker',
          role: 'system',
        },
      });
      const decisions = Array.isArray(result) ? result : (Array.isArray(result?.decisions) ? result.decisions : []);
      return {
        ok: result?.ok !== false,
        reason: result?.reason || null,
        items: decisions.map((decision) => ({
          id: decision.decisionId || decision.id,
          title: asText(decision.title, decision.category, decision.decisionId),
          excerpt: asText(decision.body, decision.summary, decision.title),
          ref: asText(decision.decisionId, decision.id),
          score: decision.score || 0,
          updatedAtMs: decision.updatedAtMs || decision.createdAtMs,
          metadata: {
            category: decision.category || null,
            status: decision.status || null,
            author: decision.author || null,
          },
        })),
      };
    },
  };
}

function createKnowledgeSearchProvider(options = {}) {
  const { MemorySearchIndex } = require('./memory-search');
  return {
    id: 'knowledge_search',
    sourceKind: 'knowledge_search',
    weight: Number.isFinite(Number(options.weight)) ? Number(options.weight) : 0.95,
    async recall(query, _context = {}, providerOptions = {}) {
      const index = options.index || new MemorySearchIndex(options.indexOptions || {});
      try {
        const result = await index.search(query, {
          limit: providerOptions.limit,
        });
        const results = Array.isArray(result?.results) ? result.results : [];
        return {
          ok: result?.ok !== false,
          reason: result?.reason || null,
          items: results.map((entry) => ({
            id: entry.documentId,
            title: asText(entry.title, entry.heading, entry.sourcePath),
            excerpt: asText(entry.excerpt, entry.content),
            ref: entry.sourcePath,
            score: entry.score,
            updatedAtMs: entry.lastModifiedMs || entry.updatedAtMs || entry.lastAccessedAtMs,
            metadata: {
              sourceType: entry.sourceType || null,
              heading: entry.heading || null,
            },
          })),
        };
      } finally {
        if (!options.index && typeof index.close === 'function') {
          index.close();
        }
      }
    },
  };
}

function createDefaultMemoryBroker(options = {}) {
  const providers = [
    createCognitiveMemoryProvider(options.cognitive || {}),
    createTeamMemoryProvider(options.team || {}),
    createEvidenceLedgerProvider(options.ledger || {}),
  ];
  if (options.enableKnowledgeSearch === true || process.env.SQUIDRUN_MEMORY_BROKER_KNOWLEDGE_SEARCH === '1') {
    providers.push(createKnowledgeSearchProvider(options.knowledge || {}));
  }
  return createMemoryBroker({
    ...options,
    providers: Array.isArray(options.providers) ? options.providers : providers,
  });
}

function formatRecallForPaneMessage(recall, options = {}) {
  const result = asObject(recall);
  const items = Array.isArray(result.results)
    ? result.results.slice(0, clampInt(options.limit, DEFAULT_LIMIT, 1, 20))
    : [];
  if (result.ok === false || items.length === 0) return '';
  const lines = [
    RECALL_START,
    'Use this as ranked private retrieval context. Prefer current evidence over stale memory.',
  ];
  for (const item of items) {
    const label = asText(item.sourceKind, item.source, 'memory');
    const title = item.title ? `${item.title}: ` : '';
    const ref = item.ref ? ` (${item.ref})` : '';
    lines.push(`${item.rank}. ${label} - ${title}${oneLine(item.excerpt, 220)}${ref}`);
  }
  lines.push(RECALL_END);
  return lines.join('\n');
}

function prependRecallToMessage(message, recall, options = {}) {
  const text = String(message || '');
  if (!text.trim()) return text;
  if (text.includes(RECALL_START)) return text;
  // Trivial one-liners get no recall block injected (not even an empty one).
  if (!messageReferencesPastWork(text, options)) return text;
  const block = formatRecallForPaneMessage(recall, options);
  if (!block) return text;
  return `${block}\n\n${text}`;
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_PROVIDER_LIMIT,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  DEFAULT_RRF_K,
  MEMORY_RECALL_MIN_MESSAGE_LENGTH,
  RECALL_END,
  RECALL_START,
  messageReferencesPastWork,
  createCognitiveMemoryProvider,
  createDefaultMemoryBroker,
  createEvidenceLedgerProvider,
  createKnowledgeSearchProvider,
  createMemoryBroker,
  createTeamMemoryProvider,
  formatRecallForPaneMessage,
  mergeProviderResults,
  normalizeProviderItem,
  _internals: {
    classifyRecallItemScope,
    recallContextAllowsProfileScope,
    shouldIncludeRecallItemForContext,
  },
  prependRecallToMessage,
};
