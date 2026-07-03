'use strict';

/**
 * Born Observable v0 contracts (organism charter, Builder organ #3): the
 * pure core of the instrument deck. The heartbeat parser reads the real
 * flight-recorder format; the RSS assessor knows the S464 explosion
 * signature; the motion assessor detects the S463 frozen-renderer death
 * class from bytes alone - no eyes required.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseHeartbeats, assessRssTrend, assessFrameMotion } = require('../scripts/hm-observe');

describe('born observable: pure core', () => {
  test('parses real flight-recorder heartbeat lines', () => {
    const log = [
      '05:05:06.306 [INFO] [SquidRoomCreature] heartbeat heapMB=18 rssMB=195 bindings=2',
      '05:05:36.309 [WARN] [Other] noise line',
      '05:05:36.309 [INFO] [SquidRoomCreature] heartbeat heapMB=18 rssMB=196 bindings=2',
    ].join('\n');
    const samples = parseHeartbeats(log);
    expect(samples).toHaveLength(2);
    expect(samples[1]).toEqual({ time: '05:05:36', heapMB: 18, rssMB: 196, bindings: 2 });
  });

  test('RSS assessor flags the S464 explosion signature', () => {
    // The real trail from the night the flight recorder caught the killer.
    const explosion = [195, 196, 197, 269, 1141, 2905].map((rssMB, i) => ({ time: `t${i}`, heapMB: 18, rssMB, bindings: 2 }));
    expect(assessRssTrend(explosion).verdict).toBe('exploding');
    const stable = [191, 195, 196, 197, 196, 195].map((rssMB, i) => ({ time: `t${i}`, heapMB: 22, rssMB, bindings: 2 }));
    expect(assessRssTrend(stable).verdict).toBe('stable');
    expect(assessRssTrend([]).verdict).toBe('insufficient');
  });

  test('motion assessor: identical frames = frozen, distinct = alive, tiny = dead', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-'));
    try {
      const bigA = path.join(dir, 'a.png');
      const bigB = path.join(dir, 'b.png');
      const bigA2 = path.join(dir, 'a2.png');
      fs.writeFileSync(bigA, Buffer.alloc(20 * 1024, 1));
      fs.writeFileSync(bigA2, Buffer.alloc(20 * 1024, 1)); // identical bytes
      fs.writeFileSync(bigB, Buffer.alloc(20 * 1024, 2)); // different bytes

      expect(assessFrameMotion([bigA, bigA2]).verdict).toBe('frozen');
      expect(assessFrameMotion([bigA, bigB]).verdict).toBe('alive');

      const tiny = path.join(dir, 'tiny.png');
      fs.writeFileSync(tiny, Buffer.alloc(512, 1));
      expect(assessFrameMotion([bigA, tiny]).verdict).toBe('dead');
      expect(assessFrameMotion([bigA]).verdict).toBe('insufficient');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
