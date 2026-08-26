'use strict';

/**
 * ORACLE EXTENSION on Builder's mount harness (S465): the two contracts that
 * needed a real mounted runtime — full pulse THROTTLE-COALESCING and the
 * runtime half of SUSPENSION (engine state frozen while hidden). Completes
 * the residual gap named in Oracle #201.
 */

const { createMountedRoom } = require('./helpers/squid-room-mount-harness');

describe('runtime contracts on the mount harness', () => {
  let room;
  let runtime;
  let nowSpy;
  let fakeNow = 100000;

  beforeAll(() => {
    room = createMountedRoom({ petIds: ['builder', 'oracle'] });
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    runtime = require('../modules/squid-room-creature-runtime');
    runtime.mountSquidRoomCreatures();
    room.step(5, 16);
  });

  afterAll(() => {
    nowSpy.mockRestore();
    runtime.unmountSquidRoomCreatures?.();
    room.destroy();
  });

  test('pulse throttle coalesces a burst into ONE pulse per 10s window', () => {
    expect(runtime.notifySquidRoomComms('builder', 'oracle')).toBe(true);
    // Burst inside the window: every one coalesced, none fire.
    for (let i = 0; i < 5; i += 1) {
      fakeNow += 500;
      expect(runtime.notifySquidRoomComms('builder', 'oracle')).toBe(false);
    }
    // Window expires -> next real row may pulse again.
    fakeNow += 10001;
    expect(runtime.notifySquidRoomComms('oracle', 'builder')).toBe(true);
    // And the throttle re-arms off the NEW pulse, not the old one.
    fakeNow += 500;
    expect(runtime.notifySquidRoomComms('builder', 'oracle')).toBe(false);
  });

  test('suspension: engine state freezes while hidden, resumes on visible', () => {
    const before = runtime.getSquidRoomCreatureDebugState();
    room.setHidden(true);
    room.step(60, 16); // a second of hidden frames
    const hidden = runtime.getSquidRoomCreatureDebugState();
    for (let i = 0; i < before.length; i += 1) {
      // frameCounter is the tick gate: frozen while hidden = engines untouched.
      expect(hidden[i].frameCounter).toBe(before[i].frameCounter);
    }
    room.setHidden(false);
    room.step(10, 16);
    const resumed = runtime.getSquidRoomCreatureDebugState();
    for (let i = 0; i < before.length; i += 1) {
      expect(resumed[i].frameCounter).toBeGreaterThan(hidden[i].frameCounter);
    }
    // The loop itself must survive suspension (rAF still re-arming).
    expect(room.pendingFrames).toBeGreaterThan(0);
  });

  test('pulse honesty holds post-mount: unknown pet still cannot pulse', () => {
    fakeNow += 20000;
    expect(runtime.notifySquidRoomComms('builder', 'ghost')).toBe(false);
    // A refused pulse must NOT consume the throttle window.
    expect(runtime.notifySquidRoomComms('builder', 'oracle')).toBe(true);
  });
});
