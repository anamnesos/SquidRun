const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  materializeSessionHandoff,
  buildSessionHandoffMarkdown,
  removeLegacyPaneHandoffFiles,
  _internals,
} = require('../modules/main/auto-handoff-materializer');

describe('auto-handoff-materializer', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-auto-handoff-'));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('buildSessionHandoffMarkdown is deterministic and includes explicit tags + trace ids', () => {
    const rows = [
      {
        messageId: 'm1',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCHITECT #1): DECISION: Use single handoff file',
        brokeredAtMs: 1000,
        metadata: { traceId: 'trc-1' },
      },
      {
        messageId: 'm2',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'failed',
        ackStatus: 'failed',
        errorCode: 'delivery_timeout',
        rawBody: '(BUILDER #1): Attempted delivery',
        brokeredAtMs: 1500,
        metadata: { traceId: 'trc-2' },
      },
    ];

    const first = buildSessionHandoffMarkdown(rows, { sessionId: 's1', nowMs: 2000 });
    const second = buildSessionHandoffMarkdown(rows, { sessionId: 's1', nowMs: 2000 });

    expect(first).toBe(second);
    expect(first).toContain('Session Handoff Index (auto-generated, deterministic)');
    expect(first).toContain('DECISION');
    expect(first).toContain('trc-1');
    expect(first).toContain('delivery_timeout');
    expect(first).toContain('## Cross-Session Decisions');
  });

  test('extractTag only matches anchored tags or known prefixed markers', () => {
    expect(_internals.extractTag('DECISION: Canonical envelope')).toEqual({
      tag: 'DECISION',
      detail: 'Canonical envelope',
    });
    expect(_internals.extractTag('(ARCHITECT #1): FINDING: Queue race fixed')).toEqual({
      tag: 'FINDING',
      detail: 'Queue race fixed',
    });
    expect(_internals.extractTag('[AGENT MSG - reply via hm-send.js] (BUILDER #4): TASK: Add tests')).toEqual({
      tag: 'TASK',
      detail: 'Add tests',
    });

    expect(_internals.extractTag('We discussed DECISION: but this is inline prose')).toBeNull();
    expect(_internals.extractTag('prefix DECISION: not anchored')).toBeNull();
    expect(_internals.extractTag('(ARCHITECT #1): NOTE: not an allowed tag')).toBeNull();
  });

  test('resolveEffectiveSessionScopeId prefers current app-session scope for legacy app bootstrap ids', () => {
    expect(_internals.resolveEffectiveSessionScopeId('app-7736-1771709282380', {
      resolveCurrentSessionScopeId: () => 'app-session-42',
    })).toBe('app-session-42');
    expect(_internals.resolveEffectiveSessionScopeId(null, {
      resolveCurrentSessionScopeId: () => 7,
    })).toBe('app-session-7');
    expect(_internals.resolveEffectiveSessionScopeId('session-current', {
      resolveCurrentSessionScopeId: () => 'app-session-99',
    })).toBe('session-current');
  });

  test('pending deliveries exclude failed rows and resolved brokered rows', () => {
    const rows = [
      {
        messageId: 'm-brokered-resolved',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCHITECT #1): standby',
        brokeredAtMs: 1000,
      },
      {
        messageId: 'm-brokered-unverified',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        ackStatus: 'accepted.unverified',
        rawBody: '(ARCHITECT #2): check',
        brokeredAtMs: 1100,
      },
      {
        messageId: 'm-routed-failed',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        errorCode: 'delivery_timeout',
        rawBody: '(ARCHITECT #3): timeout',
        brokeredAtMs: 1200,
      },
      {
        messageId: 'm-recorded-pending',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'recorded',
        rawBody: '(BUILDER #1): queued',
        brokeredAtMs: 1300,
      },
    ];

    const markdown = buildSessionHandoffMarkdown(rows, {
      sessionId: 's-pending-check',
      nowMs: 2000,
    });
    const pendingSection = markdown.split('## Pending Deliveries')[1].split('## Recent Messages')[0];
    const failedSection = markdown.split('## Failed Deliveries')[1].split('## Pending Deliveries')[0];

    expect(markdown).toContain('- failed_rows: 1');
    expect(markdown).toContain('- pending_rows: 2');
    expect(pendingSection).toContain('| m-brokered-unverified |');
    expect(pendingSection).toContain('| m-recorded-pending |');
    expect(pendingSection).not.toContain('| m-brokered-resolved |');
    expect(pendingSection).not.toContain('| m-routed-failed |');
    expect(failedSection).toContain('| m-routed-failed |');
  });

  test('Pending Deliveries excludes brokered rows and tracks unresolved outbound rows only', () => {
    const rows = [
      {
        messageId: 'm-recorded',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'recorded',
        rawBody: '(ARCHITECT #1): TASK: Pending send',
        brokeredAtMs: 1000,
      },
      {
        messageId: 'm-brokered',
        senderRole: 'architect',
        targetRole: 'oracle',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCHITECT #2): TASK: Delivered to broker',
        brokeredAtMs: 1100,
      },
      {
        messageId: 'm-routed',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        rawBody: '(BUILDER #1): Awaiting verification',
        brokeredAtMs: 1200,
      },
      {
        messageId: 'm-inbound-recorded',
        senderRole: 'user',
        targetRole: 'architect',
        channel: 'telegram',
        direction: 'inbound',
        status: 'recorded',
        rawBody: 'Hello',
        brokeredAtMs: 1300,
      },
    ];

    const markdown = buildSessionHandoffMarkdown(rows, { sessionId: 's-pending', nowMs: 2000 });
    const pendingSection = markdown.split('## Pending Deliveries')[1].split('## Recent Messages')[0];

    expect(markdown).toContain('- pending_rows: 2');
    expect(pendingSection).toContain('m-recorded');
    expect(pendingSection).toContain('m-routed');
    expect(pendingSection).not.toContain('m-brokered');
    expect(pendingSection).not.toContain('m-inbound-recorded');
  });

  test('materializeSessionHandoff writes once and skips rewrite when unchanged', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session.md');
    const rows = [
      {
        messageId: 'm1',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCHITECT #1): TASK: Implement phase 3',
        brokeredAtMs: 1000,
        metadata: { traceId: 'trc-1' },
      },
    ];

    const first = await materializeSessionHandoff({
      rows,
      outputPath,
      legacyMirrorPath: false,
      sessionId: 'session-a',
      nowMs: 5000,
    });
    const second = await materializeSessionHandoff({
      rows,
      outputPath,
      legacyMirrorPath: false,
      sessionId: 'session-a',
      nowMs: 5000,
    });

    expect(first.ok).toBe(true);
    expect(first.written).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.written).toBe(false);
    expect(fs.existsSync(outputPath)).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf8');
    expect(content).toContain('TASK');
  });

  test('materializeSessionHandoff includes concise unresolved claims section', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session.md');
    const longStatement = 'A very long contested claim statement '.repeat(6);
    const proposedClaims = Array.from({ length: 12 }, (_, index) => ({
      id: `clm_proposed_${String(index).padStart(2, '0')}`,
      status: 'proposed',
      statement: `Proposed claim #${index}`,
      confidence: 0.4 + (index * 0.01),
    }));
    proposedClaims.push({
      id: 'clm_noise',
      status: 'proposed',
      statement: 'delivered.verified',
      confidence: 0.99,
    });
    proposedClaims.push({
      id: 'clm_noise_init',
      status: 'proposed',
      statement: 'Initializing session app-session-900',
      confidence: 0.95,
    });
    proposedClaims.push({
      id: 'clm_noise_start',
      status: 'proposed',
      statement: 'Session started for app-session-900',
      confidence: 0.94,
    });

    const result = await materializeSessionHandoff({
      rows: [],
      outputPath,
      legacyMirrorPath: false,
      sessionId: 'session-claims',
      nowMs: 6000,
      queryClaims: ({ status }) => {
        if (status === 'contested') {
          return {
            ok: true,
            claims: [{
              id: 'clm_contested',
              status: 'contested',
              statement: longStatement,
              confidence: 0.91,
            }],
          };
        }
        if (status === 'pending_proof') {
          return {
            ok: true,
            claims: [{
              id: 'clm_pending',
              status: 'pending_proof',
              statement: 'Pending proof claim',
              confidence: 0.73,
            }],
          };
        }
        return { ok: true, claims: proposedClaims };
      },
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf8');
    expect(content).toContain('## Unresolved Claims');
    expect(content).toContain('| clm_contested | contested |');
    expect(content).toContain('| clm_pending | pending_proof |');
    expect(content).not.toContain('clm_noise');
    expect(content).not.toContain('clm_noise_init');
    expect(content).not.toContain('clm_noise_start');
    expect(content).not.toContain('delivered.verified');
    expect(content).not.toContain('Initializing session');
    expect(content).not.toContain('Session started');

    const unresolvedRows = content
      .split('\n')
      .filter((line) => line.startsWith('| clm_'));
    expect(unresolvedRows.length).toBe(10);

    const contestedRow = unresolvedRows.find((line) => line.includes('| clm_contested |'));
    expect(contestedRow).toBeDefined();
    expect(contestedRow).toContain('...');
  });

  test('materializeSessionHandoff carries cross-session tagged decisions/tasks/findings/blockers', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session.md');
    const queryCalls = [];
    const result = await materializeSessionHandoff({
      sessionId: 'session-current',
      outputPath,
      legacyMirrorPath: false,
      nowMs: 10_000,
      queryCommsJournal: (filters = {}) => {
        queryCalls.push(filters);
        if (filters.sessionId === 'session-current') {
          return [
            {
              messageId: 'm-current',
              sessionId: 'session-current',
              senderRole: 'architect',
              targetRole: 'builder',
              channel: 'ws',
              direction: 'outbound',
              status: 'brokered',
              rawBody: '(ARCHITECT #9): TASK: Current session implementation',
              brokeredAtMs: 3000,
            },
          ];
        }
        return [
          {
            messageId: 'm-old-1',
            sessionId: 'session-old-1',
            senderRole: 'architect',
            targetRole: 'builder',
            channel: 'ws',
            direction: 'outbound',
            status: 'brokered',
            rawBody: '(ARCHITECT #2): DECISION: Keep coordinator deterministic',
            brokeredAtMs: 1000,
          },
          {
            messageId: 'm-old-2',
            sessionId: 'session-old-2',
            senderRole: 'oracle',
            targetRole: 'architect',
            channel: 'ws',
            direction: 'outbound',
            status: 'brokered',
            rawBody: '(ORACLE #3): FINDING: Trigger delivery had no loss',
            brokeredAtMs: 2000,
          },
          {
            messageId: 'm-old-3',
            sessionId: 'session-old-2',
            senderRole: 'architect',
            targetRole: 'builder',
            channel: 'ws',
            direction: 'outbound',
            status: 'brokered',
            rawBody: '(ARCHITECT #4): ACTION: This should not be in cross-session carry',
            brokeredAtMs: 2100,
          },
        ];
      },
      queryClaims: () => ({ ok: true, claims: [] }),
    });

    expect(result.ok).toBe(true);
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0].sessionId).toBe('session-current');
    expect(queryCalls[1].sessionId).toBeUndefined();

    const content = fs.readFileSync(outputPath, 'utf8');
    const digestSection = content
      .split('## Decision Digest')[1]
      .split('## Cross-Session Decisions')[0];
    const crossSessionSection = content
      .split('## Cross-Session Decisions')[1]
      .split('## Tagged Signals')[0];

    expect(digestSection).toContain('| session-old-1 |');
    expect(digestSection).toContain('| session-old-2 |');
    expect(digestSection).toContain('DECISION: Keep coordinator deterministic');
    expect(digestSection).toContain('FINDING: Trigger delivery had no loss');
    expect(digestSection).not.toContain('ACTION');

    expect(crossSessionSection).toContain('| session-old-1 | DECISION |');
    expect(crossSessionSection).toContain('| session-old-2 | FINDING |');
    expect(crossSessionSection).not.toContain('ACTION');
  });

  test('Decision Digest is grouped by session and capped to last 10 sessions', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session.md');
    const crossRows = Array.from({ length: 12 }, (_, index) => ({
      messageId: `m-${index}`,
      sessionId: `session-${index}`,
      senderRole: 'architect',
      targetRole: 'builder',
      channel: 'ws',
      direction: 'outbound',
      status: 'brokered',
      rawBody: `(ARCHITECT #${index + 1}): DECISION: Decision ${index}`,
      brokeredAtMs: 1000 + index,
    }));
    crossRows.push({
      messageId: 'm-task-ignore',
      sessionId: 'session-11',
      senderRole: 'builder',
      targetRole: 'architect',
      channel: 'ws',
      direction: 'outbound',
      status: 'brokered',
      rawBody: '(BUILDER #77): TASK: Should not appear in digest highlights',
      brokeredAtMs: 3000,
    });

    const result = await materializeSessionHandoff({
      rows: [],
      crossSessionRows: crossRows,
      queryClaims: () => ({ ok: true, claims: [] }),
      outputPath,
      legacyMirrorPath: false,
      sessionId: 'session-current',
      nowMs: 10_000,
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf8');
    const digestSection = content
      .split('## Decision Digest')[1]
      .split('## Cross-Session Decisions')[0];

    const sessionRows = digestSection
      .split('\n')
      .filter((line) => line.startsWith('| session-'));

    expect(sessionRows.length).toBe(10);
    expect(digestSection).toContain('| session-11 |');
    expect(digestSection).toContain('| session-2 |');
    expect(digestSection).not.toContain('| session-1 |');
    expect(digestSection).not.toContain('| session-0 |');
    expect(digestSection).not.toContain('TASK: Should not appear in digest highlights');
  });

  test('removeLegacyPaneHandoffFiles deletes legacy files', () => {
    const handoffsDir = path.join(tempDir, 'handoffs');
    fs.mkdirSync(handoffsDir, { recursive: true });
    fs.writeFileSync(path.join(handoffsDir, '1.md'), 'a', 'utf8');
    fs.writeFileSync(path.join(handoffsDir, '2.md'), 'b', 'utf8');
    fs.writeFileSync(path.join(handoffsDir, '3.md'), 'c', 'utf8');

    const result = removeLegacyPaneHandoffFiles({
      roots: [handoffsDir],
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toHaveLength(3);
    expect(fs.existsSync(path.join(handoffsDir, '1.md'))).toBe(false);
    expect(fs.existsSync(path.join(handoffsDir, '2.md'))).toBe(false);
    expect(fs.existsSync(path.join(handoffsDir, '3.md'))).toBe(false);
  });
});
