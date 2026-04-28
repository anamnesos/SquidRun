'use strict';

const path = require('path');

const sentinel = require('../scripts/hm-bus-sentinel.js');

describe('hm-bus-sentinel', () => {
  describe('buildPayload', () => {
    test('produces a payload with the requested byte length when target size is large enough', () => {
      const payload = sentinel.buildPayload(4096, 'probe-test-1');
      expect(Buffer.byteLength(payload, 'utf8')).toBe(4096);
      expect(payload.startsWith('[HM-BUS-SENTINEL] probe=probe-test-1 bytes=4096')).toBe(true);
      expect(payload.endsWith('END:probe-test-1')).toBe(true);
    });

    test('truncates gracefully when requested size is smaller than header+tail', () => {
      const payload = sentinel.buildPayload(20, 'probe-tiny');
      expect(payload.length).toBeLessThanOrEqual(20);
    });

    test('hits all four default boundary sizes exactly', () => {
      for (const size of sentinel.DEFAULT_SIZES) {
        const payload = sentinel.buildPayload(size, `probe-${size}`);
        expect(Buffer.byteLength(payload, 'utf8')).toBe(size);
      }
    });
  });

  describe('parseArgs', () => {
    test('returns defaults when no args provided', () => {
      const args = sentinel.parseArgs([]);
      expect(args.sizes).toEqual(sentinel.DEFAULT_SIZES);
      expect(args.targets).toEqual(sentinel.DEFAULT_TARGETS);
      expect(args.dryRun).toBe(false);
    });

    test('parses --sizes as comma-delimited integers', () => {
      const args = sentinel.parseArgs(['--sizes', '100,200,300']);
      expect(args.sizes).toEqual([100, 200, 300]);
    });

    test('parses --targets as comma-delimited lowercase strings', () => {
      const args = sentinel.parseArgs(['--targets', 'Architect,builder,ORACLE']);
      expect(args.targets).toEqual(['architect', 'builder', 'oracle']);
    });

    test('honors --dry-run flag', () => {
      const args = sentinel.parseArgs(['--dry-run']);
      expect(args.dryRun).toBe(true);
    });

    test('falls back to defaults if parsed sizes are empty/invalid', () => {
      const args = sentinel.parseArgs(['--sizes', 'abc,def']);
      expect(args.sizes).toEqual(sentinel.DEFAULT_SIZES);
    });
  });

  describe('buildProbeId', () => {
    test('builds an id containing target and byteLen', () => {
      const id = sentinel.buildProbeId('builder', 4096);
      expect(id).toContain('builder');
      expect(id).toContain('4096');
    });

    test('produces unique ids on repeated calls', () => {
      const a = sentinel.buildProbeId('oracle', 3900);
      const b = sentinel.buildProbeId('oracle', 3900);
      expect(a).not.toBe(b);
    });
  });

  describe('runProbe (dry run)', () => {
    test('produces an expected fingerprint without sending', async () => {
      const result = await sentinel.runProbe('architect', 256, { dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.target).toBe('architect');
      expect(result.byteLen).toBe(256);
      expect(result.expectedFingerprint).toBeDefined();
      expect(result.expectedFingerprint.byteLength).toBe(256);
      expect(typeof result.expectedFingerprint.sha256).toBe('string');
      expect(result.expectedFingerprint.sha256).toHaveLength(64);
    });
  });
});
