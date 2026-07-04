'use strict';

/**
 * S468 weaker-duplicate hunt: the renderer's face pipeline now delegates to
 * this package-backed strip. These contracts pin the STRENGTH the hand-rolled
 * CSI-only regex lacked — the exact sequences CLI output emits.
 */
const { stripAnsi } = require('../modules/ansi');

const ESC = '';
const BEL = '';

test('strips OSC hyperlinks (the sequence the old CSI-only regex leaked)', () => {
  const oscLink = `${ESC}]8;;https://example.com${BEL}click${ESC}]8;;${BEL} done`;
  expect(stripAnsi(oscLink)).toBe('click done');
});

test('strips CSI colors', () => {
  expect(stripAnsi(`${ESC}[31mred${ESC}[0m plain`)).toBe('red plain');
  expect(stripAnsi(`${ESC}[1;32mbold-green${ESC}[m x`)).toBe('bold-green x');
});

test('non-strings coerce safely', () => {
  expect(stripAnsi(null)).toBe('');
  expect(stripAnsi(undefined)).toBe('');
});
