/**
 * Tests for modules/contract-promotion.js
 * Covers shadow contract tracking, promotion criteria, and persistence.
 */

// Mock fs to avoid actual file I/O
jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

describe('contract-promotion', () => {
  let bus;
  let promotion;
  let fs;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    fs = require('fs');
    fs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    fs.writeFileSync.mockClear();
    fs.mkdirSync.mockClear();

    bus = require('../modules/event-bus');
    bus.reset();
    promotion = require('../modules/contract-promotion');
    promotion.reset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('module exports', () => {
    test('exports core functions', () => {
      expect(typeof promotion.init).toBe('function');
      expect(typeof promotion.saveStats).toBe('function');
      expect(typeof promotion.checkPromotions).toBe('function');
      expect(typeof promotion.addSignoff).toBe('function');
      expect(typeof promotion.incrementSession).toBe('function');
      expect(typeof promotion.recordFalsePositive).toBe('function');
      expect(typeof promotion.getStats).toBe('function');
      expect(typeof promotion.reset).toBe('function');
    });

    test('exports constants', () => {
      expect(promotion.MIN_SESSIONS).toBe(5);
      expect(promotion.REQUIRED_SIGNOFFS).toBe(2);
    });
  });

  describe('init', () => {
    test('initializes with empty stats when no file exists', () => {
      promotion.init(bus);
      const stats = promotion.getStats();
      expect(stats.contracts).toEqual({});
    });

    test('loads existing stats from file', () => {
      const existingStats = {
        contracts: {
          'test-contract': {
            mode: 'shadow',
            sessionsTracked: 3,
            shadowViolations: 5,
            falsePositives: 0,
            agentSignoffs: ['architect'],
            lastUpdated: '2026-02-09T00:00:00.000Z',
          },
        },
      };
      fs.readFileSync.mockReturnValue(JSON.stringify(existingStats));

      promotion.init(bus);
      const stats = promotion.getStats();
      expect(stats.contracts['test-contract'].sessionsTracked).toBe(3);
    });

    test('subscribes to shadow violation events', () => {
      promotion.init(bus);

      // Register a shadow contract on the bus
      bus.registerContract({
        id: 'test-shadow',
        version: 1,
        owner: 'test',
        appliesTo: ['test.event'],
        preconditions: [() => false], // always violates
        severity: 'warn',
        action: 'block',
        mode: 'shadow',
        emitOnViolation: 'contract.shadow.violation',
      });

      // Emit a test event that triggers shadow violation
      bus.emit('test.event', { paneId: '1', payload: {} });

      const stats = promotion.getStats();
      expect(stats.contracts['test-shadow']).toBeDefined();
      expect(stats.contracts['test-shadow'].shadowViolations).toBe(1);
    });
  });

  describe('session tracking', () => {
    beforeEach(() => {
      promotion.init(bus);
    });

    test('incrementSession increases count', () => {
      promotion.incrementSession('test-contract');
      promotion.incrementSession('test-contract');
      const entry = promotion.getContractStats('test-contract');
      expect(entry.sessionsTracked).toBe(2);
    });

    test('getContractStats creates entry if missing', () => {
      const entry = promotion.getContractStats('new-contract');
      expect(entry.mode).toBe('shadow');
      expect(entry.sessionsTracked).toBe(0);
      expect(entry.falsePositives).toBe(0);
    });
  });

  describe('false positive recording', () => {
    beforeEach(() => {
      promotion.init(bus);
    });

    test('recordFalsePositive increments count', () => {
      promotion.recordFalsePositive('test-contract');
      const entry = promotion.getContractStats('test-contract');
      expect(entry.falsePositives).toBe(1);
    });

    test('false positives block promotion', () => {
      // Set up a contract that otherwise meets all criteria
      for (let i = 0; i < 5; i++) {
        promotion.incrementSession('test-contract');
      }
      promotion.addSignoff('test-contract', 'architect');
      promotion.addSignoff('test-contract', 'analyst');
      promotion.recordFalsePositive('test-contract');

      expect(promotion.isReadyForPromotion('test-contract')).toBe(false);
    });
  });

  describe('agent signoffs', () => {
    beforeEach(() => {
      promotion.init(bus);
    });

    test('addSignoff adds agent name', () => {
      promotion.addSignoff('test-contract', 'architect');
      const entry = promotion.getContractStats('test-contract');
      expect(entry.agentSignoffs).toContain('architect');
    });

    test('duplicate signoff is ignored', () => {
      promotion.addSignoff('test-contract', 'architect');
      promotion.addSignoff('test-contract', 'architect');
      const entry = promotion.getContractStats('test-contract');
      expect(entry.agentSignoffs.length).toBe(1);
    });

    test('requires 2 signoffs for promotion', () => {
      for (let i = 0; i < 5; i++) {
        promotion.incrementSession('test-contract');
      }
      promotion.addSignoff('test-contract', 'architect');
      expect(promotion.isReadyForPromotion('test-contract')).toBe(false);

      promotion.addSignoff('test-contract', 'analyst');
      expect(promotion.isReadyForPromotion('test-contract')).toBe(true);
    });
  });

  describe('promotion criteria', () => {
    beforeEach(() => {
      promotion.init(bus);
    });

    test('isReadyForPromotion returns false for non-existent contract', () => {
      expect(promotion.isReadyForPromotion('nonexistent')).toBe(false);
    });

    test('isReadyForPromotion returns false when sessions < 5', () => {
      for (let i = 0; i < 4; i++) {
        promotion.incrementSession('test-contract');
      }
      promotion.addSignoff('test-contract', 'architect');
      promotion.addSignoff('test-contract', 'analyst');
      expect(promotion.isReadyForPromotion('test-contract')).toBe(false);
    });

    test('isReadyForPromotion returns false when not enough signoffs', () => {
      for (let i = 0; i < 5; i++) {
        promotion.incrementSession('test-contract');
      }
      promotion.addSignoff('test-contract', 'architect');
      expect(promotion.isReadyForPromotion('test-contract')).toBe(false);
    });

    test('isReadyForPromotion returns true when all criteria met', () => {
      for (let i = 0; i < 5; i++) {
        promotion.incrementSession('test-contract');
      }
      promotion.addSignoff('test-contract', 'architect');
      promotion.addSignoff('test-contract', 'analyst');
      expect(promotion.isReadyForPromotion('test-contract')).toBe(true);
    });

    test('isReadyForPromotion returns false for already enforced contract', () => {
      for (let i = 0; i < 5; i++) {
        promotion.incrementSession('test-contract');
      }
      promotion.addSignoff('test-contract', 'architect');
      promotion.addSignoff('test-contract', 'analyst');

      // Promote it
      promotion.checkPromotions();

      // Now it's enforced — should not be ready for promotion again
      expect(promotion.isReadyForPromotion('test-contract')).toBe(false);
    });
  });

  describe('checkPromotions', () => {
    beforeEach(() => {
      promotion.init(bus);
    });

    test('returns empty array when no contracts are ready', () => {
      const result = promotion.checkPromotions();
      expect(result).toEqual([]);
    });

    test('promotes eligible contracts and returns their IDs', () => {
      for (let i = 0; i < 5; i++) {
        promotion.incrementSession('contract-a');
      }
      promotion.addSignoff('contract-a', 'architect');
      promotion.addSignoff('contract-a', 'analyst');

      const result = promotion.checkPromotions();
      expect(result).toEqual(['contract-a']);
    });

    test('changes contract mode to enforced after promotion', () => {
      for (let i = 0; i < 5; i++) {
        promotion.incrementSession('contract-a');
      }
      promotion.addSignoff('contract-a', 'architect');
      promotion.addSignoff('contract-a', 'analyst');

      promotion.checkPromotions();
      const entry = promotion.getContractStats('contract-a');
      expect(entry.mode).toBe('enforced');
    });

    test('emits contract.promoted event', () => {
      const handler = jest.fn();
      bus.on('contract.promoted', handler);

      for (let i = 0; i < 5; i++) {
        promotion.incrementSession('contract-a');
      }
      promotion.addSignoff('contract-a', 'architect');
      promotion.addSignoff('contract-a', 'analyst');

      promotion.checkPromotions();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload.contractId).toBe('contract-a');
    });

    test('does not promote contracts with false positives', () => {
      for (let i = 0; i < 5; i++) {
        promotion.incrementSession('contract-a');
      }
      promotion.addSignoff('contract-a', 'architect');
      promotion.addSignoff('contract-a', 'analyst');
      promotion.recordFalsePositive('contract-a');

      const result = promotion.checkPromotions();
      expect(result).toEqual([]);
    });

    test('handles multiple contracts independently', () => {
      // Contract A — ready
      for (let i = 0; i < 5; i++) {
        promotion.incrementSession('contract-a');
      }
      promotion.addSignoff('contract-a', 'architect');
      promotion.addSignoff('contract-a', 'analyst');

      // Contract B — not ready (only 3 sessions)
      for (let i = 0; i < 3; i++) {
        promotion.incrementSession('contract-b');
      }
      promotion.addSignoff('contract-b', 'architect');
      promotion.addSignoff('contract-b', 'analyst');

      const result = promotion.checkPromotions();
      expect(result).toEqual(['contract-a']);
    });
  });

  describe('saveStats', () => {
    test('writes stats to disk', () => {
      promotion.init(bus);
      promotion.incrementSession('test-contract');
      promotion.saveStats();

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const writtenContent = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(writtenContent.contracts['test-contract'].sessionsTracked).toBe(1);
    });

    test('creates directory if needed', () => {
      promotion.init(bus);
      promotion.saveStats();
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true }
      );
    });

    test('does not throw if write fails', () => {
      promotion.init(bus);
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('disk full');
      });
      expect(() => promotion.saveStats()).not.toThrow();
    });
  });

  describe('reset', () => {
    test('clears all state', () => {
      promotion.init(bus);
      promotion.incrementSession('test-contract');
      promotion.reset();

      const stats = promotion.getStats();
      expect(stats.contracts).toEqual({});
    });
  });

  describe('shadow violation tracking via events', () => {
    beforeEach(() => {
      promotion.init(bus);
    });

    test('tracks violations from contract.shadow.violation events', () => {
      // Manually emit shadow violation event (normally emitted by bus checkContracts)
      bus.emit('contract.shadow.violation', {
        paneId: '1',
        payload: { contractId: 'my-shadow-contract', eventType: 'test.event', severity: 'warn' },
        source: 'event-bus.js',
      });

      const entry = promotion.getContractStats('my-shadow-contract');
      expect(entry.shadowViolations).toBe(1);
    });

    test('tracks multiple violations', () => {
      for (let i = 0; i < 3; i++) {
        bus.emit('contract.shadow.violation', {
          paneId: '1',
          payload: { contractId: 'my-shadow-contract', eventType: 'test.event', severity: 'warn' },
          source: 'event-bus.js',
        });
      }

      const entry = promotion.getContractStats('my-shadow-contract');
      expect(entry.shadowViolations).toBe(3);
    });

    test('ignores events without contractId in payload', () => {
      bus.emit('contract.shadow.violation', {
        paneId: '1',
        payload: {},
        source: 'event-bus.js',
      });

      const stats = promotion.getStats();
      // No entry should be created with undefined key
      expect(stats.contracts['undefined']).toBeUndefined();
    });
  });
});
