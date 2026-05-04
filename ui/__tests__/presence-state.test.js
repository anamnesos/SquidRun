'use strict';

const {
  applyPresenceEvent,
  buildPresenceLine,
  normalizePresenceState,
  shouldAcknowledgeBeforeTask,
} = require('../modules/presence-state');

describe('presence-state', () => {
  test('tracks a voice turn that needs acknowledgement before work', () => {
    let state = normalizePresenceState();
    state = applyPresenceEvent(state, {
      type: 'user_transcript',
      channel: 'voice',
      text: 'please go through all six',
      timestampMs: 1000,
    });

    expect(state.mode).toBe('heard');
    expect(state.activeChannel).toBe('voice');
    expect(state.lastHeardText).toBe('please go through all six');
    expect(shouldAcknowledgeBeforeTask(state)).toBe(true);
    expect(buildPresenceLine(state)).toBe('Heard: please go through all six');

    state = applyPresenceEvent(state, {
      type: 'mira_acknowledged',
      timestampMs: 1200,
    });

    expect(state.mode).toBe('thinking');
    expect(shouldAcknowledgeBeforeTask(state)).toBe(false);
  });

  test('keeps work and blocked states visible', () => {
    let state = applyPresenceEvent({}, {
      type: 'work_started',
      workId: 'builder-123',
      topic: 'service registry',
      timestampMs: 2000,
    });

    expect(state.mode).toBe('working');
    expect(buildPresenceLine(state)).toBe('Working: service registry');

    state = applyPresenceEvent(state, {
      type: 'blocked',
      reason: 'Approval required before sending invoice',
      timestampMs: 3000,
    });

    expect(state.mode).toBe('blocked');
    expect(buildPresenceLine(state)).toBe('Blocked: Approval required before sending invoice');
  });
});
