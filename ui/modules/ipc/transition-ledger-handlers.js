/**
 * Transition Ledger IPC Handlers
 * Channels:
 * - transition-ledger:list
 * - transition-ledger:get-by-id
 * - transition-ledger:get-by-correlation
 * - transition-ledger:get-stats
 */

const transitionLedger = require('../transition-ledger');

const TRANSITION_LEDGER_CHANNEL_ACTIONS = new Map([
  ['transition-ledger:list', 'list'],
  ['transition-ledger:get-by-id', 'getById'],
  ['transition-ledger:get-by-correlation', 'getByCorrelation'],
  ['transition-ledger:get-stats', 'getStats'],
]);

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asBoolean(value, fallback = null) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return fallback;
}

function asFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric;
}

function asNullableString(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeAction(action) {
  const raw = String(action || '').trim().toLowerCase();
  if (raw === 'get' || raw === 'get-by-id' || raw === 'get_by_id' || raw === 'getbyid') return 'getById';
  if (
    raw === 'get-by-correlation'
    || raw === 'get_by_correlation'
    || raw === 'getbycorrelation'
    || raw === 'correlation'
  ) {
    return 'getByCorrelation';
  }
  if (raw === 'stats' || raw === 'get-stats' || raw === 'get_stats' || raw === 'getstats') return 'getStats';
  if (raw === 'list' || raw === 'query') return 'list';
  return null;
}

function buildListFilters(payload) {
  const normalized = asObject(payload);
  const filters = {};

  const includeClosed = asBoolean(normalized.includeClosed, true);
  if (includeClosed !== null) {
    filters.includeClosed = includeClosed;
  }

  const paneId = asNullableString(normalized.paneId, null);
  const phase = asNullableString(normalized.phase, null);
  const intentType = asNullableString(normalized.intentType, null);
  const reasonCode = asNullableString(normalized.reasonCode, null);
  const since = asFiniteNumber(normalized.since, null);
  const until = asFiniteNumber(normalized.until, null);
  const limit = asFiniteNumber(normalized.limit, null);

  if (paneId !== null) filters.paneId = paneId;
  if (phase !== null) filters.phase = phase;
  if (intentType !== null) filters.intentType = intentType;
  if (reasonCode !== null) filters.reasonCode = reasonCode;
  if (since !== null) filters.since = since;
  if (until !== null) filters.until = until;
  if (limit !== null) filters.limit = limit;

  return filters;
}

function executeTransitionLedgerOperation(action, payload = {}) {
  const normalizedAction = normalizeAction(action);
  const normalizedPayload = asObject(payload);

  switch (normalizedAction) {
    case 'list': {
      const filters = buildListFilters(normalizedPayload);
      const items = transitionLedger.listTransitions(filters);
      return {
        ok: true,
        action: normalizedAction,
        count: items.length,
        items,
      };
    }
    case 'getById': {
      const transitionId = asNullableString(
        normalizedPayload.transitionId || normalizedPayload.id,
        null
      );
      if (!transitionId) {
        return {
          ok: false,
          action: normalizedAction,
          reason: 'missing_transition_id',
        };
      }

      const transition = transitionLedger.getTransition(transitionId);
      if (!transition) {
        return {
          ok: false,
          action: normalizedAction,
          reason: 'not_found',
          transitionId,
        };
      }

      return {
        ok: true,
        action: normalizedAction,
        transitionId,
        transition,
      };
    }
    case 'getByCorrelation': {
      const correlationId = asNullableString(
        normalizedPayload.correlationId || normalizedPayload.correlation,
        null
      );
      if (!correlationId) {
        return {
          ok: false,
          action: normalizedAction,
          reason: 'missing_correlation_id',
        };
      }

      const paneId = asNullableString(normalizedPayload.paneId, null);
      const includeClosed = asBoolean(normalizedPayload.includeClosed, true);
      const options = {};
      if (includeClosed !== null) options.includeClosed = includeClosed;

      const transition = paneId !== null
        ? transitionLedger.getByCorrelation(correlationId, paneId, options)
        : transitionLedger.getByCorrelation(correlationId, options);
      if (!transition) {
        return {
          ok: false,
          action: normalizedAction,
          reason: 'not_found',
          correlationId,
          paneId,
        };
      }

      return {
        ok: true,
        action: normalizedAction,
        correlationId,
        paneId,
        transition,
      };
    }
    case 'getStats':
      return {
        ok: true,
        action: normalizedAction,
        stats: transitionLedger.getStats(),
      };
    default:
      return {
        ok: false,
        reason: 'unknown_action',
        action: String(action || '').trim().toLowerCase() || action || null,
      };
  }
}

function registerTransitionLedgerHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerTransitionLedgerHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  for (const [channel, action] of TRANSITION_LEDGER_CHANNEL_ACTIONS.entries()) {
    ipcMain.handle(channel, (event, payload = {}) => executeTransitionLedgerOperation(action, payload));
  }
}

function unregisterTransitionLedgerHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;

  for (const channel of TRANSITION_LEDGER_CHANNEL_ACTIONS.keys()) {
    ipcMain.removeHandler(channel);
  }
}

registerTransitionLedgerHandlers.unregister = unregisterTransitionLedgerHandlers;

module.exports = {
  TRANSITION_LEDGER_CHANNEL_ACTIONS,
  executeTransitionLedgerOperation,
  registerTransitionLedgerHandlers,
  unregisterTransitionLedgerHandlers,
};
