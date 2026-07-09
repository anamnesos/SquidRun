'use strict';

const {
  createPaneFailureMonitor,
  detectPaneLimitSignal,
  eventMessage,
  isMonitoredPaneId,
  isStalePtyGeneration,
  resolvePaneFailureCliHint,
} = require('../modules/main/pane-failure-monitor');
const {
  queryShellV2TodayJournal,
} = require('../modules/main/shell-v2-today-journal');

const CLAUDE_LIMIT_FIXTURE = [
  '\x1b[31m',
  "You\u2019ve hit your Fable 5 limit \u00b7 resets 8pm (America/Los_Angeles)",
  '\x1b[0m',
].join('');
const CODEX_LIMIT_FIXTURE = "You've hit your usage limit. To get more access now, try again later.";
const CLAUDE_STARTUP_PROMO_FIXTURE = [
  'Extended: Fable 5 is included in your weekly limit.',
  'Through July 12, you can use up to 50% of your weekly usage limit on Fable 5.',
  'If you hit your limit, you can continue on Fable 5 with usage credits.',
].join(' ');

function makeMonitor(overrides = {}) {
  const appendJournal = overrides.appendJournal || jest.fn(() => ({ ok: true, rowId: 77 }));
  const sendTelegram = overrides.sendTelegram || jest.fn(async () => ({ ok: true, messageId: 88 }));
  const log = overrides.log || { warn: jest.fn() };
  const monitor = createPaneFailureMonitor({
    getSettings: () => ({ paneFailureAlertsEnabled: true }),
    getSessionId: () => 'app-session-478',
    appendJournal,
    sendTelegram,
    now: () => 1783630358531,
    log,
    ...overrides,
    appendJournal,
    sendTelegram,
    log,
  });
  return { monitor, appendJournal, sendTelegram, log };
}

describe('pane failure limit detector', () => {
  test.each([
    [CLAUDE_LIMIT_FIXTURE, 'claude', 'claude_named_limit'],
    ["You've hit your Fable 5 limit", 'claude', 'claude_named_limit'],
    ["You've reached your Fable 5 limit.", 'claude', 'claude_named_limit'],
    ["You've hit your usage limit \u00b7 resets 8pm", 'claude', 'claude_usage_limit'],
    ["You've hit your limit", 'claude', 'claude_usage_limit'],
    ["You've hit your org's monthly spend limit \u00b7 run /usage-credits to ask your admin for a higher limit", 'claude', 'claude_monthly_limit'],
    ["You've hit your org's monthly usage limit \u00b7 resets 8pm", 'claude', 'claude_monthly_limit'],
    ["You're out of usage credits", 'claude', 'claude_usage_exhausted'],
    ['Credit balance is too low', 'claude', 'claude_credit_balance_low'],
    ["Your seat type doesn't include usage credits", 'claude', 'claude_entitlement_disabled'],
    ['This service is disabled for your org', 'claude', 'claude_entitlement_disabled'],
    [CODEX_LIMIT_FIXTURE, 'codex', 'codex_usage_limit'],
    ["You've reached your usage limit. Increase your limits to continue using codex.", 'codex', 'codex_usage_limit'],
    ["You've reached your workspace credit limit", 'codex', 'codex_workspace_credits'],
    ['Your workspace is out of credits. Add credits to continue.', 'codex', 'codex_workspace_credits'],
    ['Your workspace is out of credits. Ask your workspace owner to refill in order to continue.', 'codex', 'codex_workspace_credits'],
    ['You hit your spend cap set in your workspace. Increase your spend cap to continue.', 'codex', 'codex_workspace_spend_cap'],
    ['You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.', 'codex', 'codex_workspace_spend_cap'],
    ['To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.', 'codex', 'codex_usage_not_included'],
    ['Usage limit reached for gemini-3-pro.', 'gemini', 'gemini_usage_limit'],
    ['Usage limit reached for all Pro models.', 'gemini', 'gemini_usage_limit'],
  ])('recognizes an exact CLI refusal fixture', (fixture, cliFamily, signature) => {
    expect(detectPaneLimitSignal(fixture, cliFamily)).toEqual({
      eventName: 'usage_limit_refusal',
      cliFamily,
      signature,
    });
  });

  test.each([
    ['rate limit exceeded while calling an API', 'claude'],
    ['You have 12% usage remaining', 'claude'],
    ['request failed with status 429', 'codex'],
    ["const warning = \"You may hit your limit\";", 'claude'],
    [CLAUDE_STARTUP_PROMO_FIXTURE, 'claude'],
    ['Your workspace is out of credits. Add credits to continue.', 'claude'],
    [CLAUDE_LIMIT_FIXTURE, 'codex'],
    ["James, you've hit your Fable 5 limit for the week - want me to switch panes?", 'claude'],
    ["you've hit your limit of free retries on that API", 'claude'],
    ["The alert fires when you've hit your usage limit on any pane", 'claude'],
    ["You've hit your usage limit. This sentence is discussing the detector.", 'claude'],
    ["You've reached your Fable 5 limit. This sentence is quoting a report.", 'claude'],
  ])('rejects shaped, promotional, or wrong-provider text: %s', (fixture, cliFamily) => {
    expect(detectPaneLimitSignal(fixture, cliFamily)).toBeNull();
  });

  test('documents that quoted verbatim refusal on its own line is indistinguishable at the PTY boundary', () => {
    expect(detectPaneLimitSignal(
      `Forensics dump:\n${CLAUDE_LIMIT_FIXTURE}`,
      'claude'
    )).toEqual({
      eventName: 'usage_limit_refusal',
      cliFamily: 'claude',
      signature: 'claude_named_limit',
    });
  });

  test('keeps eligibility discrete and includes current workroom identities', () => {
    expect(isMonitoredPaneId('1')).toBe(true);
    expect(isMonitoredPaneId('trustquote-app')).toBe(true);
    expect(isMonitoredPaneId('future-workroom', { workRoomRouteOwner: true })).toBe(true);
    expect(isMonitoredPaneId('builder-bg-1', { backgroundAgent: true, workRoomRouteOwner: true })).toBe(false);
    expect(isMonitoredPaneId('unowned-pane')).toBe(false);
  });

  test('rejects an exit from an older PTY generation', () => {
    expect(isStalePtyGeneration(
      { pid: 111, createdAt: '2026-07-09T20:00:00.000Z' },
      { pid: 222, createdAt: '2026-07-09T20:10:00.000Z' }
    )).toBe(true);
    expect(isStalePtyGeneration({ pid: 222 }, { pid: 222 })).toBe(false);
  });

  test('resolves CLI identity from pane config, workroom defaults, then runtime identity', () => {
    const cliIdentity = { getPaneCommandForIdentity: jest.fn(() => 'claude') };
    expect(resolvePaneFailureCliHint('2', {
      currentSettings: { paneCommands: { '2': 'codex --yolo' } },
    }, cliIdentity)).toBe('codex --yolo');
    expect(resolvePaneFailureCliHint('trustquote-invoice', {}, cliIdentity)).toBe('codex --yolo');
    expect(resolvePaneFailureCliHint('future-pane', {
      paneCliIdentity: new Map([['future-pane', { label: 'Gemini', provider: 'Google' }]]),
    }, cliIdentity)).toEqual({ label: 'Gemini', provider: 'Google' });
  });
});

