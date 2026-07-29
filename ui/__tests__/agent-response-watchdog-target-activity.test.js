const {
  findTargetActivityAfterConfirmedDelivery,
} = require('../modules/main/agent-task-resolution');

/**
 * The response watchdog asks "was the task received?" -- not "did they reply to me."
 * These tests pin both halves of that: activity by the target counts as receipt, but
 * ONLY once the inbound delivery is independently confirmed. Every unprovable case
 * must fail toward firing the alert, never toward silence.
 */
describe('findTargetActivityAfterConfirmedDelivery', () => {
  const task = {
    senderRole: 'builder',
    targetRole: 'architect',
    sentAtMs: 1000,
    brokeredAtMs: 1000,
  };
  const deliveredInbound = {
    messageId: 'm1',
    senderRole: 'builder',
    targetRole: 'architect',
    brokeredAtMs: 1000,
    ackStatus: 'accepted.daemon_pty_unverified',
  };
  const opts = { sourceMessageId: 'm1' };

  it('resolves when the target acted by messaging the USER, not the sender', () => {
    const rows = [deliveredInbound, {
      messageId: 'm2', senderRole: 'architect', targetRole: 'user', brokeredAtMs: 2000,
    }];
    const result = findTargetActivityAfterConfirmedDelivery(task, rows, opts);
    expect(result).toBeTruthy();
    expect(result.activityRow.messageId).toBe('m2');
  });

  it('resolves when the target acted by messaging a third agent', () => {
    const rows = [deliveredInbound, {
      messageId: 'm3', senderRole: 'architect', targetRole: 'oracle', brokeredAtMs: 2000,
    }];
    expect(findTargetActivityAfterConfirmedDelivery(task, rows, opts)).toBeTruthy();
  });

  // The failure the watchdog exists for. A live, chatting pane proves nothing about
  // whether THIS message landed -- silent inbound loss looks exactly like this.
  it('does NOT resolve when the target is active but delivery was never accepted', () => {
    const rows = [
      { ...deliveredInbound, ackStatus: 'failed' },
      { messageId: 'm2', senderRole: 'architect', targetRole: 'user', brokeredAtMs: 2000 },
    ];
    expect(findTargetActivityAfterConfirmedDelivery(task, rows, opts)).toBeNull();
  });

  it('does NOT resolve when delivery is confirmed but the target produced nothing', () => {
    expect(findTargetActivityAfterConfirmedDelivery(task, [deliveredInbound], opts)).toBeNull();
  });

  it('does NOT resolve when the inbound row is absent (cannot prove delivery)', () => {
    const rows = [{
      messageId: 'm2', senderRole: 'architect', targetRole: 'user', brokeredAtMs: 2000,
    }];
    expect(findTargetActivityAfterConfirmedDelivery(task, rows, opts)).toBeNull();
  });

  it('does NOT resolve on activity from an agent other than the target', () => {
    const rows = [deliveredInbound, {
      messageId: 'm4', senderRole: 'oracle', targetRole: 'user', brokeredAtMs: 2000,
    }];
    expect(findTargetActivityAfterConfirmedDelivery(task, rows, opts)).toBeNull();
  });

  it('does NOT resolve on target activity that predates the task', () => {
    const rows = [deliveredInbound, {
      messageId: 'm5', senderRole: 'architect', targetRole: 'user', brokeredAtMs: 500,
    }];
    expect(findTargetActivityAfterConfirmedDelivery(task, rows, opts)).toBeNull();
  });

  it('does NOT resolve without a sourceMessageId to anchor the delivery leg', () => {
    const rows = [deliveredInbound, {
      messageId: 'm2', senderRole: 'architect', targetRole: 'user', brokeredAtMs: 2000,
    }];
    expect(findTargetActivityAfterConfirmedDelivery(task, rows, {})).toBeNull();
  });

  // architect->user rows carry brokeredAtMs=null in the live journal; the ordering
  // must fall back to sentAtMs rather than treating the row as timestamp-zero.
  it('uses sentAtMs when brokeredAtMs is null on the activity row', () => {
    const rows = [deliveredInbound, {
      messageId: 'm6',
      senderRole: 'architect',
      targetRole: 'user',
      brokeredAtMs: null,
      sentAtMs: 2000,
    }];
    expect(findTargetActivityAfterConfirmedDelivery(task, rows, opts)).toBeTruthy();
  });

  it('returns null on empty or malformed input rather than throwing', () => {
    expect(findTargetActivityAfterConfirmedDelivery(task, [], opts)).toBeNull();
    expect(findTargetActivityAfterConfirmedDelivery({}, [deliveredInbound], opts)).toBeNull();
    expect(findTargetActivityAfterConfirmedDelivery(task, null, opts)).toBeNull();
  });
});
