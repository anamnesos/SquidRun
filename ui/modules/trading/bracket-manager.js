'use strict';

const DEFAULT_FIRST_TP_RATIO = 0.5;
const EPSILON = 1e-6;

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function roundDown(value, decimals = 6) {
  const numeric = toNumber(value, 0);
  const factor = 10 ** Math.max(0, decimals);
  return Math.floor((numeric * factor) + 1e-9) / factor;
}

function roundPrice(value, decimals = 4) {
  const numeric = toNumber(value, 0);
  if (numeric <= 0) return 0;
  return Number(numeric.toFixed(Math.max(0, decimals)));
}

function normalizeDirection(direction = '') {
  const normalized = toText(direction).toUpperCase();
  if (normalized === 'BUY') return 'LONG';
  if (normalized === 'SELL') return 'SHORT';
  return normalized === 'SHORT' ? 'SHORT' : 'LONG';
}

function normalizeAsset(asset = '') {
  return toText(asset).toUpperCase();
}

function normalizeOrderPrice(order = {}) {
  return toNumber(order.triggerPx, 0) || toNumber(order.limitPx, 0) || 0;
}

function normalizeOpenOrder(order = {}) {
  return {
    ...order,
    coin: normalizeAsset(order.coin),
    triggerPx: toNumber(order.triggerPx, 0) || null,
    limitPx: toNumber(order.limitPx, 0) || null,
    size: Math.abs(toNumber(order.sz, 0)),
    reduceOnly: order.reduceOnly === true,
    oid: order.oid ?? null,
    price: normalizeOrderPrice(order),
  };
}

function normalizePosition(position = {}) {
  const size = toNumber(position.size ?? position.szi, 0);
  const side = toText(position.side, '').toLowerCase() || (size < 0 ? 'short' : (size > 0 ? 'long' : 'flat'));
  return {
    ...position,
    coin: normalizeAsset(position.coin || position.asset),
    size,
    absSize: Math.abs(size),
    side,
    isLong: side === 'long',
    entryPx: toNumber(position.entryPx, 0),
    stopLossPrice: toNumber(position.stopLossPrice, 0) || null,
    takeProfitPrice: toNumber(position.takeProfitPrice, 0) || null,
  };
}

function choosePriceDecimals(entryPrice = 0, szDecimals = 0) {
  const numeric = toNumber(entryPrice, 0);
  if (numeric >= 1000) return 1;
  if (numeric >= 100) return 2;
  if (numeric >= 1) return 4;
  return Math.max(4, Number(szDecimals) || 4);
}

function buildBracketPlan(input = {}) {
  const asset = normalizeAsset(input.asset);
  const direction = normalizeDirection(input.direction);
  const initialSize = roundDown(input.size, input.szDecimals ?? 6);
  const entryPrice = toNumber(input.entryPrice, 0);
  const stopPrice = toNumber(input.stopPrice, 0);
  const firstTakeProfitPrice = toNumber(input.takeProfitPrice1 ?? input.firstTakeProfitPrice, 0);
  const runnerTakeProfitPrice = toNumber(input.takeProfitPrice2 ?? input.runnerTakeProfitPrice, 0);
  const firstTpRatio = Math.max(0.05, Math.min(0.95, toNumber(input.firstTakeProfitRatio, DEFAULT_FIRST_TP_RATIO) || DEFAULT_FIRST_TP_RATIO));
  const sizeDecimals = Math.max(0, Number(input.szDecimals) || 0);
  const priceDecimals = choosePriceDecimals(entryPrice, sizeDecimals);

  if (!asset) throw new Error('Bracket plan requires asset');
  if (initialSize <= 0) throw new Error('Bracket plan requires a positive size');
  if (entryPrice <= 0) throw new Error('Bracket plan requires entry price');
  if (stopPrice <= 0) throw new Error('Bracket plan requires stop price');
  if (firstTakeProfitPrice <= 0) throw new Error('Bracket plan requires first take profit price');

  let firstTakeProfitSize = roundDown(initialSize * firstTpRatio, sizeDecimals);
  let remainderSize = roundDown(initialSize - firstTakeProfitSize, sizeDecimals);
  if (firstTakeProfitSize <= 0 || remainderSize <= 0) {
    firstTakeProfitSize = roundDown(initialSize / 2, sizeDecimals);
    remainderSize = roundDown(initialSize - firstTakeProfitSize, sizeDecimals);
  }
  if (firstTakeProfitSize <= 0 || remainderSize <= 0) {
    throw new Error('Bracket plan requires enough size to split into TP1 and runner');
  }

  const breakEvenStopPrice = roundPrice(
    input.breakEvenStopPrice || entryPrice,
    priceDecimals
  );

  return {
    asset,
    coin: asset,
    direction,
    isLong: direction === 'LONG',
    entryPrice: roundPrice(entryPrice, priceDecimals),
    stopPrice: roundPrice(stopPrice, priceDecimals),
    firstTakeProfitPrice: roundPrice(firstTakeProfitPrice, priceDecimals),
    runnerTakeProfitPrice: runnerTakeProfitPrice > 0 ? roundPrice(runnerTakeProfitPrice, priceDecimals) : null,
    breakEvenStopPrice,
    initialSize,
    firstTakeProfitSize,
    runnerSize: remainderSize,
    firstTakeProfitRatio: Number(firstTpRatio.toFixed(4)),
    firstTakeProfitOrderId: input.firstTakeProfitOrderId ?? null,
    sizeDecimals,
    priceDecimals,
  };
}

