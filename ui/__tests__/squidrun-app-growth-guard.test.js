'use strict';

const fs = require('fs');
const path = require('path');

/**
 * God-object reduction ratchet (task #7).
 *
 * squidrun-app.js is the main-process controller and has grown into a
 * ~16k-line god-object. RATCHET_CEILING records the 0.1.34 public baseline and may
 * only go DOWN. When you touch this file, carve a cohesive cluster into its
 * own module (see squidrun-root-paths.js for the reference extraction) and
 * lower the ratchet to the exact new line count. This baseline was reset once
 * when the public source snapshot absorbed the restart and Team Room work.
 *
 * TARGET_CEILING preserves the original 14,662-line goal. It is immutable debt
 * evidence, not a number to bump when the ratchet is inconvenient. Never raise
 * either number to make red go green.
 */
const RATCHET_CEILING = 16378;
const TARGET_CEILING = 14662;

describe('squidrun-app.js god-object growth guard', () => {
  const filePath = path.join(__dirname, '..', 'modules', 'main', 'squidrun-app.js');

  it('matches the current one-way ratchet exactly (extract, then lower it)', () => {
    const lineCount = fs.readFileSync(filePath, 'utf8').split('\n').length;
    expect(lineCount).toBe(RATCHET_CEILING);
  });

  it('keeps the original debt target immutable', () => {
    expect(TARGET_CEILING).toBe(14662);
  });
});