describe('pane failure notify path', () => {
  test('buffers split output, journals a System row, and sends one Telegram', async () => {
    const { monitor, appendJournal, sendTelegram } = makeMonitor();

    await monitor.handlePtyData('1', CLAUDE_LIMIT_FIXTURE.slice(0, 4), { pid: 123 }, 'claude');
    expect(appendJournal).not.toHaveBeenCalled();

    const result = await monitor.handlePtyData('1', CLAUDE_LIMIT_FIXTURE.slice(4), { pid: 123 }, 'claude');

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      ignored: false,
      paneId: '1',
      eventName: 'usage_limit_refusal',
    }));
    expect(result.message).toBe(
      'Mira (pane 1) hit its usage limit - replies will silently stop until you switch to an available model/session or the limit resets.'
    );
    expect(appendJournal).toHaveBeenCalledTimes(1);
    expect(appendJournal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'app-session-478',
      channel: 'system',
      direction: 'outbound',
      senderRole: 'system',
      targetRole: 'system',
      status: 'recorded',
      rawBody: result.message,
      metadata: expect.objectContaining({
        source: 'pane-failure-monitor',
        eventName: 'usage_limit_refusal',
        paneId: '1',
        scope: 'main',
        windowKey: 'main',
        todayVisible: true,
      }),
    }));
    const telegramOptions = sendTelegram.mock.calls[0][2];
    const telegramJournalRow = {
      messageId: telegramOptions.messageId,
      sessionId: telegramOptions.sessionId,
      channel: 'telegram',
      direction: 'outbound',
      senderRole: telegramOptions.senderRole,
      targetRole: telegramOptions.targetRole,
      sentAtMs: appendJournal.mock.calls[0][0].sentAtMs,
      rawBody: result.message,
      status: 'recorded',
      metadata: telegramOptions.metadata,
    };
    const today = queryShellV2TodayJournal({ nowMs: 1783630358531 }, {
      queryEntries: () => [telegramJournalRow, appendJournal.mock.calls[0][0]],
    });
    expect(today.rows).toEqual([
      expect.objectContaining({
        messageId: result.systemMessageId,
        scope: 'main',
        senderRole: 'system',
        targetRole: 'system',
      }),
    ]);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith(
      result.message,
      process.env,
      expect.objectContaining({
        senderRole: 'system',
        targetRole: 'user',
        sessionId: 'app-session-478',
        metadata: expect.objectContaining({
          eventName: 'usage_limit_refusal',
          systemMessageId: result.systemMessageId,
          todayVisible: false,
        }),
      })
    );
  });

  test('rate-limits each event state until a discrete spawn recovery', async () => {
    const { monitor, appendJournal, sendTelegram } = makeMonitor();

    await monitor.handlePtyData('2', CODEX_LIMIT_FIXTURE, null, 'codex');
    await monitor.handlePtyData('2', CODEX_LIMIT_FIXTURE, null, 'codex');
    await monitor.handlePtyExit('2', 1, { pid: 12 }, { pid: 12 });
    await monitor.handlePtyExit('2', 1, { pid: 12 }, { pid: 12 });

    expect(appendJournal).toHaveBeenCalledTimes(2);
    expect(sendTelegram).toHaveBeenCalledTimes(2);
    expect(sendTelegram.mock.calls[1][0]).toBe(
      'Builder (pane 2) exited (code 1) - replies will silently stop until the pane is restarted.'
    );

    expect(monitor.handlePtySpawn('2')).toEqual({
      ok: true,
      paneId: '2',
      recovered: true,
      clearedEvents: 2,
    });
    await monitor.handlePtyData('2', CODEX_LIMIT_FIXTURE, null, 'codex');
    await monitor.handlePtyExit('2', 1, { pid: 13 }, { pid: 13 });

    expect(appendJournal).toHaveBeenCalledTimes(4);
    expect(sendTelegram).toHaveBeenCalledTimes(4);
  });

  test('latches the same event independently for each pane', async () => {
    const { monitor, appendJournal, sendTelegram } = makeMonitor();

    await monitor.handlePtyData('1', CLAUDE_LIMIT_FIXTURE, null, 'claude');
    await monitor.handlePtyData('3', CLAUDE_LIMIT_FIXTURE, null, 'claude');
    await monitor.handlePtyData('1', CLAUDE_LIMIT_FIXTURE, null, 'claude');

    expect(appendJournal).toHaveBeenCalledTimes(2);
    expect(sendTelegram).toHaveBeenCalledTimes(2);
    expect(sendTelegram.mock.calls.map((call) => call[0])).toEqual([
      expect.stringContaining('Mira (pane 1) hit its usage limit'),
      expect.stringContaining('Oracle (pane 3) hit its usage limit'),
    ]);
  });

  test('does not notify for disabled, unmonitored, background, or stale signals', async () => {
    const disabled = makeMonitor({
      getSettings: () => ({ paneFailureAlertsEnabled: false }),
    });
    await disabled.monitor.handlePtyData('1', CLAUDE_LIMIT_FIXTURE, null, 'claude');
    await disabled.monitor.handlePtyExit('1', 1, { pid: 1 }, { pid: 1 });
    expect(disabled.sendTelegram).not.toHaveBeenCalled();

    const active = makeMonitor();
    await active.monitor.handlePtyData('not-a-pane', CODEX_LIMIT_FIXTURE, null, 'codex');
    await active.monitor.handlePtyData('builder-bg-1', CODEX_LIMIT_FIXTURE, {
      backgroundAgent: true,
      workRoomRouteOwner: true,
    }, 'codex');
    await active.monitor.handlePtyExit('1', 1, { pid: 11 }, { pid: 12 });
    expect(active.appendJournal).not.toHaveBeenCalled();
    expect(active.sendTelegram).not.toHaveBeenCalled();
  });

  test('keeps the audit latch active when journal or Telegram delivery fails', async () => {
    const { monitor, appendJournal, sendTelegram, log } = makeMonitor({
      appendJournal: jest.fn(() => ({ ok: false, reason: 'ledger_down' })),
      sendTelegram: jest.fn(async () => ({ ok: false, error: 'telegram_down' })),
    });

    const first = await monitor.handlePtyExit('trustquote-app', 9, { pid: 31 }, { pid: 31 });
    const second = await monitor.handlePtyExit('trustquote-app', 9, { pid: 31 }, { pid: 31 });

    expect(first.ok).toBe(false);
    expect(second).toEqual(expect.objectContaining({
      ok: true,
      ignored: true,
      reason: 'event_state_already_active',
    }));
    expect(appendJournal).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  test('formats workroom notifications with the visible pane label', () => {
    expect(eventMessage({
      eventName: 'usage_limit_refusal',
      paneId: 'trustquote-schedule-dispatch',
    })).toBe(
      'Schedule Dispatch workroom pane hit its usage limit - replies will silently stop until you switch to an available model/session or the limit resets.'
    );
  });

  test('gives account and credit refusals an actionable recovery message', () => {
    expect(eventMessage({
      eventName: 'usage_limit_refusal',
      paneId: '2',
      cliFamily: 'codex',
      signature: 'codex_usage_not_included',
    })).toBe(
      'Builder (pane 2) got a Codex account, credit, or spend refusal - replies will silently stop until you switch to an eligible model/account or resolve the billing/admin limit.'
    );
  });
});
