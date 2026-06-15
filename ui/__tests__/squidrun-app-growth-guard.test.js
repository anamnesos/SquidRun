'use strict';

const fs = require('fs');
const path = require('path');

/**
 * God-object growth freeze (task #7).
 *
 * squidrun-app.js is the main-process controller and has grown into a
 * ~15k-line god-object. This guard freezes its size: the line count may only
 * go DOWN. When you touch this file, carve a cohesive cluster into its own
 * module (see squidrun-root-paths.js for the reference extraction) and LOWER
 * the ceiling below. The ratchet is one-directional on purpose - it converts
 * "the file keeps growing" from an invisible drift into a deliberate, visible
 * decision.
 *
 * If a change legitimately must add lines, offset it by extracting at least as
 * many, or - as a last resort with justification in the PR - raise CEILING.
 * Never silently bump it to make red go green.
 */
const CEILING = 14863;

describe('squidrun-app.js god-object growth guard', () => {
  const filePath = path.join(__dirname, '..', 'modules', 'main', 'squidrun-app.js');

  it('does not grow past the frozen ceiling (extract, do not add)', () => {
    const lineCount = fs.readFileSync(filePath, 'utf8').split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(CEILING);
  });

  it('keeps the ceiling honest - lower it when the file shrinks', () => {
    // If this fails, the file got smaller (good!): drop CEILING to the new
    // count so the win is locked in and can't silently be given back.
    const lineCount = fs.readFileSync(filePath, 'utf8').split('\n').length;
    expect(CEILING - lineCount).toBeLessThanOrEqual(150);
  });
});
