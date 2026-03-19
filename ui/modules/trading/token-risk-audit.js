'use strict';

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

function toRatio(value, fallback = 0) {
  const numeric = toNumber(value, fallback);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric > 1) return clamp(numeric / 100, 0, 1);
  return clamp(numeric, 0, 1);
}

function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  return fallback;
}

function normalizeChain(value, fallback = 'solana') {
  const normalized = toText(value, fallback).toLowerCase();
  if (normalized === 'base') return 'base';
  if (normalized === 'solana') return 'solana';
  throw new Error(`Unsupported token risk audit chain: ${value}`);
}

function normalizeAddress(value, chain = 'solana') {
  const normalized = toText(value);
  if (!normalized) {
    throw new Error('token address is required');
  }
  return chain === 'base' ? normalized.toLowerCase() : normalized;
}

function normalizeTopHolders(topHolders = []) {
  if (!Array.isArray(topHolders)) return [];
  return topHolders.map((holder, index) => {
    return {
      address: toText(holder.address || holder.wallet || holder.owner || `holder-${index + 1}`),
      ratio: toRatio(holder.ratio ?? holder.percent ?? holder.percentage ?? holder.share, 0),
    };
  }).filter((holder) => holder.address);
}

function sumTopHolderRatio(topHolders = [], count = 5) {
  return clamp(topHolders.slice(0, Math.max(0, Math.floor(toNumber(count, 5)))).reduce((sum, holder) => {
    return sum + toRatio(holder.ratio, 0);
  }, 0), 0, 1);
}

function normalizeAuditDetails(record = {}, address, chain) {
  const topHolders = normalizeTopHolders(
    record.topHolders
    || record.top_holders
    || record.holders
    || record.holder_distribution
    || []
  );
  const top5HolderRatio = toRatio(
    record.top5HolderRatio
    ?? record.top_5_holder_rate
    ?? record.top_5_holders_rate
    ?? record.topHoldersPct
    ?? sumTopHolderRatio(topHolders, 5),
    sumTopHolderRatio(topHolders, 5)
  );

  return {
    address,
    chain,
    honeypot: toBoolean(record.honeypot ?? record.is_honeypot ?? record.isHoneyPot, false),
    liquidityLocked: record.liquidityLocked !== undefined || record.is_locked !== undefined
      ? toBoolean(record.liquidityLocked ?? record.is_locked, false)
      : null,
    isProxy: toBoolean(record.isProxy ?? record.is_proxy ?? record.proxy_contract, false),
    mintAuthorityRenounced: record.mintAuthorityRenounced !== undefined || record.owner_address !== undefined
      ? toBoolean(record.mintAuthorityRenounced ?? record.owner_renounced ?? record.owner_address === '0x0000000000000000000000000000000000000000', false)
      : null,
    buyTax: clamp(toRatio(record.buyTax ?? record.buy_tax ?? 0, 0), 0, 1),
    sellTax: clamp(toRatio(record.sellTax ?? record.sell_tax ?? 0, 0), 0, 1),
    topHolders,
    top5HolderRatio,
    provider: toText(record.provider, 'provider'),
    raw: record.raw || record,
  };
}

function buildRecommendation(details = {}) {
  const risks = [];
  const avoidReasons = [];
  const cautionReasons = [];

  if (details.honeypot) {
    risks.push('honeypot_detected');
    avoidReasons.push('honeypot_detected');
  }
  if (details.top5HolderRatio > 0.5) {
    risks.push('top_5_wallets_control_more_than_50pct');
    avoidReasons.push('top_5_wallets_control_more_than_50pct');
  }
  if (details.liquidityLocked === false) {
    risks.push('liquidity_not_locked');
    avoidReasons.push('liquidity_not_locked');
  }
  if (details.isProxy) {
    risks.push('proxy_contract');
    cautionReasons.push('proxy_contract');
  }
  if (details.mintAuthorityRenounced === false) {
    risks.push('mint_authority_not_renounced');
    cautionReasons.push('mint_authority_not_renounced');
  }
  if (details.buyTax > 0.12 || details.sellTax > 0.12) {
    risks.push('elevated_transfer_tax');
    cautionReasons.push('elevated_transfer_tax');
  }

  const recommendation = avoidReasons.length > 0
    ? 'avoid'
    : (cautionReasons.length > 0 ? 'caution' : 'proceed');

  return {
    safe: recommendation !== 'avoid',
    risks,
    recommendation,
  };
}

