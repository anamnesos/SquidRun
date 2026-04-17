'use strict';

const {
  normalizeLaunchIntent,
  normalizeWindowKey,
  parseLaunchIntent,
} = require('../modules/main/launch-intent');

describe('launch-intent', () => {
  test('normalizes [private-profile] aliases to the dedicated window key', () => {
    expect(normalizeWindowKey('private-profile')).toBe('private-profile');
    expect(normalizeWindowKey('private-profile')).toBe('private-profile');
    expect(normalizeWindowKey('은별')).toBe('private-profile');
  });

  test('defaults to the main window intent', () => {
    expect(parseLaunchIntent([])).toEqual({
      windowKey: 'main',
      includeMainWindow: true,
      focusWindowKey: 'main',
    });
  });

  test('parses standalone [private-profile] launch flags', () => {
    expect(parseLaunchIntent(['--window=private-profile', '--solo-window'])).toEqual({
      windowKey: 'private-profile',
      includeMainWindow: false,
      focusWindowKey: 'private-profile',
    });
    expect(parseLaunchIntent(['--private-profile'])).toEqual({
      windowKey: 'private-profile',
      includeMainWindow: false,
      focusWindowKey: 'private-profile',
    });
  });

  test('keeps the main window included when explicitly requested', () => {
    expect(parseLaunchIntent(['--window', 'private-profile', '--with-main-window'])).toEqual({
      windowKey: 'private-profile',
      includeMainWindow: true,
      focusWindowKey: 'private-profile',
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
