#!/usr/bin/env node
'use strict';

/**
 * hm-defi-execute.js — DeFi execution pipeline
 *
 * Bridges ETH from mainnet to Arbitrum, swaps to USDC, deposits to Hyperliquid,
 * and opens a leveraged perp position.
 *
 * Usage:
 *   node ui/scripts/hm-defi-execute.js status          — Check wallet balances across chains
 *   node ui/scripts/hm-defi-execute.js bridge           — Bridge ETH mainnet → Arbitrum
 *   node ui/scripts/hm-defi-execute.js swap             — Swap ETH → USDC on Arbitrum
 *   node ui/scripts/hm-defi-execute.js deposit          — Deposit USDC to Hyperliquid
 *   node ui/scripts/hm-defi-execute.js trade            — Open short ETH position on Hyperliquid
 *   node ui/scripts/hm-defi-execute.js full-send        — Run entire pipeline end-to-end
 *   node ui/scripts/hm-defi-execute.js --dry-run <cmd>  — Show what would happen without executing
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;
const WALLET_ADDRESS = process.env.POLYMARKET_FUNDER_ADDRESS;

if (!PRIVATE_KEY || !WALLET_ADDRESS) {
  console.error('Missing POLYMARKET_PRIVATE_KEY or POLYMARKET_FUNDER_ADDRESS in .env');
  process.exit(1);
}

// ── Contract addresses ──────────────────────────────────────────────
const CONTRACTS = {
  // Arbitrum canonical bridge (L1 inbox for ETH deposits)
  ARB_INBOX: '0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f',
  // USDC on Arbitrum
  USDC_ARBITRUM: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  // Hyperliquid bridge on Arbitrum
  HL_BRIDGE: '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7',
  // Uniswap V3 SwapRouter02 on Arbitrum
  UNISWAP_ROUTER: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  // WETH on Arbitrum
  WETH_ARBITRUM: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
};

// ── Trade config ────────────────────────────────────────────────────
const TRADE_CONFIG = {
  direction: 'SHORT',
  asset: 'ETH',
  leverage: 5,
  // Reserve 5 USDC for gas/fees, use rest as collateral
  reserveUsdc: 5,
  // Stop loss: 8% above entry
  stopLossPct: 0.08,
  // Take profit: scale at -7%, full at -12%
  takeProfitPct1: 0.07,
  takeProfitPct2: 0.12,
};

// ── Helpers ─────────────────────────────────────────────────────────
const isDryRun = process.argv.includes('--dry-run');
const command = process.argv.filter(a => !a.startsWith('--')).slice(2)[0] || 'status';

function log(msg) { console.log(`[defi] ${msg}`); }
function warn(msg) { console.log(`[defi][WARN] ${msg}`); }
function err(msg) { console.error(`[defi][ERROR] ${msg}`); }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Step 0: Status ──────────────────────────────────────────────────
async function checkStatus() {
  const { createPublicClient, http, formatEther, formatUnits } = require('viem');
  const { mainnet, arbitrum } = require('viem/chains');

  const ethClient = createPublicClient({ chain: mainnet, transport: http() });
  const arbClient = createPublicClient({ chain: arbitrum, transport: http() });

  // ETH balance on mainnet
  const ethBalance = await ethClient.getBalance({ address: WALLET_ADDRESS });
  const ethBalanceFormatted = formatEther(ethBalance);

  // ETH balance on Arbitrum
  const arbEthBalance = await arbClient.getBalance({ address: WALLET_ADDRESS });
  const arbEthFormatted = formatEther(arbEthBalance);

  // USDC balance on Arbitrum
  let usdcBalance = 0n;
  try {
    usdcBalance = await arbClient.readContract({
      address: CONTRACTS.USDC_ARBITRUM,
      abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view',
              inputs: [{ name: 'account', type: 'address' }],
              outputs: [{ name: '', type: 'uint256' }] }],
      functionName: 'balanceOf',
      args: [WALLET_ADDRESS],
    });
  } catch (_) { /* no USDC */ }
  const usdcFormatted = formatUnits(usdcBalance, 6);

  // Get ETH price (rough, from Uniswap TWAP or just use a known value)
  // For now, we'll estimate
  const ethPriceEstimate = 2100; // Will be overridden by live data in trade step

  log('=== Wallet Status ===');
  log(`Address: ${WALLET_ADDRESS}`);
  log(`Mainnet ETH:  ${ethBalanceFormatted} ETH (~$${(parseFloat(ethBalanceFormatted) * ethPriceEstimate).toFixed(2)})`);
  log(`Arbitrum ETH: ${arbEthFormatted} ETH (~$${(parseFloat(arbEthFormatted) * ethPriceEstimate).toFixed(2)})`);
  log(`Arbitrum USDC: ${usdcFormatted} USDC`);
  log(`ETH price est: ~$${ethPriceEstimate}`);

  return {
    mainnetEth: parseFloat(ethBalanceFormatted),
    arbEth: parseFloat(arbEthFormatted),
    arbUsdc: parseFloat(usdcFormatted),
    ethPrice: ethPriceEstimate,
  };
}