function resolveTokenRiskAuditConfig(env = process.env) {
  return {
    configured: true,
    supportedChains: ['solana', 'base'],
    apiBaseUrl: toText(env.GOPLUS_API_BASE_URL, 'https://api.gopluslabs.io'),
  };
}

function resolveGoPlusUrl(address, chain, env = process.env) {
  const baseUrl = resolveTokenRiskAuditConfig(env).apiBaseUrl.replace(/\/+$/, '');
  if (chain === 'base') {
    return `${baseUrl}/api/v1/token_security/8453?contract_addresses=${encodeURIComponent(address)}`;
  }
  return `${baseUrl}/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(address)}`;
}

function extractGoPlusPayload(payload = {}, address) {
  const lowerAddress = toText(address).toLowerCase();
  if (payload && typeof payload === 'object') {
    if (payload.result && typeof payload.result === 'object') {
      if (payload.result[lowerAddress]) return payload.result[lowerAddress];
      if (payload.result[address]) return payload.result[address];
      const first = Object.values(payload.result).find((entry) => entry && typeof entry === 'object');
      if (first) return first;
    }
    if (payload.data && typeof payload.data === 'object') {
      return payload.data;
    }
  }
  return {};
}

async function auditToken(address, chain, options = {}) {
  const normalizedChain = normalizeChain(chain);
  const normalizedAddress = normalizeAddress(address, normalizedChain);
  const provider = typeof options.provider === 'function'
    ? options.provider
    : createGoPlusProvider(options.providerOptions || {});

  let rawDetails = {};
  if (options.mockRiskData && typeof options.mockRiskData === 'object') {
    rawDetails = options.mockRiskData;
  } else if (typeof provider === 'function') {
    rawDetails = await provider({
      address: normalizedAddress,
      chain: normalizedChain,
      fetch: options.fetch || global.fetch,
      env: options.env || process.env,
      options,
    });
  }

  const details = normalizeAuditDetails(rawDetails || {}, normalizedAddress, normalizedChain);
  const recommendation = buildRecommendation(details);
  return {
    safe: recommendation.safe,
    risks: recommendation.risks,
    recommendation: recommendation.recommendation,
    details,
  };
}

function createStaticTokenRiskProvider(responses = {}) {
  return async function staticTokenRiskProvider({ address, chain }) {
    const key = `${chain}:${address}`;
    if (typeof responses === 'function') {
      return responses({ address, chain });
    }
    if (responses[key]) return responses[key];
    if (responses[address]) return responses[address];
    if (responses[chain]) return responses[chain];
    return {};
  };
}

function createGoPlusProvider(options = {}) {
  return async function goPlusProvider({ address, chain, fetch: fetchFn, env }) {
    const _fetch = fetchFn || global.fetch;
    if (typeof _fetch !== 'function') {
      throw new Error('fetch_unavailable');
    }
    const url = resolveGoPlusUrl(address, chain, env || process.env);
    const response = await _fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(Math.max(1_000, Math.floor(toNumber(options.timeoutMs, 15_000)))),
    });
    if (!response.ok) {
      throw new Error(`goplus_http_${response.status}`);
    }
    const payload = await response.json();
    return {
      ...extractGoPlusPayload(payload, address),
      provider: 'goplus',
      raw: payload,
    };
  };
}

module.exports = {
  auditToken,
  buildRecommendation,
  createGoPlusProvider,
  createStaticTokenRiskProvider,
  normalizeAuditDetails,
  normalizeChain,
  normalizeTopHolders,
  resolveGoPlusUrl,
  resolveTokenRiskAuditConfig,
};
