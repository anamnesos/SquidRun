'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const paperTradingAutomation = require('../paper-trading-automation');

describe('paper-trading-automation', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-trading-automation-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('seeds per-agent trigger defaults and evaluates timer wakes', () => {
    const oracle = paperTradingAutomation.loadTriggerConfig(tempRoot, 'oracle', { writeDefaults: true });
    const architect = paperTradingAutomation.loadTriggerConfig(tempRoot, 'architect', { writeDefaults: true });
    const builder = paperTradingAutomation.loadTriggerConfig(tempRoot, 'builder', { writeDefaults: true });

    expect(oracle.normalized.timer.intervalMinutes).toBe(5);
    expect(architect.normalized.timer.intervalMinutes).toBe(10);
    expect(builder.normalized.timer.intervalMinutes).toBe(15);
    expect(fs.existsSync(oracle.paths.triggerConfigPath)).toBe(true);

    const firstWake = paperTradingAutomation.evaluateWakeCondition(oracle.normalized, { agentId: 'oracle' }, 1_000_000);
    expect(firstWake.shouldWake).toBe(true);
    expect(firstWake.wakeReason).toBe('timer_cycle');

    const nextWakeAtMs = paperTradingAutomation.computeNextTimerWakeMs(1_000_000, oracle.normalized.timer.intervalMinutes);
    const notDue = paperTradingAutomation.evaluateWakeCondition(
      oracle.normalized,
      {
        agentId: 'oracle',
        lastDispatchAtMs: 1_000_000,
        nextTimerWakeAtMs: nextWakeAtMs,
      },
      1_000_000 + (4 * 60 * 1000)
    );
    expect(notDue.shouldWake).toBe(false);
    expect(notDue.nextTimerWakeAtMs).toBe(nextWakeAtMs);
  });

  test('rejects malformed responses missing rationale or stop declarations', () => {
    const missingRationale = paperTradingAutomation.validatePaperTradingResponse({
      requestId: 'req-1',
      agentId: 'builder',
      action: { type: 'hold', ticker: 'BTC/USD' },
      rationale: '',
      stopDeclaration: { price: 74000 },
      noStopDeclaration: null,
    });
    expect(missingRationale.ok).toBe(false);
    expect(missingRationale.error).toMatch(/rationale/i);

    const missingStop = paperTradingAutomation.validatePaperTradingResponse({
      requestId: 'req-2',
      agentId: 'builder',
      action: { type: 'hold', ticker: 'BTC/USD' },
      rationale: 'Holding.',
      stopDeclaration: null,
      noStopDeclaration: null,
    });
    expect(missingStop.ok).toBe(false);
    expect(missingStop.error).toMatch(/exactly one/i);
  });

  test('applies open and close responses against the agent portfolio', () => {
    const openResult = paperTradingAutomation.applyPaperTradingResponse({
      agentId: 'builder',
      portfolio: {
        agentId: 'builder',
        startingBalance: 500,
        cashBalance: 500,
        equity: 500,
        realizedPnl: 0,
        unrealizedPnl: 0,
        totalPnl: 0,
        openPositions: [],
        closedTrades: [],
        hourlyMarks: [],
      },
      response: {
        action: {
          type: 'open',
          ticker: 'BTC/USD',
          side: 'LONG',
          marginUsd: 100,
          leverage: 5,
          takeProfit: 76000,
        },
        rationale: 'Opening a paper BTC long.',
        stopDeclaration: {
          type: 'stop_loss',
          price: 74200,
          note: 'Hard stop.',
        },
        noStopDeclaration: null,
        timeStop: {
          minutes: 30,
          note: 'Close if the move stays dead.',
        },
      },
      livePriceMap: { 'BTC/USD': 75000 },
      now: '2026-04-16T20:00:00.000Z',
      wakeReason: 'timer_cycle',
    });

    expect(openResult.portfolio.openPositions).toHaveLength(1);
    expect(openResult.portfolio.cashBalance).toBe(400);
    expect(openResult.portfolio.openPositions[0].timeStop).toEqual({
      minutes: 30,
      note: 'Close if the move stays dead.',
    });

    const closeResult = paperTradingAutomation.applyPaperTradingResponse({
      agentId: 'builder',
      portfolio: openResult.portfolio,
      response: {
        action: {
          type: 'close',
          ticker: 'BTC/USD',
          closePct: 1,
          units: 0,
        },
        rationale: 'Closing the paper BTC long.',
        stopDeclaration: {
          type: 'stop_loss',
          price: 74880,
          note: 'Trailing stop on the exit decision.',
        },
        noStopDeclaration: null,
        timeStop: null,
      },
      livePriceMap: { 'BTC/USD': 75250 },
      now: '2026-04-16T20:05:00.000Z',
      wakeReason: 'timer_cycle',
    });

    expect(closeResult.portfolio.openPositions).toHaveLength(0);
    expect(closeResult.portfolio.closedTrades).toHaveLength(1);
    expect(closeResult.portfolio.realizedPnl).toBeGreaterThan(0);
    expect(closeResult.portfolio.hourlyMarks.at(-1).notes[0]).toMatch(/Closing the paper BTC long/i);
  });

  test('leaves the portfolio unchanged when the audit pending write fails', () => {
    const originalPortfolio = {
      schemaVersion: 1,
      agentId: 'builder',
      startingBalance: 500,
      cashBalance: 500,
      equity: 500,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      openPositions: [],
      closedTrades: [],
      hourlyMarks: [],
    };
    paperTradingAutomation.writePortfolio(tempRoot, 'builder', originalPortfolio, {});
    const portfolioPath = paperTradingAutomation.getPortfolioPaths(tempRoot, 'builder').portfolioPath;
    const beforeRaw = fs.readFileSync(portfolioPath, 'utf8');
    const appendSpy = jest.spyOn(fs, 'appendFileSync').mockImplementation((targetPath) => {
      if (String(targetPath).endsWith('paper-trading-actions.jsonl')) {
        throw new Error('audit_append_failed');
      }
      return undefined;
    });

    expect(() => paperTradingAutomation.commitPortfolioMutation(tempRoot, {
      agentId: 'builder',
      portfolio: {
        ...originalPortfolio,
        cashBalance: 450,
        equity: 450,
        totalPnl: -50,
      },
      previousRaw: originalPortfolio,
      pendingAudit: { requestId: 'req-audit-fail' },
      committedAudit: { kind: 'paper_trading_response_applied', requestId: 'req-audit-fail' },
    })).toThrow(/audit_append_failed/i);

    expect(fs.readFileSync(portfolioPath, 'utf8')).toBe(beforeRaw);
    appendSpy.mockRestore();
  });

  test('does not commit the portfolio when the portfolio write step fails', () => {
    const originalPortfolio = {
      schemaVersion: 1,
      agentId: 'builder',
      startingBalance: 500,
      cashBalance: 500,
      equity: 500,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      openPositions: [],
      closedTrades: [],
      hourlyMarks: [],
    };
    paperTradingAutomation.writePortfolio(tempRoot, 'builder', originalPortfolio, {});
    const paths = paperTradingAutomation.getPortfolioPaths(tempRoot, 'builder');
    const beforeRaw = fs.readFileSync(paths.portfolioPath, 'utf8');
    const originalRenameSync = fs.renameSync;
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((sourcePath, targetPath) => {
      if (String(targetPath) === paths.portfolioPath) {
        throw new Error('rename_failed');
      }
      return originalRenameSync.call(fs, sourcePath, targetPath);
    });

    expect(() => paperTradingAutomation.commitPortfolioMutation(tempRoot, {
      agentId: 'builder',
      portfolio: {
        ...originalPortfolio,
        cashBalance: 450,
        equity: 450,
        totalPnl: -50,
      },
      previousRaw: originalPortfolio,
      pendingAudit: { requestId: 'req-portfolio-fail' },
      committedAudit: { kind: 'paper_trading_response_applied', requestId: 'req-portfolio-fail' },
    })).toThrow(/rename_failed/i);

    expect(fs.readFileSync(paths.portfolioPath, 'utf8')).toBe(beforeRaw);
    const auditEntries = fs.readFileSync(paths.auditLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(auditEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'paper_trading_mutation_pending',
        requestId: 'req-portfolio-fail',
      }),
      expect.objectContaining({
        kind: 'paper_trading_mutation_aborted',
        requestId: 'req-portfolio-fail',
      }),
    ]));
    const tempFiles = fs.readdirSync(path.dirname(paths.portfolioPath)).filter((name) => name.includes('.tmp'));
    expect(tempFiles).toHaveLength(0);
    renameSpy.mockRestore();
  });

  test('crash mid-operation leaves no partial portfolio state behind', () => {
    const originalPortfolio = {
      schemaVersion: 1,
      agentId: 'builder',
      startingBalance: 500,
      cashBalance: 500,
      equity: 500,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      openPositions: [],
      closedTrades: [],
      hourlyMarks: [],
    };
    paperTradingAutomation.writePortfolio(tempRoot, 'builder', originalPortfolio, {});
    const paths = paperTradingAutomation.getPortfolioPaths(tempRoot, 'builder');
    const beforeRaw = fs.readFileSync(paths.portfolioPath, 'utf8');

    expect(() => paperTradingAutomation.commitPortfolioMutation(tempRoot, {
      agentId: 'builder',
      portfolio: {
        ...originalPortfolio,
        cashBalance: 425,
        equity: 425,
        totalPnl: -75,
      },
      previousRaw: originalPortfolio,
      pendingAudit: { requestId: 'req-crash-midway' },
      committedAudit: { kind: 'paper_trading_response_applied', requestId: 'req-crash-midway' },
      beforePortfolioWrite: () => {
        throw new Error('simulated_crash');
      },
    })).toThrow(/simulated_crash/i);

    expect(fs.readFileSync(paths.portfolioPath, 'utf8')).toBe(beforeRaw);
    const auditEntries = fs.readFileSync(paths.auditLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(auditEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'paper_trading_mutation_pending',
        requestId: 'req-crash-midway',
      }),
      expect.objectContaining({
        kind: 'paper_trading_mutation_aborted',
        requestId: 'req-crash-midway',
        error: 'simulated_crash',
      }),
    ]));
  });
});
