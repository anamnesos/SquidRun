/**
 * Tests for main-process Event Kernel bridge transport wrapper.
 */

const {
  KernelBridge,
  BRIDGE_EVENT_CHANNEL,
  BRIDGE_STATS_CHANNEL,
  BRIDGE_VERSION,
} = require('../modules/main/kernel-bridge');

describe('KernelBridge', () => {
  function makeWindow() {
    return {
      isDestroyed: jest.fn(() => false),
      webContents: {
        send: jest.fn(),
      },
    };
  }

  test('wraps daemon event in bridge transport envelope', () => {
    const window = makeWindow();
    const bridge = new KernelBridge(() => window);

    const daemonEvent = {
      eventId: 'evt-1',
      correlationId: 'corr-1',
      causationId: null,
      type: 'daemon.write.ack',
      source: 'daemon',
      paneId: '2',
      ts: 111,
      seq: 1,
      payload: { status: 'accepted' },
    };

    const ok = bridge.forwardDaemonEvent(daemonEvent);
    expect(ok).toBe(true);

    const call = window.webContents.send.mock.calls.find(([channel]) => channel === BRIDGE_EVENT_CHANNEL);
    expect(call).toBeDefined();
    const envelope = call[1];
    expect(envelope.bridgeVersion).toBe(BRIDGE_VERSION);
    expect(envelope.bridgeSeq).toBe(1);
    expect(envelope.direction).toBe('daemon->renderer');
    expect(envelope.event).toEqual(daemonEvent);
  });

  test('emits bridge lifecycle events with source=bridge', () => {
    const window = makeWindow();
    const bridge = new KernelBridge(() => window);

    const ok = bridge.emitBridgeEvent('bridge.connected', { transport: 'daemon-client' });
    expect(ok).toBe(true);

    const call = window.webContents.send.mock.calls.find(([channel]) => channel === BRIDGE_EVENT_CHANNEL);
    const envelope = call[1];
    expect(envelope.event.type).toBe('bridge.connected');
    expect(envelope.event.source).toBe('bridge');
    expect(envelope.direction).toBe('main->renderer');
  });

  test('records dropped events and emits event.dropped when renderer returns', () => {
    let liveWindow = null;
    const bridge = new KernelBridge(() => liveWindow);

    // Drop while renderer is unavailable.
    bridge.emitBridgeEvent('bridge.connected', { transport: 'daemon-client' });
    expect(bridge.getStats().droppedCount).toBe(1);

    // Renderer comes back: first payload should be event.dropped summary.
    liveWindow = makeWindow();
    bridge.emitBridgeEvent('bridge.connected', { resumed: true });

    const kernelEventCalls = liveWindow.webContents.send.mock.calls
      .filter(([channel]) => channel === BRIDGE_EVENT_CHANNEL)
      .map(([, payload]) => payload);

    expect(kernelEventCalls.length).toBeGreaterThanOrEqual(2);
    expect(kernelEventCalls[0].event.type).toBe('event.dropped');
    expect(kernelEventCalls[0].event.payload.droppedCount).toBe(1);
    expect(kernelEventCalls[1].event.type).toBe('bridge.connected');
  });

  test('publishes stats on kernel:bridge-stats channel', () => {
    const window = makeWindow();
    const bridge = new KernelBridge(() => window);

    bridge.emitBridgeEvent('bridge.connected', { transport: 'daemon-client' });

    const statsCall = window.webContents.send.mock.calls.find(([channel]) => channel === BRIDGE_STATS_CHANNEL);
    expect(statsCall).toBeDefined();
    expect(statsCall[1].bridgeVersion).toBe(BRIDGE_VERSION);
    expect(statsCall[1].forwardedCount).toBe(1);
  });
});

