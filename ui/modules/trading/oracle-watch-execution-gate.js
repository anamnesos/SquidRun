'use strict';

const MIN_EXECUTABLE_MARGIN_USD = 200;
const PRIOR_VETO_SUPPRESSION_MS = 60 * 60 * 1000;

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = NaN) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isWatchOnlyRule(rule = {}) {
  const executionMode = toText(rule.executionMode || rule.mode || rule.tradeMode, '').toLowerCase();
  return rule.watchOnly === true
    || rule.noTrade === true
    || rule.no_trade === true
    || executionMode === 'watch_only'
    || executionMode === 'watch-only'
    || executionMode === 'no_trade'
    || executionMode === 'no-trade';
}

function resolveRuleMarginUsd(rule = {}, fallback = NaN) {
  return toNumber(
    rule.suggestedMarginUsd
      ?? rule.marginUsd
      ?? rule.maxMarginUsd,
    fallback
  );
}

function resolveExecutableCommandGate(rule = {}, options = {}) {
  if (isWatchOnlyRule(rule)) {
    return {
      executable: false,
      reason: 'watch_only_or_no_trade',
      minMarginUsd: MIN_EXECUTABLE_MARGIN_USD,
      marginUsd: resolveRuleMarginUsd(rule, options.fallbackMarginUsd),
    };
  }

  const marginUsd = resolveRuleMarginUsd(rule, options.fallbackMarginUsd);
  if (!Number.isFinite(marginUsd) || marginUsd < MIN_EXECUTABLE_MARGIN_USD) {
    return {
      executable: false,
      reason: 'below_min_executable_margin',
      minMarginUsd: MIN_EXECUTABLE_MARGIN_USD,
      marginUsd: Number.isFinite(marginUsd) ? marginUsd : null,
    };
  }

  return {
    executable: true,
    reason: 'executable',
    minMarginUsd: MIN_EXECUTABLE_MARGIN_USD,
    marginUsd,
  };
}

function buildRuleTriggerFingerprint(rule = {}) {
  const ticker = toText(rule.ticker, '').toUpperCase();
  const trigger = toText(rule.trigger, '').toLowerCase();
  const level = [
    rule.loseLevel,
    rule.retestMin,
    rule.retestMax,
    rule.level,
  ]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) => String(value))
    .join(':');
  return [ticker, trigger, level].filter(Boolean).join('|');
}

function isPriorExecutionVetoStatus(status = '') {
  const normalized = toText(status, '').toLowerCase();
  return normalized.startsWith('deferred_')
    || normalized.startsWith('blocked_')
    || normalized === 'skipped_not_executable'
    || normalized === 'invalidated_not_executable'
    || normalized === 'event_veto'
    || normalized === 'risk_paused'
    || normalized === 'suppressed_prior_veto';
}

function shouldSuppressAfterPriorVeto(rule = {}, ruleState = {}, nowMs = Date.now(), options = {}) {
  const execution = ruleState?.execution && typeof ruleState.execution === 'object'
    ? ruleState.execution
    : null;
  if (!execution || !isPriorExecutionVetoStatus(execution.status)) {
    return {
      suppress: false,
      reason: null,
    };
  }

  const attemptedAtMs = Date.parse(toText(execution.attemptedAt || ruleState.actedOnAt, ''));
  const ttlMs = Math.max(
    60 * 1000,
    Number(options.suppressionMs || PRIOR_VETO_SUPPRESSION_MS) || PRIOR_VETO_SUPPRESSION_MS
  );
  if (Number.isFinite(attemptedAtMs) && (nowMs - attemptedAtMs) > ttlMs) {
    return {
      suppress: false,
      reason: null,
    };
  }

  const currentFingerprint = buildRuleTriggerFingerprint(rule);
  const previousFingerprint = toText(execution.triggerFingerprint || ruleState.triggerFingerprint, currentFingerprint);
  if (currentFingerprint && previousFingerprint && currentFingerprint !== previousFingerprint) {
    return {
      suppress: false,
      reason: null,
    };
  }

  return {
    suppress: true,
    reason: 'same_symbol_trigger_prior_veto',
    triggerFingerprint: currentFingerprint,
    previousStatus: execution.status,
  };
}

module.exports = {
  MIN_EXECUTABLE_MARGIN_USD,
  PRIOR_VETO_SUPPRESSION_MS,
  buildRuleTriggerFingerprint,
  isPriorExecutionVetoStatus,
  isWatchOnlyRule,
  resolveExecutableCommandGate,
  resolveRuleMarginUsd,
  shouldSuppressAfterPriorVeto,
};
