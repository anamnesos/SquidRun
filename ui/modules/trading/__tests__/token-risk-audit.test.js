'use strict';

const tokenRiskAudit = require('../token-risk-audit');

describe('token-risk-audit', () => {
  test('returns avoid when honeypot, holder concentration, and unlocked liquidity are detected', async () => {
    const provider = tokenRiskAudit.createStaticTokenRiskProvider({
      'solana:So11111111111111111111111111111111111111112': {
        honeypot: true,
        liquidityLocked: false,
        topHolders: [
          { address: 'wallet-1', percent: 20 },
          { address: 'wallet-2', percent: 15 },
          { address: 'wallet-3', percent: 12 },
          { address: 'wallet-4', percent: 9 },
          { address: 'wallet-5', percent: 6 },
        ],
        provider: 'mock-risk',
      },
    });

    const result = await tokenRiskAudit.auditToken(
      'So11111111111111111111111111111111111111112',
      'solana',
      { provider }
    );

    expect(result.safe).toBe(false);
    expect(result.recommendation).toBe('avoid');
    expect(result.risks).toEqual(expect.arrayContaining([
      'honeypot_detected',
      'top_5_wallets_control_more_than_50pct',
      'liquidity_not_locked',
    ]));
    expect(result.details).toEqual(expect.objectContaining({
      chain: 'solana',
      honeypot: true,
      liquidityLocked: false,
    }));
    expect(result.details.top5HolderRatio).toBeCloseTo(0.62, 5);
  });

  test('returns caution for proxy contracts with mint authority still active', async () => {
    const result = await tokenRiskAudit.auditToken('0xabc123', 'base', {
      provider: tokenRiskAudit.createStaticTokenRiskProvider({
        'base:0xabc123': {
          isProxy: true,
          mintAuthorityRenounced: false,
          liquidityLocked: true,
          top5HolderRatio: 0.24,
          provider: 'mock-risk',
        },
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      safe: true,
      recommendation: 'caution',
      risks: expect.arrayContaining([
        'proxy_contract',
        'mint_authority_not_renounced',
      ]),
    }));
    expect(result.details.address).toBe('0xabc123');
  });

  test('returns proceed for a clean token profile', async () => {
    const result = await tokenRiskAudit.auditToken('0xdef456', 'base', {
      provider: tokenRiskAudit.createStaticTokenRiskProvider({
        'base:0xdef456': {
          isProxy: false,
          honeypot: false,
          liquidityLocked: true,
          mintAuthorityRenounced: true,
          topHolders: [
            { address: 'wallet-1', percent: 8 },
            { address: 'wallet-2', percent: 7 },
            { address: 'wallet-3', percent: 6 },
            { address: 'wallet-4', percent: 5 },
            { address: 'wallet-5', percent: 4 },
          ],
          provider: 'mock-risk',
        },
      }),
    });

    expect(result).toEqual({
      safe: true,
      risks: [],
      recommendation: 'proceed',
      details: expect.objectContaining({
        address: '0xdef456',
        chain: 'base',
        liquidityLocked: true,
        isProxy: false,
        mintAuthorityRenounced: true,
        top5HolderRatio: 0.3,
      }),
    });
  });

  test('parses GoPlus-style responses through the provider helper', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          '0xfeed': {
            is_honeypot: '0',
            is_proxy: '1',
            is_locked: '1',
            top_5_holder_rate: '0.42',
            owner_renounced: '1',
          },
        },
      }),
    });
    const provider = tokenRiskAudit.createGoPlusProvider();

    const result = await tokenRiskAudit.auditToken('0xfeed', 'base', {
      provider,
      fetch,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({
      safe: true,
      recommendation: 'caution',
      risks: ['proxy_contract'],
      details: expect.objectContaining({
        provider: 'goplus',
        top5HolderRatio: 0.42,
      }),
    }));
  });
});