// ── Step 1: Bridge ETH to Arbitrum ──────────────────────────────────
async function bridgeToArbitrum() {
  const { createPublicClient, createWalletClient, http, formatEther, parseEther } = require('viem');
  const { mainnet } = require('viem/chains');
  const { privateKeyToAccount } = require('viem/accounts');

  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: mainnet, transport: http() });
  const walletClient = createWalletClient({ account, chain: mainnet, transport: http() });

  // Check balance
  const balance = await publicClient.getBalance({ address: WALLET_ADDRESS });
  const ethBal = parseFloat(formatEther(balance));
  log(`Mainnet ETH balance: ${ethBal.toFixed(6)} ETH`);

  if (ethBal < 0.005) {
    err('Not enough ETH on mainnet to bridge (need at least 0.005 ETH)');
    return null;
  }

  // Keep 0.005 ETH for gas, bridge the rest
  const gasReserve = 0.005;
  const bridgeAmount = ethBal - gasReserve;
  const bridgeWei = parseEther(bridgeAmount.toFixed(18));

  log(`Bridging ${bridgeAmount.toFixed(6)} ETH to Arbitrum (keeping ${gasReserve} ETH for gas)`);

  if (isDryRun) {
    log('[DRY RUN] Would call Arbitrum Inbox depositEth()');
    log(`[DRY RUN] Amount: ${bridgeAmount.toFixed(6)} ETH`);
    return bridgeAmount;
  }

  // Arbitrum Inbox depositEth — creates a retryable ticket that deposits ETH on L2
  const INBOX_ABI = [{
    name: 'depositEth',
    type: 'function',
    stateMutability: 'payable',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  }];

  try {
    const hash = await walletClient.writeContract({
      address: CONTRACTS.ARB_INBOX,
      abi: INBOX_ABI,
      functionName: 'depositEth',
      value: bridgeWei,
    });

    log(`Bridge TX submitted: ${hash}`);
    log('Waiting for confirmation...');

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    log(`Bridge TX confirmed in block ${receipt.blockNumber}`);
    log('ETH will arrive on Arbitrum in ~10-15 minutes');

    return bridgeAmount;
  } catch (e) {
    err(`Bridge failed: ${e.message}`);
    return null;
  }
}

