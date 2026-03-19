'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const yieldRouter = require('../yield-router');

describe('yield-router', () => {
  let tempDir;
  let statePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-yield-router-'));
    statePath = path.join(tempDir, 'yield-router-state.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('filters available venues to audited high-TVL options and sorts by APY', async () => {
    const router = yieldRouter.createYieldRouter({
      persist: false,
      statePath,
      providers: [
        yieldRouter.createStaticYieldProvider({
          id: 'mixed-provider',
          venues: [
            {
              protocol: 'Tiny',
              chain: 'base',
              apy: 0.14,
              tvl: 500_000,
              riskScore: 0.2,
              minDeposit: 50,
              audited: true,
            },
            {
              protocol: 'Shady',
              chain: 'ethereum',
              apy: 0.2,
              tvl: 50_000_000,
              riskScore: 0.9,
              minDeposit: 50,
              audited: false,
            },
            {
              protocol: 'Aave',
              chain: 'base',
              apy: 0.051,
              tvl: 48_000_000,
              riskScore: 0.12,
              minDeposit: 50,
              audited: true,
            },
            {
              protocol: 'Morpho',
              chain: 'base',
              apy: 0.064,
              tvl: 88_000_000,
              riskScore: 0.15,
              minDeposit: 50,
              audited: true,
            },
          ],
        }),
      ],
    });

    const venues = await router.getAvailableVenues();

    expect(venues).toEqual([
      expect.objectContaining({ protocol: 'Morpho', chain: 'base', apy: 0.064 }),
      expect.objectContaining({ protocol: 'Aave', chain: 'base', apy: 0.051 }),
    ]);
  });

  test('blocks deposits when round-trip cost exceeds expected yield', async () => {
    const venue = {
      protocol: 'Aave',
      chain: 'base',
      apy: 0.03,
      tvl: 52_000_000,
      riskScore: 0.12,
      minDeposit: 50,
      audited: true,
      gasEstimateUsd: 4,
      slippageEstimateUsd: 2,
      providerId: 'aave',
    };
    const router = yieldRouter.createYieldRouter({
      persist: false,
      statePath,
      expectedHoldDays: 30,
      providers: [
        yieldRouter.createStaticYieldProvider({
          id: 'aave',
          venues: [venue],
        }),
      ],
    });

    const result = await router.deposit(venue, 100);

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      deposited: 0,
      reason: 'round_trip_cost_exceeds_expected_yield',
      roundTripCost: 6,
    }));
    expect(router.getDeposits()).toEqual([]);
  });

  test('returns idle capital to the highest-yield venues while respecting diversification caps', async () => {
    const depositCalls = [];
    const router = yieldRouter.createYieldRouter({
      statePath,
      now: () => Date.parse('2026-03-19T22:30:00.000Z'),
      providers: [
        yieldRouter.createStaticYieldProvider({
          id: 'aave',
          venues: [{
            protocol: 'Aave',
            chain: 'base',
            apy: 0.09,
            tvl: 40_000_000,
            riskScore: 0.1,
            minDeposit: 50,
            audited: true,
            gasEstimateUsd: 0.1,
            slippageEstimateUsd: 0.05,
          }],
          onDeposit: async (venue, amount) => {
            depositCalls.push({ protocol: venue.protocol, amount });
            return { ok: true, deposited: amount, txHash: `aave-${amount}` };
          },
        }),
        yieldRouter.createStaticYieldProvider({
          id: 'morpho',
          venues: [{
            protocol: 'Morpho',
            chain: 'base',
            apy: 0.12,
            tvl: 90_000_000,
            riskScore: 0.11,
            minDeposit: 50,
            audited: true,
            gasEstimateUsd: 0.1,
            slippageEstimateUsd: 0.05,
          }],
          onDeposit: async (venue, amount) => {
            depositCalls.push({ protocol: venue.protocol, amount });
            return { ok: true, deposited: amount, txHash: `morpho-${amount}` };
          },
        }),
      ],
    });

    const result = await router.returnCapital(400, {
      portfolioSnapshot: {
        totalEquity: 2000,
        totalCash: 1000,
        markets: {
          cash_reserve: { cash: 1000 },
          defi_yield: { lockedCapital: 0 },
        },
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      deposited: 400,
      venue: 'multiple',
      allocations: [
        expect.objectContaining({
          amount: 350,
          venue: expect.objectContaining({ protocol: 'Morpho' }),
        }),
        expect.objectContaining({
          amount: 50,
          venue: expect.objectContaining({ protocol: 'Aave' }),
        }),
      ],
      remaining: 0,
    }));
    expect(depositCalls).toEqual([
      { protocol: 'Morpho', amount: 350 },
      { protocol: 'Aave', amount: 50 },
    ]);
    expect(router.getDeposits()).toEqual([
      expect.objectContaining({
        protocol: 'Morpho',
        currentValue: 350,
      }),
      expect.objectContaining({
        protocol: 'Aave',
        currentValue: 50,
      }),
    ]);
    expect(yieldRouter.readYieldRouterState(statePath).deposits).toHaveLength(2);
  });

  test('requests capital by withdrawing from the lowest-yield unlocked venues first', async () => {
    const withdrawCalls = [];
    const aaveVenueKey = yieldRouter.buildVenueKey({
      providerId: 'aave',
      protocol: 'Aave',
      chain: 'base',
    });
    const morphoVenueKey = yieldRouter.buildVenueKey({
      providerId: 'morpho',
      protocol: 'Morpho',
      chain: 'base',
    });
    const router = yieldRouter.createYieldRouter({
      statePath,
      state: {
        deposits: [
          {
            venueKey: aaveVenueKey,
            providerId: 'aave',
            protocol: 'Aave',
            chain: 'base',
            amount: 150,
            currentValue: 150,
            apy: 0.04,
            depositedAt: '2026-03-18T18:00:00.000Z',
            locked: false,
          },
          {
            venueKey: morphoVenueKey,
            providerId: 'morpho',
            protocol: 'Morpho',
            chain: 'base',
            amount: 200,
            currentValue: 200,
            apy: 0.07,
            depositedAt: '2026-03-19T18:00:00.000Z',
            locked: false,
          },
        ],
      },
      providers: [
        yieldRouter.createStaticYieldProvider({
          id: 'aave',
          venues: [{ protocol: 'Aave', chain: 'base', apy: 0.04, tvl: 40_000_000, riskScore: 0.1, minDeposit: 50, audited: true }],
          onWithdraw: async (venue, amount) => {
            withdrawCalls.push({ protocol: venue.protocol, amount });
            return { ok: true, withdrawn: amount, txHash: `aave-${amount}` };
          },
        }),
        yieldRouter.createStaticYieldProvider({
          id: 'morpho',
          venues: [{ protocol: 'Morpho', chain: 'base', apy: 0.07, tvl: 80_000_000, riskScore: 0.1, minDeposit: 50, audited: true }],
          onWithdraw: async (venue, amount) => {
            withdrawCalls.push({ protocol: venue.protocol, amount });
            return { ok: true, withdrawn: amount, txHash: `morpho-${amount}` };
          },
        }),
      ],
    });

    const result = await router.requestCapital(220);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      withdrawn: 220,
      sources: [
        expect.objectContaining({ amount: 150, venue: expect.objectContaining({ protocol: 'Aave' }) }),
        expect.objectContaining({ amount: 70, venue: expect.objectContaining({ protocol: 'Morpho' }) }),
      ],
      remaining: 0,
    }));
    expect(withdrawCalls).toEqual([
      { protocol: 'Aave', amount: 150 },
      { protocol: 'Morpho', amount: 70 },
    ]);
    expect(router.getDeposits()).toEqual([
      expect.objectContaining({
        protocol: 'Morpho',
        currentValue: 130,
      }),
    ]);
  });

  test('withdraws all deposits when the kill switch is triggered', async () => {
    const aaveVenueKey = yieldRouter.buildVenueKey({
      providerId: 'aave',
      protocol: 'Aave',
      chain: 'base',
    });
    const morphoVenueKey = yieldRouter.buildVenueKey({
      providerId: 'morpho',
      protocol: 'Morpho',
      chain: 'base',
    });
    const router = yieldRouter.createYieldRouter({
      statePath,
      state: {
        deposits: [
          {
            venueKey: aaveVenueKey,
            providerId: 'aave',
            protocol: 'Aave',
            chain: 'base',
            amount: 100,
            currentValue: 100,
            apy: 0.05,
            depositedAt: '2026-03-19T10:00:00.000Z',
            lockupEndsAt: '2026-03-22T10:00:00.000Z',
            locked: true,
          },
          {
            venueKey: morphoVenueKey,
            providerId: 'morpho',
            protocol: 'Morpho',
            chain: 'base',
            amount: 80,
            currentValue: 80,
            apy: 0.07,
            depositedAt: '2026-03-19T11:00:00.000Z',
            locked: false,
          },
        ],
      },
      providers: [
        yieldRouter.createStaticYieldProvider({
          id: 'aave',
          venues: [{ protocol: 'Aave', chain: 'base', apy: 0.05, tvl: 40_000_000, riskScore: 0.1, minDeposit: 50, audited: true }],
          onWithdraw: async (venue, amount) => ({ ok: true, withdrawn: amount, txHash: `aave-${amount}` }),
        }),
        yieldRouter.createStaticYieldProvider({
          id: 'morpho',
          venues: [{ protocol: 'Morpho', chain: 'base', apy: 0.07, tvl: 80_000_000, riskScore: 0.1, minDeposit: 50, audited: true }],
          onWithdraw: async (venue, amount) => ({ ok: true, withdrawn: amount, txHash: `morpho-${amount}` }),
        }),
      ],
    });

    const result = await router.requestCapital(25, { killSwitchTriggered: true });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      withdrawn: 180,
      killSwitchTriggered: true,
      remaining: 0,
    }));
    expect(router.getDeposits()).toEqual([]);
  });

  test('computes idle capital after reserve and launch radar allocations', () => {
    const router = yieldRouter.createYieldRouter({
      persist: false,
      statePath,
    });

    const idleCapital = router.getIdleCapital({
      portfolioSnapshot: {
        totalEquity: 1000,
        totalCash: 400,
        markets: {
          cash_reserve: { cash: 400 },
          defi_yield: { lockedCapital: 50 },
        },
      },
      activeTradeCapital: 25,
    });

    expect(idleCapital).toBe(75);
  });
});
