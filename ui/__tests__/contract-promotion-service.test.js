const contractId = 'overlay-fit-exclusion-shadow';

const mockStatsState = {
  contracts: {
    [contractId]: {
      mode: 'shadow',
      sessionsTracked: 5,
      shadowViolations: 0,
      falsePositives: 0,
      agentSignoffs: ['architect'],
      lastUpdated: '2026-02-12T00:00:00.000Z',
    },
  },
};

const mockContractPromotion = {
  MIN_SESSIONS: 5,
  REQUIRED_SIGNOFFS: 2,
  syncStatsFromDisk: jest.fn(),
  getStats: jest.fn(() => JSON.parse(JSON.stringify(mockStatsState))),
  isReadyForPromotion: jest.fn((id) => {
    const entry = mockStatsState.contracts[id];
    if (!entry || entry.mode !== 'shadow') return false;
    return entry.sessionsTracked >= 5 && entry.falsePositives === 0 && entry.agentSignoffs.length >= 2;
  }),
  getContractStats: jest.fn((id) => {
    if (!mockStatsState.contracts[id]) {
      mockStatsState.contracts[id] = {
        mode: 'shadow',
        sessionsTracked: 0,
        shadowViolations: 0,
        falsePositives: 0,
        agentSignoffs: [],
        lastUpdated: '2026-02-12T00:00:00.000Z',
      };
    }
    return mockStatsState.contracts[id];
  }),
  addSignoff: jest.fn((id, agent) => {
    const entry = mockStatsState.contracts[id];
    if (!entry.agentSignoffs.includes(agent)) {
      entry.agentSignoffs.push(agent);
    }
  }),
  recordFalsePositive: jest.fn((id) => {
    const entry = mockStatsState.contracts[id];
    entry.falsePositives += 1;
  }),
  checkPromotions: jest.fn(() => {
    const entry = mockStatsState.contracts[contractId];
    if (entry.agentSignoffs.length >= 2 && entry.falsePositives === 0 && entry.mode === 'shadow') {
      entry.mode = 'enforced';
      return [contractId];
    }
    return [];
  }),
  saveStats: jest.fn(),
};

const mockContracts = {
  SHADOW_CONTRACTS: [{ id: contractId, mode: 'shadow' }],
  getContractById: jest.fn((id) => (id === contractId ? { id, mode: 'shadow' } : null)),
};

jest.mock('../modules/contract-promotion', () => mockContractPromotion);
jest.mock('../modules/contracts', () => mockContracts);

const service = require('../modules/contract-promotion-service');

describe('contract-promotion-service', () => {
  beforeEach(() => {
    mockStatsState.contracts[contractId] = {
      mode: 'shadow',
      sessionsTracked: 5,
      shadowViolations: 0,
      falsePositives: 0,
      agentSignoffs: ['architect'],
      lastUpdated: '2026-02-12T00:00:00.000Z',
    };

    jest.clearAllMocks();
  });

  test('list action returns promotion rows and summary', () => {
    const result = service.executeContractPromotionAction('list');

    expect(result.ok).toBe(true);
    expect(result.action).toBe('list');
    expect(Array.isArray(result.promotions)).toBe(true);
    expect(result.promotions[0]).toEqual(expect.objectContaining({
      contractId,
      mode: 'shadow',
      sessionsTracked: 5,
    }));
    expect(result.summary).toEqual(expect.objectContaining({
      total: 1,
      shadow: 1,
      enforced: 0,
    }));
    expect(mockContractPromotion.syncStatsFromDisk).toHaveBeenCalled();
  });

  test('approve action adds signoff, checks promotions, and persists', () => {
    const result = service.executeContractPromotionAction(
      'approve',
      { contractId, agent: 'devops' },
      { source: { role: 'devops' } }
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe('approved');
    expect(result.promoted).toBe(true);
    expect(mockContractPromotion.addSignoff).toHaveBeenCalledWith(contractId, 'devops');
    expect(mockContractPromotion.checkPromotions).toHaveBeenCalledTimes(1);
    expect(mockContractPromotion.saveStats).toHaveBeenCalledTimes(1);
  });

  test('reject action records false positive and persists', () => {
    const result = service.executeContractPromotionAction(
      'reject',
      { contractId, reason: 'false positive observed' },
      { source: { role: 'analyst' } }
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe('rejected');
    expect(result.falsePositiveRecorded).toBe(true);
    expect(mockContractPromotion.recordFalsePositive).toHaveBeenCalledWith(contractId);
    expect(mockContractPromotion.saveStats).toHaveBeenCalledTimes(1);
  });

  test('returns invalid_action for unsupported commands', () => {
    const result = service.executeContractPromotionAction('unknown-action');
    expect(result.ok).toBe(false);
    expect(result.status).toBe('invalid_action');
  });
});