// ── Step 2: Swap ETH → USDC on Arbitrum ─────────────────────────────
async function swapEthToUsdc() {
  const { createPublicClient, createWalletClient, http, formatEther, formatUnits, parseEther, encodeFunctionData } = require('viem');
  const { arbitrum } = require('viem/chains');
  const { privateKeyToAccount } = require('viem/accounts');

  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: arbitrum, transport: http() });
  const walletClient = createWalletClient({ account, chain: arbitrum, transport: http() });

  // Check ARB ETH balance
  const balance = await publicClient.getBalance({ address: WALLET_ADDRESS });
  const ethBal = parseFloat(formatEther(balance));
  log(`Arbitrum ETH balance: ${ethBal.toFixed(6)} ETH`);

  if (ethBal < 0.005) {
    err('Not enough ETH on Arbitrum to swap (need at least 0.005 ETH)');
    return null;
  }

  // Keep small amount for Arbitrum gas, swap the rest
  const arbGasReserve = 0.001; // Arbitrum gas is pennies
  const swapAmount = ethBal - arbGasReserve;
  const swapWei = parseEther(swapAmount.toFixed(18));

  log(`Swapping ${swapAmount.toFixed(6)} ETH → USDC on Uniswap V3`);

  if (isDryRun) {
    log('[DRY RUN] Would call Uniswap V3 exactInputSingle()');
    log(`[DRY RUN] Input: ${swapAmount.toFixed(6)} ETH`);
    log('[DRY RUN] Output: ~USDC (market rate, 0.5% slippage tolerance)');
    return swapAmount * 2100; // rough estimate
  }

  // Uniswap V3 SwapRouter02 exactInputSingle
  // We use the WETH/USDC 0.05% pool on Arbitrum (highest liquidity)
  const SWAP_ABI = [{
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'recipient', type: 'address' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  }];

  // Minimum USDC out: swap amount * $2000 * 0.995 (0.5% slippage) → in 6 decimals
  const minOutUsdc = BigInt(Math.floor(swapAmount * 2000 * 0.995 * 1e6));

  try {
    const hash = await walletClient.writeContract({
      address: CONTRACTS.UNISWAP_ROUTER,
      abi: SWAP_ABI,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: CONTRACTS.WETH_ARBITRUM,
        tokenOut: CONTRACTS.USDC_ARBITRUM,
        fee: 500, // 0.05% pool
        recipient: WALLET_ADDRESS,
        amountIn: swapWei,
        amountOutMinimum: minOutUsdc,
        sqrtPriceLimitX96: 0n,
      }],
      value: swapWei, // Send ETH, router wraps it
    });

    log(`Swap TX submitted: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    log(`Swap confirmed in block ${receipt.blockNumber}`);

    // Check resulting USDC balance
    const usdcBal = await publicClient.readContract({
      address: CONTRACTS.USDC_ARBITRUM,
      abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view',
              inputs: [{ name: 'account', type: 'address' }],
              outputs: [{ name: '', type: 'uint256' }] }],
      functionName: 'balanceOf',
      args: [WALLET_ADDRESS],
    });
    const usdcFormatted = parseFloat(formatUnits(usdcBal, 6));
    log(`USDC balance after swap: ${usdcFormatted.toFixed(2)} USDC`);

    return usdcFormatted;
  } catch (e) {
    err(`Swap failed: ${e.message}`);
    return null;
  }
}

// ── Step 3: Deposit USDC to Hyperliquid ─────────────────────────────
async function depositToHyperliquid() {
  const { createPublicClient, createWalletClient, http, formatUnits, parseUnits } = require('viem');
  const { arbitrum } = require('viem/chains');
  const { privateKeyToAccount } = require('viem/accounts');

  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: arbitrum, transport: http() });
  const walletClient = createWalletClient({ account, chain: arbitrum, transport: http() });

  // Check USDC balance
  const ERC20_ABI = [
    { name: 'balanceOf', type: 'function', stateMutability: 'view',
      inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
    { name: 'allowance', type: 'function', stateMutability: 'view',
      inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }] },
    { name: 'approve', type: 'function', stateMutability: 'nonpayable',
      inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
      outputs: [{ name: '', type: 'bool' }] },
    { name: 'transfer', type: 'function', stateMutability: 'nonpayable',
      inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
      outputs: [{ name: '', type: 'bool' }] },
  ];

  const usdcBal = await publicClient.readContract({
    address: CONTRACTS.USDC_ARBITRUM,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [WALLET_ADDRESS],
  });
  const usdcAmount = parseFloat(formatUnits(usdcBal, 6));
  log(`Arbitrum USDC balance: ${usdcAmount.toFixed(2)} USDC`);

  if (usdcAmount < 5) {
    err('Less than 5 USDC — below Hyperliquid minimum deposit. Aborting.');
    return null;
  }

  // Deposit all USDC (Hyperliquid bridge is a simple transfer, no approve needed)
  log(`Depositing ${usdcAmount.toFixed(2)} USDC to Hyperliquid bridge`);

  if (isDryRun) {
    log('[DRY RUN] Would transfer USDC to Hyperliquid bridge');
    log(`[DRY RUN] Amount: ${usdcAmount.toFixed(2)} USDC`);
    return usdcAmount;
  }

  try {
    const hash = await walletClient.writeContract({
      address: CONTRACTS.USDC_ARBITRUM,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [CONTRACTS.HL_BRIDGE, usdcBal],
    });

    log(`Deposit TX submitted: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    log(`Deposit confirmed in block ${receipt.blockNumber}`);
    log('USDC should appear on Hyperliquid within 1-2 minutes');

    return usdcAmount;
  } catch (e) {
    err(`Deposit failed: ${e.message}`);
    return null;
  }
}

