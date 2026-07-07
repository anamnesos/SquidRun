const {
  DOORBELL_EVENTS,
  DOORBELL_TRIGGER_EVENTS,
  createDoorbellState,
  transitionDoorbell,
  validateDoorbellEvent,
} = require('../modules/shell-v2-doorbell');

describe('shell-v2 doorbell store', () => {
  test('whitelist rejects unknown event names', () => {
    expect(DOORBELL_TRIGGER_EVENTS).toEqual(['permission_prompt', 'lead_escalation', 'process_exit']);
    expect(DOORBELL_EVENTS).toEqual(['permission_prompt', 'lead_escalation', 'process_exit', 'doorbell_ack']);
    expect(() => validateDoorbellEvent('idle_timeout')).toThrow(/Unknown Shell V2 doorbell event/);
  });

  test('trigger transition writes receipt and increments state', async () => {
    const state = createDoorbellState();
    const writeJournal = jest.fn(async () => ({ ok: true, rowId: 101 }));

    const result = await transitionDoorbell(state, 'permission_prompt', {
      paneId: '2',
      label: 'Builder',
      displayText: 'permission',
      detail: 'CLI permission prompt detected',
      timestampMs: 1783451000000,
      messageId: 'doorbell-test-1',
      sessionId: 'app-session-test',
    }, { writeJournal });

    expect(result.ok).toBe(true);
    expect(state.count).toBe(1);
    expect(state.byPane['2'].eventName).toBe('permission_prompt');
    expect(writeJournal).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'doorbell-test-1',
      senderRole: 'system',
      targetRole: 'architect',
      rawBody: expect.stringContaining('permission_prompt'),
      metadata: expect.objectContaining({
        source: 'shell-v2-doorbell',
        scope: 'main',
        windowKey: 'main',
        doorbellEvent: 'permission_prompt',
        paneId: '2',
        previousCount: 0,
        nextCount: 1,
      }),
    }));
  });

  test('ack transition clears only after writing its receipt', async () => {
    const state = createDoorbellState();
    const writeJournal = jest.fn(async () => ({ ok: true }));

    await transitionDoorbell(state, 'process_exit', {
      paneId: '3',
      label: 'Oracle',
      displayText: 'exited (0)',
      timestampMs: 1,
      messageId: 'doorbell-fire',
    }, { writeJournal });
    await transitionDoorbell(state, 'doorbell_ack', {
      paneId: 'squid-room',
      label: 'Squid Room',
      detail: 'cleared',
      timestampMs: 2,
      messageId: 'doorbell-ack',
    }, { writeJournal });

    expect(state.count).toBe(0);
    expect(Object.keys(state.byPane)).toHaveLength(0);
    expect(writeJournal).toHaveBeenLastCalledWith(expect.objectContaining({
      messageId: 'doorbell-ack',
      rawBody: expect.stringContaining('doorbell_ack'),
      metadata: expect.objectContaining({
        doorbellEvent: 'doorbell_ack',
        previousCount: 1,
        nextCount: 0,
      }),
    }));
  });
});
