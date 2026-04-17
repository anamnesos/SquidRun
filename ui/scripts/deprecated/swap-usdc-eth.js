'use strict';

const { ethers } = require('../node_modules/ethers');
const path = require('path');

// Load .env
require('../node_modules/dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const WALLET_ADDRESS = '0xdB7C9aaFE57A8aa125Fc0E9C9472869fEcb9699B';
const RPC_URL = 'https://eth.llamarpc.com';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
];

const SWAP_ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

async function main() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    console.error('ERROR: POLYMARKET_PRIVATE_KEY not found in .env');
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log('Wallet:', wallet.address);
  if (wallet.address.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
    console.error('ERROR: Private key does not match expected wallet address');
    process.exit(1);
  }

  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
  const router = new ethers.Contract(UNISWAP_V3_ROUTER, SWAP_ROUTER_ABI, wallet);

  // Check balances
  const usdcBalance = await usdc.balanceOf(wallet.address);
  const ethBalance = await provider.getBalance(wallet.address);
  const gasPrice = await provider.getGasPrice();

  console.log('USDC balance:', ethers.utils.formatUnits(usdcBalance, 6));
  console.log('ETH balance:', ethers.utils.formatEther(ethBalance));
  console.log('Gas price:', ethers.utils.formatUnits(gasPrice, 'gwei'), 'gwei');

  if (usdcBalance.isZero()) {
    console.error('ERROR: No USDC to swap');
    process.exit(1);
  }

  // Step 1: Approve USDC spending
  const currentAllowance = await usdc.allowance(wallet.address, UNISWAP_V3_ROUTER);
  if (currentAllowance.lt(usdcBalance)) {
    console.log('\nApproving USDC for Uniswap Router...');
    const approveTx = await usdc.approve(UNISWAP_V3_ROUTER, ethers.constants.MaxUint256, {
      gasPrice: gasPrice.mul(120).div(100), // 20% buffer
    });
    console.log('Approval tx:', approveTx.hash);
    const approveReceipt = await approveTx.wait();
    console.log('Approval confirmed in block', approveReceipt.blockNumber);
    console.log('Gas used:', approveReceipt.gasUsed.toString());
  } else {
    console.log('USDC already approved');
  }

  // Step 2: Swap USDC -> WETH via Uniswap V3
  // Use 0.05% fee tier (500) — best for stablecoin/ETH pairs
  // 2% slippage tolerance
  const amountIn = usdcBalance;
  // Rough ETH price ~$2200, so $162 ≈ 0.0737 ETH. Accept 2% slippage.
  const minOut = ethers.utils.parseEther('0.072'); // ~2% below quote

  const deadline = Math.floor(Date.now() / 1000) + 600; // 10 minutes

  const swapParams = {
    tokenIn: USDC_ADDRESS,
    tokenOut: WETH_ADDRESS,
    fee: 500, // 0.05% pool
    recipient: wallet.address,
    deadline,
    amountIn,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0,
  };

  console.log('\nSwapping', ethers.utils.formatUnits(amountIn, 6), 'USDC -> ETH...');
  console.log('Minimum ETH out:', ethers.utils.formatEther(minOut));

  try {
    const swapTx = await router.exactInputSingle(swapParams, {
      gasPrice: gasPrice.mul(120).div(100),
      gasLimit: 300000,
    });
    console.log('Swap tx:', swapTx.hash);
    console.log('Waiting for confirmation...');
    const swapReceipt = await swapTx.wait();
    console.log('\n=== SWAP COMPLETE ===');
    console.log('Block:', swapReceipt.blockNumber);
    console.log('Gas used:', swapReceipt.gasUsed.toString());
    console.log('Tx hash:', swapReceipt.transactionHash);

    // Check final balances
    const finalUsdc = await usdc.balanceOf(wallet.address);
    const finalEth = await provider.getBalance(wallet.address);
    console.log('\nFinal USDC:', ethers.utils.formatUnits(finalUsdc, 6));
    console.log('Final ETH:', ethers.utils.formatEther(finalEth));
  } catch (err) {
    console.error('Swap failed:', err.message);
    // Try 0.3% fee tier as fallback
    if (err.message.includes('STF') || err.message.includes('revert')) {
      console.log('\nRetrying with 0.3% fee tier...');
      swapParams.fee = 3000;
      swapParams.amountOutMinimum = ethers.utils.parseEther('0.070'); // slightly more slippage
      try {
        const swapTx2 = await router.exactInputSingle(swapParams, {
          gasPrice: gasPrice.mul(120).div(100),
          gasLimit: 300000,
        });
        console.log('Swap tx:', swapTx2.hash);
        const receipt2 = await swapTx2.wait();
        console.log('\n=== SWAP COMPLETE (0.3% pool) ===');
        console.log('Tx hash:', receipt2.transactionHash);
        const finalUsdc = await usdc.balanceOf(wallet.address);
        const finalEth = await provider.getBalance(wallet.address);
        console.log('Final USDC:', ethers.utils.formatUnits(finalUsdc, 6));
        console.log('Final ETH:', ethers.utils.formatEther(finalEth));
      } catch (err2) {
        console.error('Fallback swap also failed:', err2.message);
        process.exit(1);
      }
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
