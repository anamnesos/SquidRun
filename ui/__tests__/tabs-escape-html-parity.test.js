'use strict';

/**
 * S468 weaker-duplicate hunt: tabs/utils escapeHtml was the quote-blind DOM
 * twin of the strong 5-entity escaper used everywhere else. This contract
 * pins attribute-safety (the exact failure mode: title="${escapeHtml(x)}")
 * and parity with the strong copies.
 */
const { escapeHtml } = require('../modules/tabs/utils');

test('quotes are escaped — attribute interpolation cannot break out', () => {
  expect(escapeHtml('a"b')).toBe('a&quot;b');
  expect(escapeHtml("a'b")).toBe('a&#39;b');
  expect(escapeHtml('<img src=x onerror="p()">')).toBe('&lt;img src=x onerror=&quot;p()&quot;&gt;');
});

test('parity with the strong twin (squid-room-surface copy) on a torture string', () => {
  const surfaceSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'modules', 'squid-room-surface.js'), 'utf8');
  const strong = new Function(surfaceSrc.match(/function escapeHtml[\s\S]*?\n}/)[0] + '; return escapeHtml;')();
  const torture = `&<>"'" mixed & "quoted" <tags> it's`;
  expect(escapeHtml(torture)).toBe(strong(torture));
});

test('non-strings coerce instead of vanishing', () => {
  expect(escapeHtml(42)).toBe('42');
  expect(escapeHtml(null)).toBe('');
  expect(escapeHtml(undefined)).toBe('');
});
