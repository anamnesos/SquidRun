'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const launchRadar = require('../launch-radar');

describe('launch-radar', () => {
  let tempDir;
  let statePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-launch-radar-'));
    statePath = path.join(tempDir, 'launch-radar-state.json');
  });

  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('filters new launches by liquidity, holders, age, and social presence', async () => {
    const launches = await launchRadar.scanNewLaunches({
      chain: 'solana',
      nowMs: Date.parse('2026-03-19T21:00:00.000Z'),
      provider: launchRadar.createStaticLaunchProvider({
        solana: [
          {
            address: 'So11111111111111111111111111111111111111112',
            symbol: 'SQUID',
            liquidityUsd: 12_000,
            holders: 44,
            createdAt: '2026-03-19T20:20:00.000Z',
            twitter: 'squidrun',
            source: 'pump.fun',
          },
          {
            address: 'So22222222222222222222222222222222222222222',
            symbol: 'THIN',
            liquidityUsd: 4_000,
            holders: 90,
            createdAt: '2026-03-19T20:25:00.000Z',
            twitter: 'thincoin',
            source: 'raydium',
          },
          {
            address: 'So33333333333333333333333333333333333333333',
            symbol: 'OLD',
            liquidityUsd: 10_000,
            holders: 90,
            createdAt: '2026-03-19T18:00:00.000Z',
            website: 'https://old.example',
            source: 'raydium',
          },
          {
            address: 'So44444444444444444444444444444444444444444',
            symbol: 'QUIET',
            liquidityUsd: 10_000,
            holders: 90,
            createdAt: '2026-03-19T20:30:00.000Z',
            source: 'pump.fun',
          },
        ],
      }),
    });

    expect(launches).toEqual([
      expect.objectContaining({
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
        symbol: 'SQUID',
        liquidityUsd: 12000,
        holders: 44,
        socialPresence: 1,
      }),
    ]);
  });

  test('scores token virality and rug risk from launch attributes', () => {
    const evaluation = launchRadar.evaluateToken({
      liquidityUsd: 18_000,
      holders: 120,
      socialPresence: 3,
      socialVelocity: 0.72,
      holderConcentration: 0.18,
      volume24hUsd: 42_000,
    });

    expect(evaluation).toEqual(expect.objectContaining({
      viralScore: expect.any(Number),
      rugRisk: expect.any(Number),
      liquidityDepth: expect.any(Number),
      holderConcentration: 0.18,
      socialVelocity: 0.72,
    }));
    expect(evaluation.viralScore).toBeGreaterThan(0.5);
    expect(evaluation.rugRisk).toBeLessThan(0.5);
  });

  test('emits launch, qualified, and rejected events during a poll', async () => {
    const tokenRiskAudit = {
      auditToken: jest.fn(async (address) => {
        if (address === 'SoAvoid1111111111111111111111111111111111111') {
          return {
            safe: false,
            recommendation: 'avoid',
            risks: ['honeypot_detected'],
            details: { provider: 'mock-audit' },
          };
        }
        return {
          safe: true,
          recommendation: 'proceed',
          risks: [],
          details: { provider: 'mock-audit' },
        };
      }),
      createGoPlusProvider: jest.fn(),
    };
    const radar = launchRadar.createLaunchRadar({
      statePath,
      persist: true,
      chains: ['solana'],
      now: () => Date.parse('2026-03-19T21:00:00.000Z'),
      provider: launchRadar.createStaticLaunchProvider({
        solana: [
          {
            address: 'SoGood11111111111111111111111111111111111111',
            symbol: 'GOOD',
            liquidityUsd: 15_000,
            holders: 55,
            createdAt: '2026-03-19T20:30:00.000Z',
            twitter: 'goodcoin',
            source: 'pump.fun',
          },
          {
            address: 'SoAvoid1111111111111111111111111111111111111',
            symbol: 'AVOID',
            liquidityUsd: 20_000,
            holders: 75,
            createdAt: '2026-03-19T20:40:00.000Z',
            website: 'https://avoid.example',
            source: 'raydium',
          },
          {
            address: 'SoQuiet111111111111111111111111111111111111',
            symbol: 'QUIET',
            liquidityUsd: 20_000,
            holders: 75,
            createdAt: '2026-03-19T20:41:00.000Z',
            source: 'pump.fun',
          },
        ],
      }),
      tokenRiskAudit,
      auditProvider: jest.fn(),
    });

    const launches = [];
    const qualified = [];
    const rejected = [];
    radar.on('launch', (payload) => launches.push(payload));
    radar.on('qualified', (payload) => qualified.push(payload));
    radar.on('rejected', (payload) => rejected.push(payload));

    const result = await radar.pollNow({ reason: 'test' });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      launches: [
        expect.objectContaining({ symbol: 'AVOID' }),
        expect.objectContaining({ symbol: 'GOOD' }),
      ],
      qualified: [
        expect.objectContaining({
          symbol: 'GOOD',
          audit: expect.objectContaining({ recommendation: 'proceed' }),
        }),
      ],
    }));
    expect(launches).toHaveLength(2);
    expect(qualified).toHaveLength(1);
    expect(qualified[0]).toEqual(expect.objectContaining({
      symbol: 'GOOD',
      evaluation: expect.objectContaining({
        viralScore: expect.any(Number),
      }),
    }));
    expect(rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'audit',
        reasons: ['honeypot_detected'],
      }),
      expect.objectContaining({
        stage: 'filters',
        reasons: ['no_social_presence'],
      }),
    ]));
    expect(tokenRiskAudit.auditToken).toHaveBeenCalledTimes(2);
    expect(launchRadar.readLaunchRadarState(statePath).seenLaunchIds).toHaveLength(3);
  });

  test('starts and stops the polling loop', async () => {
    jest.useFakeTimers();
    const radar = launchRadar.createLaunchRadar({
      statePath,
      persist: false,
      chains: ['solana'],
      pollMs: 15_000,
      provider: launchRadar.createStaticLaunchProvider({ solana: [] }),
      tokenRiskAudit: {
        auditToken: jest.fn(),
        createGoPlusProvider: jest.fn(),
      },
      auditProvider: jest.fn(),
    });
    const pollSpy = jest.spyOn(radar, 'pollNow').mockResolvedValue({
      ok: true,
      launches: [],
      qualified: [],
      rejected: [],
    });

    radar.start({ immediate: false });
    await jest.advanceTimersByTimeAsync(15_000);

    expect(pollSpy).toHaveBeenCalledTimes(1);

    radar.stop();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(pollSpy).toHaveBeenCalledTimes(1);
  });
});
