jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
}));

describe('status-strip owned-work summary', () => {
  let elements;
  let statusStrip;

  function installDom() {
    elements = {
      sessionTimer: {
        textContent: '',
      },
      ownedWorkSummary: {
        textContent: '',
        title: '',
        className: '',
      },
    };

    global.document = {
      getElementById: jest.fn((id) => elements[id] || null),
    };
  }

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    installDom();
    global.window = {
      squidrun: {
        invoke: jest.fn(),
      },
    };
    statusStrip = require('../modules/status-strip');
  });

  afterEach(() => {
    statusStrip.shutdownStatusStrip();
    delete global.document;
    delete global.window;
    jest.useRealTimers();
  });

  test('renders idle owned-work state', () => {
    statusStrip.renderOwnedWorkSummary({
      ok: true,
      whatImCarrying: {
        agents: {},
        totals: {
          activeCount: 0,
          carriedCount: 0,
          blockedCount: 0,
          approvalRequiredCount: 0,
          staleCount: 0,
        },
      },
    });

    expect(elements.ownedWorkSummary.textContent).toBe('Carrying: idle');
    expect(elements.ownedWorkSummary.className).toBe('owned-work-summary idle');
    expect(elements.ownedWorkSummary.title).toContain('No active carried work');
  });

  test('renders active carried item with blocked and approval indicators', () => {
    const summary = {
      ok: true,
      whatImCarrying: {
        agents: {
          builder: {
            active: {
              title: 'Routing patch',
              nextStep: 'Run focused tests',
              blockedReason: 'Needs scoped route',
              wakeTrigger: 'post-wake',
            },
          },
        },
        totals: {
          activeCount: 1,
          carriedCount: 3,
          blockedCount: 1,
          approvalRequiredCount: 1,
          staleCount: 0,
        },
      },
    };

    statusStrip.renderOwnedWorkSummary(summary);

    expect(elements.ownedWorkSummary.textContent).toBe(
      'Carrying: Builder: Routing patch | 1 blocked | 1 approval',
    );
    expect(elements.ownedWorkSummary.className).toBe('owned-work-summary warn');
    expect(elements.ownedWorkSummary.title).toContain('Next: Run focused tests');
    expect(elements.ownedWorkSummary.title).toContain('Blocked: Needs scoped route');
    expect(elements.ownedWorkSummary.title).toContain('Wake: post-wake');
  });

  test('handles unavailable owned-work IPC gracefully', async () => {
    global.window.squidrun.invoke.mockRejectedValueOnce(new Error('ipc offline'));

    await statusStrip.refreshOwnedWorkSummary();

    expect(global.window.squidrun.invoke).toHaveBeenCalledWith('get-owned-work-summary');
    expect(elements.ownedWorkSummary.textContent).toBe('Carrying: unavailable');
    expect(elements.ownedWorkSummary.className).toBe('owned-work-summary unavailable');
  });

  test('initializes and shuts down summary refresh without workflow controls', async () => {
    global.window.squidrun.invoke.mockResolvedValueOnce({
      ok: true,
      whatImCarrying: {
        agents: {},
        totals: {
          activeCount: 0,
          carriedCount: 0,
          blockedCount: 0,
          approvalRequiredCount: 0,
          staleCount: 0,
        },
      },
    });

    statusStrip.initStatusStrip();
    await Promise.resolve();

    expect(elements.sessionTimer.textContent).toBe('Session: 0:00');
    expect(global.window.squidrun.invoke).toHaveBeenCalledWith('get-owned-work-summary');
    expect(jest.getTimerCount()).toBe(2);

    statusStrip.shutdownStatusStrip();

    expect(jest.getTimerCount()).toBe(0);
  });
});
