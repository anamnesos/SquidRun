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
      profileName: 'main',
      windowKey: 'main',
      includeMainWindow: true,
      focusWindowKey: 'main',
    });
  });

  test('parses standalone Eunbyeol launch flags', () => {
    expect(parseLaunchIntent(['--window=eunbyeol', '--solo-window'])).toEqual({
      profileName: 'main',
      windowKey: 'eunbyeol',
      includeMainWindow: false,
      focusWindowKey: 'eunbyeol',
    });
    expect(parseLaunchIntent(['--eunbyul'])).toEqual({
      profileName: 'main',
      windowKey: 'eunbyeol',
      includeMainWindow: false,
      focusWindowKey: 'eunbyeol',
    });
  });

  test('keeps the main window included when explicitly requested', () => {
    expect(parseLaunchIntent(['--window', 'eunbyeol', '--with-main-window'])).toEqual({
      profileName: 'main',
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
      profileName: 'main',
      windowKey: 'main',
      includeMainWindow: true,
      focusWindowKey: 'main',
    });
  });

  test('parses profile launches independently of the window key', () => {
    expect(parseLaunchIntent(['--profile=eunbyeol'])).toEqual({
      profileName: 'eunbyeol',
      windowKey: 'main',
      includeMainWindow: true,
      focusWindowKey: 'main',
    });
  });
});
