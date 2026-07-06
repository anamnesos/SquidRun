'use strict';

/**
 * Smoke contracts for the mount harness itself (S465): proves the runtime
 * MOUNTS and steps frames deterministically on the fake surface, so Oracle
 * can extend the throttle-coalescing and hidden-tab render-skip contracts
 * against it (his #201 residual gap).
 */

const { createMountedRoom } = require('./helpers/squid-room-mount-harness');

describe('squid-room runtime mount harness', () => {
  let harness;
  let runtime;
  let mountedCount;

  beforeAll(() => {
    harness = createMountedRoom({ petIds: ['builder', 'oracle'] });
    jest.resetModules();
    runtime = require('../modules/squid-room-creature-runtime');
    mountedCount = runtime.mountSquidRoomCreatures(harness.doc);
  });

  afterAll(() => {
    runtime.unmountSquidRoomCreatures?.();
    harness.destroy();
  });

  test('runtime mounts both creatures against the fake surface', () => {
    expect(mountedCount).toBe(2);
    const debug = runtime.getSquidRoomCreatureDebugState();
    expect(debug.map((b) => b.petId).sort()).toEqual(['builder', 'oracle']);
  });

  test('frames step deterministically and keep the loop alive', () => {
    expect(harness.pendingFrames).toBeGreaterThan(0);
    harness.step(90, 16); // ~1.5s of simulated frames
    expect(harness.pendingFrames).toBeGreaterThan(0); // loop re-arms itself
    for (const binding of runtime.getSquidRoomCreatureDebugState()) {
      expect(binding.frameCounter).toBeGreaterThanOrEqual(89);
    }
  });

  test('hidden tab: frames render-skip (counter freezes) while the loop survives', () => {
    const before = runtime.getSquidRoomCreatureDebugState().map((b) => b.frameCounter);
    harness.setHidden(true);
    harness.step(60, 16);
    const after = runtime.getSquidRoomCreatureDebugState().map((b) => b.frameCounter);
    expect(after).toEqual(before); // hidden = no work per binding
    expect(harness.pendingFrames).toBeGreaterThan(0); // loop still armed
    harness.setHidden(false);
    harness.step(2, 16);
    const resumed = runtime.getSquidRoomCreatureDebugState().map((b) => b.frameCounter);
    expect(resumed[0]).toBeGreaterThan(after[0]); // visible again = work resumes
  });

  test('window visibility event render-skips while minimized and resumes after restore', () => {
    const before = runtime.getSquidRoomCreatureDebugState().map((b) => b.frameCounter);
    harness.fireBridgeEvent('window-visibility-changed', { hidden: true, reason: 'minimize' });
    harness.step(30, 16);
    const after = runtime.getSquidRoomCreatureDebugState().map((b) => b.frameCounter);
    expect(after).toEqual(before);

    harness.fireBridgeEvent('window-visibility-changed', { hidden: false, visible: true, reason: 'restore' });
    harness.step(2, 16);
    const resumed = runtime.getSquidRoomCreatureDebugState().map((b) => b.frameCounter);
    expect(resumed[0]).toBeGreaterThan(after[0]);
  });
});