function splitReduceOnlyOrders(position = {}, openOrders = []) {
  const normalizedPosition = normalizePosition(position);
  const entryPrice = normalizedPosition.entryPx;
  const reduceOnlyOrders = (Array.isArray(openOrders) ? openOrders : [])
    .map((order) => normalizeOpenOrder(order))
    .filter((order) => order.coin === normalizedPosition.coin && order.reduceOnly === true && order.price > 0);

  const stopOrders = [];
  const takeProfitOrders = [];
  for (const order of reduceOnlyOrders) {
    const isStopCandidate = normalizedPosition.isLong
      ? order.price <= (entryPrice + EPSILON)
      : order.price >= (entryPrice - EPSILON);
    if (isStopCandidate) {
      stopOrders.push(order);
    } else {
      takeProfitOrders.push(order);
    }
  }

  const sortAscending = (a, b) => a.price - b.price;
  stopOrders.sort(sortAscending);
  takeProfitOrders.sort(sortAscending);
  return { stopOrders, takeProfitOrders };
}

function nearlyEqual(left, right, tolerance = EPSILON) {
  return Math.abs(toNumber(left, 0) - toNumber(right, 0)) <= tolerance;
}

function sameOrderId(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return String(left).trim() === String(right).trim();
}

function deriveBracketState(input = {}) {
  const bracketPlan = buildBracketPlan(input.bracketPlan || input);
  const position = normalizePosition(input.position || {});
  const normalizedOrders = (Array.isArray(input.openOrders) ? input.openOrders : []).map((order) => normalizeOpenOrder(order));
  const { stopOrders, takeProfitOrders } = splitReduceOnlyOrders(position, input.openOrders || []);
  const currentSize = position.absSize;
  const flat = currentSize <= EPSILON;
  const tp1OrderId = bracketPlan.firstTakeProfitOrderId ?? input.firstTakeProfitOrderId ?? null;
  const runnerSizeReached = !flat && currentSize <= (bracketPlan.runnerSize + EPSILON);
  const tp1OrderStillOpen = tp1OrderId != null && normalizedOrders.some((order) => {
    return order.coin === position.coin
      && order.reduceOnly === true
      && sameOrderId(order.oid, tp1OrderId);
  });
  const firstTakeProfitFilled = runnerSizeReached && tp1OrderId != null && !tp1OrderStillOpen;
  const inferredBreakEvenStop = normalizedOrders.find((order) => {
    return order.coin === position.coin
      && order.reduceOnly === true
      && nearlyEqual(order.price, bracketPlan.breakEvenStopPrice, 10 ** (-Math.max(2, bracketPlan.priceDecimals)));
  }) || null;
  const activeStopOrder = stopOrders[bracketPlan.isLong ? stopOrders.length - 1 : 0] || inferredBreakEvenStop;
  const activeTakeProfitOrder = (
    tp1OrderId != null
      ? takeProfitOrders.find((order) => sameOrderId(order.oid, tp1OrderId))
      : null
  ) || (bracketPlan.isLong ? takeProfitOrders[0] : takeProfitOrders[takeProfitOrders.length - 1]) || null;
  const stopAtBreakEven = activeStopOrder
    ? nearlyEqual(activeStopOrder.price, bracketPlan.breakEvenStopPrice, 10 ** (-Math.max(2, bracketPlan.priceDecimals)))
    : false;
  const needsBreakEvenStopMove = firstTakeProfitFilled && !stopAtBreakEven;

  return {
    bracketPlan,
    currentSize,
    flat,
    tp1OrderId,
    tp1OrderStillOpen,
    runnerSizeReached,
    firstTakeProfitFilled,
    activeStopOrder,
    activeTakeProfitOrder,
    stopAtBreakEven,
    needsBreakEvenStopMove,
    cancelOrderIds: needsBreakEvenStopMove ? stopOrders.map((order) => order.oid).filter((value) => value != null) : [],
    replacementStopPrice: needsBreakEvenStopMove ? bracketPlan.breakEvenStopPrice : null,
    state: flat
      ? 'closed'
      : (needsBreakEvenStopMove
        ? 'tp1_filled_pending_stop_move'
        : (firstTakeProfitFilled ? 'runner_protected' : 'entry_protected')),
  };
}

function deriveExchangeProtection(position = {}, openOrders = []) {
  const normalizedPosition = normalizePosition(position);
  if (!normalizedPosition.coin || normalizedPosition.entryPx <= 0) {
    return {
      stopOrders: [],
      takeProfitOrders: [],
      activeStopOrder: null,
      activeTakeProfitOrder: null,
      activeStopPrice: null,
      activeTakeProfitPrice: null,
      verified: false,
    };
  }
  const { stopOrders, takeProfitOrders } = splitReduceOnlyOrders(normalizedPosition, openOrders);
  const activeStopOrder = normalizedPosition.isLong
    ? (stopOrders[stopOrders.length - 1] || null)
    : (stopOrders[0] || null);
  const activeTakeProfitOrder = normalizedPosition.isLong
    ? (takeProfitOrders[0] || null)
    : (takeProfitOrders[takeProfitOrders.length - 1] || null);
  return {
    stopOrders,
    takeProfitOrders,
    activeStopOrder,
    activeTakeProfitOrder,
    activeStopPrice: activeStopOrder?.price || null,
    activeTakeProfitPrice: activeTakeProfitOrder?.price || null,
    verified: true,
  };
}

module.exports = {
  DEFAULT_FIRST_TP_RATIO,
  buildBracketPlan,
  splitReduceOnlyOrders,
  deriveBracketState,
  deriveExchangeProtection,
  normalizePosition,
  normalizeOpenOrder,
  normalizeDirection,
  sameOrderId,
};