// ── Step 4: Open short on Hyperliquid ───────────────────────────────
async function openHyperliquidShort() {
  // Dynamic import for ESM-only package
  const { HttpTransport, ExchangeClient, InfoClient } = await import('@nktkas/hyperliquid');
  const { privateKeyToAccount } = require('viem/accounts');

  const wallet = privateKeyToAccount(PRIVATE_KEY);
  const transport = new HttpTransport();
  const info = new InfoClient({ transport });
  const exchange = new ExchangeClient({ transport, wallet });

  // Get account state on Hyperliquid
  const clearinghouse = await info.clearinghouseState({ user: WALLET_ADDRESS });
  const availableBalance = parseFloat(clearinghouse.marginSummary.accountValue);
  log(`Hyperliquid account value: $${availableBalance.toFixed(2)}`);

  if (availableBalance < 10) {
    err(`Only $${availableBalance.toFixed(2)} on Hyperliquid — need at least $10. Deposit may still be arriving.`);
    return null;
  }

  // Get ETH asset info
  const meta = await info.meta();
  const ethAsset = meta.universe.find(a => a.name === 'ETH');
  if (!ethAsset) { err('ETH not found in Hyperliquid universe'); return null; }
  const ethIndex = meta.universe.indexOf(ethAsset);
  log(`ETH asset index: ${ethIndex}, szDecimals: ${ethAsset.szDecimals}`);

  // Get current ETH price
  const mids = await info.allMids();
  const ethPrice = parseFloat(mids['ETH']);
  log(`ETH mid price: $${ethPrice.toFixed(2)}`);

  // Calculate position size
  const collateral = availableBalance - TRADE_CONFIG.reserveUsdc;
  const notional = collateral * TRADE_CONFIG.leverage;
  const sizeEth = notional / ethPrice;
  // Round down to szDecimals
  const szDecimals = ethAsset.szDecimals || 4;
  const sizeRounded = Math.floor(sizeEth * Math.pow(10, szDecimals)) / Math.pow(10, szDecimals);

  log(`Trade plan:`);
  log(`  Direction: ${TRADE_CONFIG.direction}`);
  log(`  Collateral: $${collateral.toFixed(2)}`);
  log(`  Leverage: ${TRADE_CONFIG.leverage}x`);
  log(`  Notional: $${notional.toFixed(2)}`);
  log(`  Size: ${sizeRounded} ETH`);
  log(`  Stop loss: $${(ethPrice * (1 + TRADE_CONFIG.stopLossPct)).toFixed(2)} (${(TRADE_CONFIG.stopLossPct * 100).toFixed(0)}% above entry)`);
  log(`  TP1: $${(ethPrice * (1 - TRADE_CONFIG.takeProfitPct1)).toFixed(2)} (${(TRADE_CONFIG.takeProfitPct1 * 100).toFixed(0)}% below)`);
  log(`  TP2: $${(ethPrice * (1 - TRADE_CONFIG.takeProfitPct2)).toFixed(2)} (${(TRADE_CONFIG.takeProfitPct2 * 100).toFixed(0)}% below)`);

  if (sizeRounded <= 0) {
    err('Position size too small after rounding');
    return null;
  }

  if (isDryRun) {
    log('[DRY RUN] Would set leverage and open short');
    return { size: sizeRounded, price: ethPrice, collateral };
  }

  try {
    // Set leverage
    log(`Setting ${TRADE_CONFIG.leverage}x isolated leverage on ETH...`);
    await exchange.updateLeverage({
      asset: ethIndex,
      isCross: false, // isolated for risk control
      leverage: TRADE_CONFIG.leverage,
    });
    log('Leverage set');

    // Open short — use IOC with aggressive price (1% below mid for sell/short)
    const limitPrice = (ethPrice * 0.99).toFixed(1);
    log(`Opening short: ${sizeRounded} ETH @ limit $${limitPrice} (IOC)...`);

    const result = await exchange.order({
      orders: [{
        a: ethIndex,
        b: false, // isBuy: false = SHORT
        p: limitPrice,
        s: sizeRounded.toString(),
        r: false, // not reduceOnly
        t: { limit: { tif: 'Ioc' } },
      }],
      grouping: 'na',
    });

    log(`Order result: ${JSON.stringify(result)}`);

    // Set stop loss as a separate order
    const stopPrice = (ethPrice * (1 + TRADE_CONFIG.stopLossPct)).toFixed(1);
    log(`Setting stop loss: BUY ${sizeRounded} ETH @ $${stopPrice}...`);

    await exchange.order({
      orders: [{
        a: ethIndex,
        b: true, // isBuy: true = cover the short
        p: stopPrice,
        s: sizeRounded.toString(),
        r: true, // reduceOnly
        t: { trigger: { triggerPx: stopPrice, isMarket: true, tpsl: 'sl' } },
      }],
      grouping: 'na',
    });
    log('Stop loss set');

    // Set take profit
    const tpPrice = (ethPrice * (1 - TRADE_CONFIG.takeProfitPct2)).toFixed(1);
    log(`Setting take profit: BUY ${sizeRounded} ETH @ $${tpPrice}...`);

    await exchange.order({
      orders: [{
        a: ethIndex,
        b: true,
        p: tpPrice,
        s: sizeRounded.toString(),
        r: true,
        t: { trigger: { triggerPx: tpPrice, isMarket: true, tpsl: 'tp' } },
      }],
      grouping: 'na',
    });
    log('Take profit set');

    return { size: sizeRounded, price: ethPrice, collateral };
  } catch (e) {
    err(`Trade failed: ${e.message}`);
    if (e.response) err(`Response: ${JSON.stringify(e.response)}`);
    return null;
  }
}

