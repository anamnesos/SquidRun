'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { resolveCoordPath } = require('../../config');
const tokenRiskAudit = require('./token-risk-audit');

const DEFAULT_LAUNCH_RADAR_STATE_PATH = resolveCoordPath(
  path.join('runtime', 'launch-radar-state.json'),
  { forWrite: true }
);
const DEFAULT_POLL_MS = 60_000;
const DEFAULT_MIN_LIQUIDITY_USD = 5_000;
const DEFAULT_MIN_HOLDERS = 10;
const DEFAULT_MAX_AGE_MINUTES = 60;
const DEFAULT_MAX_SEEN_LAUNCH_IDS = 2_000;
const SUPPORTED_CHAINS = new Set(['solana', 'base']);

function toText(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function toIsoTimestamp(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function normalizeChain(value, fallback = 'solana') {
  const normalized = toText(value, fallback).toLowerCase();
  if (!SUPPORTED_CHAINS.has(normalized)) {
    throw new Error(`Unsupported launch radar chain: ${value}`);
  }
  return normalized;
}

function normalizeAddress(value, chain = 'solana') {
  const normalized = toText(value);
  if (!normalized) {
    throw new Error('launch token address is required');
  }
  return chain === 'base' ? normalized.toLowerCase() : normalized;
}

function countSocialPresence(record = {}) {
  const directFields = [
    record.website,
    record.twitter,
    record.telegram,
    record.discord,
    record.tiktok,
    record.instagram,
  ].filter((entry) => toText(entry)).length;
  const arrayFields = Array.isArray(record.socials)
    ? record.socials.filter((entry) => {
      if (!entry) return false;
      if (typeof entry === 'string') return toText(entry).length > 0;
      return Boolean(toText(entry.url || entry.handle || entry.type));
    }).length
    : 0;
  const explicit = Math.max(0, Math.floor(toNumber(record.socialPresence ?? record.social_presence, 0)));
  return Math.max(explicit, directFields + arrayFields);
}

function resolveAgeMinutes(record = {}, nowMs = Date.now()) {
  if (record.ageMinutes != null || record.age_minutes != null) {
    return Math.max(0, toNumber(record.ageMinutes ?? record.age_minutes, 0));
  }
  const createdAt = toIsoTimestamp(
    record.createdAt
    || record.listedAt
    || record.launchedAt
    || record.pairCreatedAt
    || record.created_at,
    null
  );
  if (!createdAt) return null;
  return Math.max(0, Number((((nowMs - Date.parse(createdAt)) / 60_000)).toFixed(2)));
}

function buildLaunchId(token = {}) {
  return [
    token.chain,
    token.address,
    token.createdAt || '',
    token.source || '',
  ].join(':');
}

function normalizeLaunch(record = {}, options = {}) {
  const chain = normalizeChain(record.chain || options.chain || 'solana');
  const createdAt = toIsoTimestamp(
    record.createdAt
    || record.listedAt
    || record.launchedAt
    || record.pairCreatedAt
    || record.created_at,
    null
  );
  const socialPresence = countSocialPresence(record);
  const ageMinutes = resolveAgeMinutes(record, Number.isFinite(options.nowMs) ? options.nowMs : Date.now());
  const normalized = {
    chain,
    address: normalizeAddress(record.address || record.tokenAddress || record.contractAddress || record.mint, chain),
    symbol: toText(record.symbol || record.ticker || record.token, 'UNKNOWN').toUpperCase(),
    name: toText(record.name || record.tokenName || record.projectName),
    source: toText(record.source || record.dex || record.platform || 'provider'),
    liquidityUsd: Math.max(0, toNumber(record.liquidityUsd ?? record.liquidity_usd ?? record.liquidity, 0)),
    holders: Math.max(0, Math.floor(toNumber(record.holders ?? record.holderCount ?? record.holder_count, 0))),
    marketCapUsd: Math.max(0, toNumber(record.marketCapUsd ?? record.market_cap_usd ?? record.marketCap, 0)),
    volume24hUsd: Math.max(0, toNumber(record.volume24hUsd ?? record.volume_24h_usd ?? record.volume24h ?? 0, 0)),
    createdAt,
    ageMinutes,
    socialPresence,
    socialVelocity: clamp(toNumber(record.socialVelocity ?? record.social_velocity, 0), 0, 1),
    holderConcentration: clamp(
      toNumber(record.holderConcentration ?? record.top5HolderRatio ?? record.top_5_holder_rate ?? 0, 0) > 1
        ? toNumber(record.holderConcentration ?? record.top5HolderRatio ?? record.top_5_holder_rate ?? 0, 0) / 100
        : toNumber(record.holderConcentration ?? record.top5HolderRatio ?? record.top_5_holder_rate ?? 0, 0),
      0,
      1
    ),
    website: toText(record.website),
    twitter: toText(record.twitter),
    telegram: toText(record.telegram),
    raw: record.raw || record,
  };
  normalized.launchId = toText(record.launchId || record.id, buildLaunchId(normalized));
  return normalized;
}

function defaultLaunchRadarState() {
  return {
    lastPollAt: null,
    cursors: {},
    seenLaunchIds: [],
    updatedAt: null,
  };
}

function normalizeLaunchRadarState(state = {}) {
  return {
    ...defaultLaunchRadarState(),
    ...state,
    lastPollAt: toIsoTimestamp(state.lastPollAt, null),
    cursors: state && typeof state.cursors === 'object' && !Array.isArray(state.cursors) ? { ...state.cursors } : {},
    seenLaunchIds: Array.isArray(state.seenLaunchIds)
      ? state.seenLaunchIds.map((entry) => toText(entry)).filter(Boolean)
      : [],
    updatedAt: toIsoTimestamp(state.updatedAt, null),
  };
}

function readLaunchRadarState(statePath = DEFAULT_LAUNCH_RADAR_STATE_PATH) {
  try {
    return normalizeLaunchRadarState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  } catch {
    return defaultLaunchRadarState();
  }
}

function writeLaunchRadarState(statePath = DEFAULT_LAUNCH_RADAR_STATE_PATH, state = {}) {
  const normalized = normalizeLaunchRadarState(state);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    ...normalized,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function filterLaunches(launches = [], options = {}) {
  const minLiquidityUsd = Math.max(0, toNumber(options.minLiquidityUsd, DEFAULT_MIN_LIQUIDITY_USD));
  const minHolders = Math.max(0, Math.floor(toNumber(options.minHolders, DEFAULT_MIN_HOLDERS)));
  const maxAgeMinutes = Math.max(1, toNumber(options.maxAgeMinutes, DEFAULT_MAX_AGE_MINUTES));
  const accepted = [];
  const rejected = [];

  for (const launch of launches) {
    const reasons = [];
    if (launch.liquidityUsd < minLiquidityUsd) {
      reasons.push('min_liquidity_not_met');
    }
    if (launch.holders < minHolders) {
      reasons.push('min_holders_not_met');
    }
    if (launch.ageMinutes != null && launch.ageMinutes > maxAgeMinutes) {
      reasons.push('launch_too_old');
    }
    if (launch.socialPresence <= 0) {
      reasons.push('no_social_presence');
    }
    if (reasons.length > 0) {
      rejected.push({ token: launch, reasons });
    } else {
      accepted.push(launch);
    }
  }

  accepted.sort((left, right) => {
    if ((left.ageMinutes ?? Number.MAX_SAFE_INTEGER) !== (right.ageMinutes ?? Number.MAX_SAFE_INTEGER)) {
      return (left.ageMinutes ?? Number.MAX_SAFE_INTEGER) - (right.ageMinutes ?? Number.MAX_SAFE_INTEGER);
    }
    return right.liquidityUsd - left.liquidityUsd;
  });

  return { accepted, rejected };
}

async function scanNewLaunches(options = {}) {
  const chain = normalizeChain(options.chain || 'solana');
  let providerResult;
  if (Array.isArray(options.mockLaunches)) {
    providerResult = { launches: options.mockLaunches, cursor: options.cursor ?? null };
  } else if (typeof options.provider === 'function') {
    providerResult = await options.provider({
      chain,
      fetch: options.fetch || global.fetch,
      env: options.env || process.env,
      cursor: options.cursor ?? null,
      minLiquidityUsd: options.minLiquidityUsd ?? DEFAULT_MIN_LIQUIDITY_USD,
      minHolders: options.minHolders ?? DEFAULT_MIN_HOLDERS,
      maxAgeMinutes: options.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES,
      options,
    });
  } else {
    throw new Error('launch_radar_provider_required');
  }

  const rawLaunches = Array.isArray(providerResult)
    ? providerResult
    : (Array.isArray(providerResult?.launches) ? providerResult.launches : []);
  const normalized = rawLaunches.map((launch) => normalizeLaunch(launch, {
    chain,
    nowMs: Number.isFinite(options.nowMs) ? options.nowMs : Date.now(),
  })).filter((launch) => launch.chain === chain);
  const filtered = filterLaunches(normalized, options);

  if (options.includeRejected === true) {
    return {
      launches: filtered.accepted,
      rejected: filtered.rejected,
      cursor: Array.isArray(providerResult) ? null : (providerResult?.cursor ?? null),
    };
  }

  return filtered.accepted;
}

function evaluateToken(token = {}) {
  const liquidityDepth = clamp(Math.log10(Math.max(1, toNumber(token.liquidityUsd, 0))) / 5, 0, 1);
  const holderConcentration = clamp(
    toNumber(token.holderConcentration, 0) > 1
      ? toNumber(token.holderConcentration, 0) / 100
      : toNumber(token.holderConcentration, 0),
    0,
    1
  );
  const socialVelocity = clamp(
    Math.max(
      toNumber(token.socialVelocity, 0),
      Math.min(1, (Math.max(0, toNumber(token.socialPresence, 0)) / 4) * 0.85)
    ),
    0,
    1
  );
  const liquidityRisk = 1 - clamp(toNumber(token.liquidityUsd, 0) / 25_000, 0, 1);
  const holderRisk = clamp(holderConcentration / 0.65, 0, 1);
  const socialRisk = 1 - socialVelocity;
  const rugRisk = clamp((liquidityRisk * 0.35) + (holderRisk * 0.45) + (socialRisk * 0.2), 0, 1);
  const viralScore = clamp(
    (socialVelocity * 0.45)
    + (clamp(toNumber(token.volume24hUsd, 0) / 50_000, 0, 1) * 0.25)
    + (clamp(toNumber(token.holders, 0) / 200, 0, 1) * 0.2)
    + (liquidityDepth * 0.1),
    0,
    1
  );

  return {
    viralScore: Number(viralScore.toFixed(4)),
    rugRisk: Number(rugRisk.toFixed(4)),
    liquidityDepth: Number(liquidityDepth.toFixed(4)),
    holderConcentration: Number(holderConcentration.toFixed(4)),
    socialVelocity: Number(socialVelocity.toFixed(4)),
  };
}

function resolveLaunchRadarConfig(env = process.env) {
  const birdeyeApiKey = toText(env.BIRDEYE_API_KEY);
  return {
    birdeyeApiKey,
    configured: Boolean(birdeyeApiKey),
    supportedChains: ['solana', 'base'],
  };
}

async function fetchJson(url, options = {}) {
  const fetchFn = options.fetch || global.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('fetch_unavailable');
  }
  const response = await fetchFn(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    signal: AbortSignal.timeout(Math.max(1_000, Math.floor(toNumber(options.timeoutMs, 15_000)))),
  });
  if (!response.ok) {
    throw new Error(`http_${response.status}`);
  }
  return response.json();
}

async function fetchBirdeyeListings({ chain, fetch, env }) {
  const config = resolveLaunchRadarConfig(env || process.env);
  if (!config.birdeyeApiKey) return [];
  const chainPath = chain === 'base' ? 'base' : 'solana';
  const payload = await fetchJson(`https://public-api.birdeye.so/defi/v2/tokens/new_listing?chain=${encodeURIComponent(chainPath)}`, {
    fetch,
    headers: {
      Accept: 'application/json',
      'X-API-KEY': config.birdeyeApiKey,
    },
  }).catch(() => ({ data: { items: [] } }));
  const items = Array.isArray(payload?.data?.items) ? payload.data.items : [];
  return items.map((item) => ({
    chain,
    address: item.address || item.token_address || item.mint,
    symbol: item.symbol,
    name: item.name,
    source: item.source || 'birdeye',
    liquidityUsd: item.liquidity ?? item.liquidity_usd,
    holders: item.holder ?? item.holders,
    marketCapUsd: item.market_cap,
    volume24hUsd: item.volume_24h_usd,
    createdAt: item.created_at || item.listed_at,
    website: item.website,
    twitter: item.twitter,
    telegram: item.telegram,
    socials: item.socials,
  }));
}

async function fetchDexScreenerLaunches({ chain, fetch }) {
  const chainPath = chain === 'base' ? 'base' : 'solana';
  const payload = await fetchJson(`https://api.dexscreener.com/token-profiles/latest/v1/${encodeURIComponent(chainPath)}`, {
    fetch,
  }).catch(() => []);
  const items = Array.isArray(payload) ? payload : [];
  return items.map((item) => ({
    chain,
    address: item.tokenAddress || item.address,
    symbol: item.tokenSymbol || item.symbol,
    name: item.tokenName || item.name,
    source: item.dexId || 'dexscreener',
    liquidityUsd: item.liquidity?.usd ?? item.liquidityUsd,
    holders: item.holders,
    volume24hUsd: item.volume?.h24 ?? item.volume24hUsd,
    marketCapUsd: item.marketCap,
    createdAt: item.pairCreatedAt || item.createdAt,
    website: item.links?.website || item.website,
    twitter: item.links?.twitter || item.twitter,
    telegram: item.links?.telegram || item.telegram,
    socials: item.links || item.socials,
  }));
}

function dedupeLaunches(launches = []) {
  const seen = new Set();
  const results = [];
  for (const launch of launches) {
    const key = `${launch.chain}:${launch.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(launch);
  }
  return results;
}

function createLaunchRadarProvider(options = {}) {
  return async function launchRadarProvider(context = {}) {
    const { chain, fetch, env } = context;
    const launches = [];
    const [birdeyeLaunches, dexScreenerLaunches] = await Promise.all([
      fetchBirdeyeListings({ chain, fetch, env }).catch(() => []),
      fetchDexScreenerLaunches({ chain, fetch }).catch(() => []),
    ]);
    launches.push(...birdeyeLaunches, ...dexScreenerLaunches);
    return {
      launches: dedupeLaunches(launches.map((launch) => ({
        ...launch,
        source: toText(launch.source, 'api'),
      }))),
      cursor: context.cursor ?? null,
      metadata: { provider: options.name || 'launch_radar_api' },
    };
  };
}

function createStaticLaunchProvider(launches = {}) {
  return async function staticLaunchProvider({ chain }) {
    if (typeof launches === 'function') {
      return launches({ chain });
    }
    if (Array.isArray(launches)) {
      return { launches, cursor: null };
    }
    return {
      launches: Array.isArray(launches[chain]) ? launches[chain] : [],
      cursor: null,
    };
  };
}

class LaunchRadar extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { ...options };
    this.chains = Array.isArray(options.chains) && options.chains.length > 0
      ? Array.from(new Set(options.chains.map((chain) => normalizeChain(chain))))
      : [normalizeChain(options.chain || 'solana'), 'base'].filter((chain, index, values) => values.indexOf(chain) === index);
    this.pollMs = Math.max(15_000, Math.floor(toNumber(options.pollMs, DEFAULT_POLL_MS)));
    this.minLiquidityUsd = Math.max(0, toNumber(options.minLiquidityUsd, DEFAULT_MIN_LIQUIDITY_USD));
    this.minHolders = Math.max(0, Math.floor(toNumber(options.minHolders, DEFAULT_MIN_HOLDERS)));
    this.maxAgeMinutes = Math.max(1, toNumber(options.maxAgeMinutes, DEFAULT_MAX_AGE_MINUTES));
    this.maxSeenLaunchIds = Math.max(100, Math.floor(toNumber(options.maxSeenLaunchIds, DEFAULT_MAX_SEEN_LAUNCH_IDS)));
    this.statePath = options.statePath || DEFAULT_LAUNCH_RADAR_STATE_PATH;
    this.fetch = options.fetch || global.fetch;
    this.provider = typeof options.provider === 'function'
      ? options.provider
      : createLaunchRadarProvider(options.providerOptions || {});
    this.auditModule = options.tokenRiskAudit || tokenRiskAudit;
    this.auditProvider = typeof options.auditProvider === 'function'
      ? options.auditProvider
      : tokenRiskAudit.createGoPlusProvider(options.auditProviderOptions || {});
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.onQualified = typeof options.onQualified === 'function' ? options.onQualified : null;
    this.state = normalizeLaunchRadarState(options.state || readLaunchRadarState(this.statePath));
    this.timer = null;
    this.pollPromise = null;
    this.running = false;
  }

  getState() {
    return normalizeLaunchRadarState(this.state);
  }

  persistState() {
    if (this.options.persist === false) return;
    writeLaunchRadarState(this.statePath, this.state);
  }

  async scanNewLaunches(options = {}) {
    return scanNewLaunches({
      chain: options.chain,
      provider: options.provider || this.provider,
      fetch: this.fetch,
      env: options.env || this.options.env || process.env,
      cursor: options.cursor ?? null,
      nowMs: this.now(),
      includeRejected: options.includeRejected === true,
      minLiquidityUsd: options.minLiquidityUsd ?? this.minLiquidityUsd,
      minHolders: options.minHolders ?? this.minHolders,
      maxAgeMinutes: options.maxAgeMinutes ?? this.maxAgeMinutes,
      mockLaunches: options.mockLaunches,
    });
  }

  evaluateToken(token = {}) {
    return evaluateToken(token);
  }

  start(options = {}) {
    if (this.running) return this;
    this.running = true;
    if (options.immediate !== false) {
      void this.pollNow({ reason: 'startup' });
    }
    this.timer = setInterval(() => {
      void this.pollNow({ reason: 'interval' });
    }, this.pollMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this;
  }

  async pollNow(options = {}) {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.runPoll(options).finally(() => {
      this.pollPromise = null;
    });
    return this.pollPromise;
  }

  async runPoll(options = {}) {
    const startedAt = new Date(this.now()).toISOString();
    try {
      const chainResults = await Promise.all(this.chains.map(async (chain) => {
        return {
          chain,
          result: await this.scanNewLaunches({
            chain,
            includeRejected: true,
            cursor: this.state.cursors?.[chain] ?? null,
          }),
        };
      }));

      const seen = new Set(this.state.seenLaunchIds);
      const batchSeen = new Set();
      const launches = [];
      const rejected = [];
      const cursors = { ...this.state.cursors };

      for (const entry of chainResults) {
        const result = entry.result || {};
        cursors[entry.chain] = result.cursor ?? cursors[entry.chain] ?? null;
        for (const token of Array.isArray(result.launches) ? result.launches : []) {
          if (seen.has(token.launchId) || batchSeen.has(token.launchId)) continue;
          batchSeen.add(token.launchId);
          launches.push(token);
        }
        for (const rejection of Array.isArray(result.rejected) ? result.rejected : []) {
          const token = rejection.token;
          if (!token || seen.has(token.launchId) || batchSeen.has(token.launchId)) continue;
          batchSeen.add(token.launchId);
          rejected.push({
            token,
            reason: rejection.reasons.join(','),
            reasons: rejection.reasons.slice(),
            stage: 'filters',
          });
        }
      }

      const qualified = [];
      for (const token of launches) {
        this.emit('launch', token);
        const evaluation = this.evaluateToken(token);
        const audit = await this.auditModule.auditToken(token.address, token.chain, {
          token,
          provider: this.auditProvider,
          fetch: this.fetch,
          env: this.options.env || process.env,
        });
        const candidate = {
          ...token,
          evaluation,
          audit,
        };
        if (audit.recommendation === 'avoid') {
          const rejection = {
            token: candidate,
            reason: 'risk_audit_avoid',
            reasons: audit.risks.slice(),
            stage: 'audit',
          };
          rejected.push(rejection);
          this.emit('rejected', rejection);
          continue;
        }
        qualified.push(candidate);
        this.emit('qualified', candidate);
        if (this.onQualified) {
          await this.onQualified(candidate);
        }
      }

      for (const rejection of rejected) {
        if (rejection.stage === 'filters') {
          this.emit('rejected', rejection);
        }
      }

      this.state = normalizeLaunchRadarState({
        ...this.state,
        lastPollAt: startedAt,
        cursors,
        seenLaunchIds: Array.from(new Set([
          ...Array.from(batchSeen),
          ...this.state.seenLaunchIds,
        ])).slice(0, this.maxSeenLaunchIds),
      });
      this.persistState();

      const summary = {
        ok: true,
        startedAt,
        completedAt: new Date(this.now()).toISOString(),
        launches,
        qualified,
        rejected,
      };
      this.emit('poll', summary);
      return summary;
    } catch (err) {
      const failure = {
        ok: false,
        startedAt,
        completedAt: new Date(this.now()).toISOString(),
        error: err.message,
      };
      if (this.listenerCount('error') > 0) {
        this.emit('error', failure);
      }
      return failure;
    }
  }
}

function createLaunchRadar(options = {}) {
  return new LaunchRadar(options);
}

module.exports = {
  DEFAULT_LAUNCH_RADAR_STATE_PATH,
  DEFAULT_MAX_AGE_MINUTES,
  DEFAULT_MIN_HOLDERS,
  DEFAULT_MIN_LIQUIDITY_USD,
  DEFAULT_POLL_MS,
  LaunchRadar,
  countSocialPresence,
  createLaunchRadar,
  createLaunchRadarProvider,
  createStaticLaunchProvider,
  defaultLaunchRadarState,
  evaluateToken,
  filterLaunches,
  normalizeLaunch,
  normalizeLaunchRadarState,
  readLaunchRadarState,
  resolveLaunchRadarConfig,
  scanNewLaunches,
  writeLaunchRadarState,
};
