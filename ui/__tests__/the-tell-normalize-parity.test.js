'use strict';

/**
 * PARITY LAW (tell-sensors-v2): ui/modules/the-tell/normalize-job-type.js is
 * an upstream TypeScript normalizer. A clean public checkout has no sibling
 * application source, so cross-repository parity is opt-in through
 * SQUIDRUN_JOB_TYPE_NORMALIZER_SOURCE. Local behavior fixtures always run.
 */

const fs = require('fs');
const path = require('path');

const TS_PATH = process.env.SQUIDRUN_JOB_TYPE_NORMALIZER_SOURCE || '';
const PORT_PATH = path.join(__dirname, '..', 'modules', 'the-tell', 'normalize-job-type.js');

function transformTsToJs(ts) {
  return ts
    .replace(/export const CANONICAL_JOB_TYPES: readonly string\[\] =/, 'const CANONICAL_JOB_TYPES =')
    .replace(/const JOB_TYPE_SYNONYMS: Readonly<Record<string, string>> =/, 'const JOB_TYPE_SYNONYMS =')
    .replace(/const JOB_TYPE_RULES: ReadonlyArray<\{[\s\S]*?\}> =/, 'const JOB_TYPE_RULES =')
    .replace(/function normalizePhrase\(raw: string\): string/, 'function normalizePhrase(raw)')
    .replace(/function findCanonicalBucket\(phrase: string\): string \| null/, 'function findCanonicalBucket(phrase)')
    .replace(/function slugifyPhrase\(phrase: string\): string/, 'function slugifyPhrase(phrase)')
    .replace(/export function normalizeJobType\(raw: string \| null \| undefined\): string/, 'function normalizeJobType(raw)')
    .replace(/export function canonicalLabel\(key: string\): string/, 'function canonicalLabel(key)');
}

const tsAvailable = fs.existsSync(TS_PATH);
(tsAvailable ? describe : describe.skip)('the-tell optional upstream normalizer parity', () => {
  test('the committed port is byte-identical to a fresh transform of the TS source', () => {
    const freshBody = transformTsToJs(fs.readFileSync(TS_PATH, 'utf8'));
    const committed = fs.readFileSync(PORT_PATH, 'utf8');
    // the committed file = header + transformed body + exports line
    expect(committed).toContain(freshBody.trim());
  });

});

describe('the-tell local normalizer behavior', () => {
  test('groups representative job types consistently', () => {
    const { normalizeJobType } = require('../modules/the-tell/normalize-job-type');
    // real values from the S467 live probe (10 perpetual drafts)
    expect(normalizeJobType('Whole Home Water Repipe (2 Bath)')).toBe('repipe');
    expect(normalizeJobType('Water Re-pipe Unit 1125')).toBe('repipe');
    expect(normalizeJobType('Tankless Water Heater Repair')).toBe('water_heater');
    expect(normalizeJobType('Sewer Line Replacement')).toBe('sewer');
    expect(normalizeJobType('Trenchless Sewer Main Replacement')).toBe('sewer');
    expect(normalizeJobType('Toilet Replacement')).toBe('toilet');
    // unknown stays an honest slug, never invented into a family
    expect(normalizeJobType('Crawlspace Water Pipe Strapping')).toBe('crawlspace_water_pipe_strapping');
  });
});
