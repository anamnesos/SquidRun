'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const bracketManager = require('../modules/trading/bracket-manager');
const manualStopOverrides = require('../modules/trading/manual-stop-overrides');
const hmx = require('./hm-defi-execute');

function findLiveStopOrders(position = null, openOrders = []) {
  if (!position) return [];
  const bracketPosition = {
    coin: position.coin || 'ORDI',
    size: Number(position.szi || 0),
    entryPx: Number(position.entryPx || 0),
  };
  return bracketManager.splitReduceOnlyOrders(bracketPosition, openOrders).stopOrders;
}

function resolveStopOrderIdsToCancel({
  auditStopOrderId = null,
  liveStopOrders = [],
} = {}) {
  if (auditStopOrderId != null) {
    return [auditStopOrderId];
  }
  return Array.from(new Set(
    (Array.isArray(liveStopOrders) ? liveStopOrders : [])
      .map((order) => order?.oid)
      .filter((value) => value != null)
  ));
}

async function main() {
  const { HttpTransport, ExchangeClient, InfoClient } = await import('@nktkas/hyperliquid');
  const { privateKeyToAccount } = require('viem/accounts');
  const { privateKey, walletAddress } = hmx.ensureDeFiSecrets();

  const wallet = privateKeyToAccount(privateKey);
  const transport = new HttpTransport();
  const info = new InfoClient({ transport });
  const exchange = new ExchangeClient({ transport, wallet });

  const hlClient = require('../modules/trading/hyperliquid-client');
  const meta = await info.meta();
  const ordiAsset = hmx.findAssetMeta(meta, 'ORDI');
  const assetIndex = ordiAsset.assetIndex;
  const szDecimals = hmx.resolveAssetSzDecimals(ordiAsset, 0);

  const clearing = await info.clearinghouseState({ user: walletAddress });
  const pos = (clearing?.assetPositions || []).map((e) => e?.position || {}).find((p) => (p.coin || '').toUpperCase() === 'ORDI');
  if (!pos) throw new Error('No ORDI position');
  const size = Math.abs(Number(pos.szi));
  const isLong = Number(pos.szi) > 0;
  console.log('Pos: size=', size, 'isLong=', isLong, 'entry=', pos.entryPx);

  const openOrders = await hlClient.getOpenOrders({ walletAddress, infoClient: info });
  const liveStopOrders = findLiveStopOrders(pos, openOrders);
  const auditedStopOrder = hmx.findLatestActiveHyperliquidTriggerOrderFromAudit({
    assetIndex,
    tpsl: 'sl',
  });
  const stopOrderIdsToCancel = resolveStopOrderIdsToCancel({
    auditStopOrderId: auditedStopOrder?.oid ?? null,
    liveStopOrders,
  });

  console.log('ORDI live stop orders:', JSON.stringify(liveStopOrders, null, 2));
  console.log('ORDI audited stop order:', JSON.stringify(auditedStopOrder, null, 2));

  if (stopOrderIdsToCancel.length) {
    const cancels = stopOrderIdsToCancel.map((oid) => ({ a: assetIndex, o: oid }));
    const cancelRes = await hmx.executeHyperliquidCancel(exchange, { cancels }, { label: 'arch-ordi-widen-cancel' });
    console.log('Cancel result:', JSON.stringify(cancelRes, null, 2));
  } else {
    console.log('No existing ORDI stops to cancel.');
  }

  const newStopPrice = 4.35;
  const placeRes = await hmx.placeHyperliquidStopLoss({
    exchange,
    assetIndex,
    isLong,
    size,
    stopPrice: newStopPrice,
    referencePrice: Number(pos.entryPx),
    szDecimals,
      executionOptions: { label: 'arch-ordi-widen-place' },
  });
  console.log('New SL result:', JSON.stringify(placeRes, null, 2));
  manualStopOverrides.registerManualStopOverride({
    asset: 'ORDI',
    ownerAgentId: 'architect',
    mode: 'wick_clearance',
    reason: 'manual_wick_clearance_widen',
    stopOrderId: hmx.extractHyperliquidOrderId(placeRes),
    stopPrice: newStopPrice,
    entryPrice: Number(pos.entryPx),
    setAt: new Date().toISOString(),
  });
}

if (require.main === module) {
  main().catch((e) => { console.error(e?.stack || e?.message || String(e)); process.exit(1); });
}

module.exports = {
  findLiveStopOrders,
  resolveStopOrderIdsToCancel,
  main,
};