// ── Step 5: Full pipeline ───────────────────────────────────────────
async function fullSend() {
  log('=== FULL SEND: ETH → Arbitrum → USDC → Hyperliquid → Short ETH ===');
  if (isDryRun) log('*** DRY RUN MODE — no transactions will be sent ***');

  // Check starting state
  const status = await checkStatus();

  // Decide what steps are needed
  if (status.arbUsdc >= 10) {
    log('Already have USDC on Arbitrum — skipping bridge and swap');
    const deposited = await depositToHyperliquid();
    if (!deposited && !isDryRun) return;
    if (!isDryRun) {
      log('Waiting 90s for Hyperliquid to credit deposit...');
      await sleep(90000);
    }
    return await openHyperliquidShort();
  }

  if (status.arbEth >= 0.005) {
    log('Already have ETH on Arbitrum — skipping bridge');
    const swapped = await swapEthToUsdc();
    if (!swapped && !isDryRun) return;
    const deposited = await depositToHyperliquid();
    if (!deposited && !isDryRun) return;
    if (!isDryRun) {
      log('Waiting 90s for Hyperliquid to credit deposit...');
      await sleep(90000);
    }
    return await openHyperliquidShort();
  }

  if (status.mainnetEth < 0.01) {
    err('Not enough ETH anywhere to proceed');
    return null;
  }

  // Full pipeline
  log('\n--- Step 1/4: Bridge ETH to Arbitrum ---');
  const bridged = await bridgeToArbitrum();
  if (!bridged && !isDryRun) return;

  if (!isDryRun) {
    log('Waiting for bridge confirmation (~10-15 min)...');
    // Poll Arbitrum balance until ETH arrives
    const { createPublicClient, http, formatEther } = require('viem');
    const { arbitrum } = require('viem/chains');
    const arbClient = createPublicClient({ chain: arbitrum, transport: http() });

    for (let i = 0; i < 40; i++) { // max 20 min
      await sleep(30000);
      const bal = await arbClient.getBalance({ address: WALLET_ADDRESS });
      const ethBal = parseFloat(formatEther(bal));
      log(`[poll ${i+1}/40] Arbitrum ETH: ${ethBal.toFixed(6)}`);
      if (ethBal >= 0.005) {
        log('ETH arrived on Arbitrum!');
        break;
      }
    }
  }

  log('\n--- Step 2/4: Swap ETH → USDC ---');
  const swapped = await swapEthToUsdc();
  if (!swapped && !isDryRun) return;

  log('\n--- Step 3/4: Deposit USDC to Hyperliquid ---');
  const deposited = await depositToHyperliquid();
  if (!deposited && !isDryRun) return;

  if (!isDryRun) {
    log('Waiting 90s for Hyperliquid to credit deposit...');
    await sleep(90000);
  }

  log('\n--- Step 4/4: Open Short ETH ---');
  const trade = await openHyperliquidShort();
  if (trade) {
    log('\n=== FULL SEND COMPLETE ===');
    log(`Shorted ${trade.size} ETH @ ~$${trade.price.toFixed(2)}, ${TRADE_CONFIG.leverage}x leverage`);
    log(`Collateral: $${trade.collateral.toFixed(2)}`);
    log(`Stop loss set, take profit set. Swing trade — check back in 1-3 days.`);
  }
  return trade;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  try {
    let result;
    switch (command) {
      case 'status':     result = await checkStatus(); break;
      case 'bridge':     result = await bridgeToArbitrum(); break;
      case 'swap':       result = await swapEthToUsdc(); break;
      case 'deposit':    result = await depositToHyperliquid(); break;
      case 'trade':      result = await openHyperliquidShort(); break;
      case 'full-send':  result = await fullSend(); break;
      default:
        err(`Unknown command: ${command}`);
        err('Usage: node hm-defi-execute.js [status|bridge|swap|deposit|trade|full-send] [--dry-run]');
        process.exit(1);
    }
    if (result == null && command !== 'status') {
      process.exitCode = 1;
    }
    return result;
  } catch (e) {
    err(`Fatal: ${e.message}`);
    console.error(e);
    process.exit(1);
  }
}

main();
