'use strict';

const {
  normalizeLaunchIntent,
  normalizeWindowKey,
  parseLaunchIntent,
} = require('../modules/main/launch-intent');

describe('launch-intent', () => {
  test('normalizes Eunbyeol aliases to the dedicated window key', () => {
    expect(normalizeWindowKey('eunbyul')).toBe('eunbyeol');
    expect(normalizeWindowKey('eunbyeol')).toBe('eunbyeol');
    expect(normalizeWindowKey('은별')).toBe('eunbyeol');
  });

  test('defaults to the main window intent', () => {
    expect(parseLaunchIntent([])).toEqual({
      windowKey: 'main',
      includeMainWindow: true,
      focusWindowKey: 'main',
    });
  });

  test('parses standalone Eunbyeol launch flags', () => {
    expect(parseLaunchIntent(['--window=eunbyeol', '--solo-window'])).toEqual({
      windowKey: 'eunbyeol',
      includeMainWindow: false,
      focusWindowKey: 'eunbyeol',
    });
    expect(parseLaunchIntent(['--eunbyul'])).toEqual({
      windowKey: 'eunbyeol',
      includeMainWindow: false,
      focusWindowKey: 'eunbyeol',
    });
  });

  test('keeps the main window included when explicitly requested', () => {
    expect(parseLaunchIntent(['--window', 'eunbyeol', '--with-main-window'])).toEqual({
      windowKey: 'eunbyeol',
      includeMainWindow: true,
      focusWindowKey: 'eunbyeol',
    });
  });

  test('forces main launches to include the main window', () => {
    expect(normalizeLaunchIntent({
      windowKey: 'main',
      includeMainWindow: false,
    })).toEqual({
      windowKey: 'main',
      includeMainWindow: true,
      focusWindowKey: 'main',
    });
  });
});
