const fs = require('fs');

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

jest.mock('../config', () => ({
  resolveCoordPath: jest.fn((relPath) => `/coord-root/${String(relPath || '').replace(/\\/g, '/')}`),
}));

jest.mock('../modules/logger', () => ({
  warn: jest.fn(),
}));

const orchestrator = require('../modules/problem-orchestrator');

describe('problem-orchestrator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.existsSync.mockReturnValue(false);
  });

  test('creates an empty state when no file exists', () => {
    const state = orchestrator.readActiveCasesState();
    expect(state.schemaVersion).toBe(orchestrator.ACTIVE_CASES_SCHEMA_VERSION);
    expect(state.cases).toEqual([]);
  });

  test('writes active cases atomically', () => {
    const result = orchestrator.writeActiveCasesState({
      schemaVersion: orchestrator.ACTIVE_CASES_SCHEMA_VERSION,
      cases: [{ caseId: 'case-1', title: 'Need help', status: 'intake' }],
    });

    expect(fs.mkdirSync).toHaveBeenCalledWith('/coord-root/runtime', { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(fs.renameSync).toHaveBeenCalledWith('/coord-root/runtime/active-cases.json.tmp', '/coord-root/runtime/active-cases.json');
    expect(result.ok).toBe(true);
  });

  test('upserts detected problem intake into active cases', () => {
    fs.existsSync.mockReturnValue(false);

    const result = orchestrator.upsertProblemCase({
      parsed: {
        raw: 'My landlord charged me $2,000 and I need help with a contract dispute.',
        problemIntake: {
          detected: true,
          domain: 'legal',
          domains: ['legal'],
          confidence: 0.82,
          triggers: ['institution:landlord', 'money-amount'],
          institutions: ['landlord'],
          moneyAmounts: ['$2,000'],
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(result.case.domain).toBe('legal');
    expect(result.case.status).toBe('capability_plan');
    expect(result.case.userFacing.shortNotice).toContain('Here is what we can do');
  });

  test('builds a startup resume summary from active cases', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify({
      schemaVersion: 2,
      updatedAt: '2026-03-26T10:00:00.000Z',
      cases: [
        {
          caseId: 'case-1',
          title: 'Landlord dispute over deposit',
          domain: 'legal',
          status: 'architect_pass',
          updatedAt: '2026-03-26T10:00:00.000Z',
        },
      ],
    }));

    const summary = orchestrator.buildStartupResumeSummary({}, { limit: 3 });

    expect(summary.count).toBe(1);
    expect(summary.items[0]).toContain('LEGAL architect_pass');
  });

  test('surfaces oracle timeout warnings in user-facing output', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify({
      schemaVersion: 2,
      updatedAt: '2026-03-26T10:00:00.000Z',
      cases: [
        {
          caseId: 'case-1',
          title: 'Landlord dispute over deposit',
          domain: 'legal',
          status: 'capability_plan',
          updatedAt: '2026-03-26T10:00:00.000Z',
          capabilityPlan: {
            domain: 'legal',
            domainLabel: 'Legal',
            intro: 'Here is what we can do for you right now.',
            actions: [
              { id: 'legal_issue_map', label: 'Map the legal issue', summary: 'Identify the likely claims.' },
            ],
            context: [],
            shortNotice: 'Here is what we can do: map the legal issue.',
            markdown: 'Here is what we can do for you right now.',
          },
        },
      ],
    }));

    const result = orchestrator.recordOracleOutcome('case-1', {
      timeout: true,
    });

    expect(result.ok).toBe(true);
    expect(result.case.userFacing.warning).toContain('Unverified');
    expect(result.case.workflow.oracleVerify.status).toBe('timeout');
  });

  test('surfaces disagreements in user-facing output', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify({
      schemaVersion: 2,
      updatedAt: '2026-03-26T10:00:00.000Z',
      cases: [
        {
          caseId: 'case-2',
          title: 'Bank collections dispute',
          domain: 'financial',
          status: 'capability_plan',
          updatedAt: '2026-03-26T10:00:00.000Z',
        },
      ],
    }));

    const result = orchestrator.recordOracleOutcome('case-2', {
      disagreements: [
        {
          topic: 'whether the debt is time-barred',
          architect: 'may still be collectible',
          oracle: 'appears time-barred',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.case.userFacing.disagreements[0].topic).toContain('time-barred');
    expect(result.case.userFacing.warning).toContain('Disagreement surfaced');
  });
});
