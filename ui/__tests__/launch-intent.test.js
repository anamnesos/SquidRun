'use strict';

const {
  normalizeLaunchIntent,
  normalizeWindowKey,
  parseLaunchIntent,
} = require('../modules/main/launch-intent');

describe('launch-intent', () => {
  test('normalizes Scoped aliases to the dedicated window key', () => {
    expect(normalizeWindowKey('scoped')).toBe('scoped');
    expect(normalizeWindowKey('scoped')).toBe('scoped');
    expect(normalizeWindowKey('Scoped')).toBe('scoped');
  });

  test('defaults to the main window intent', () => {
    expect(parseLaunchIntent([])).toEqual({
      profileName: 'main',
      windowKey: 'main',
      includeMainWindow: true,
      focusWindowKey: 'main',
    });
  });

  test('parses standalone Scoped launch flags', () => {
    expect(parseLaunchIntent(['--window=scoped', '--solo-window'])).toEqual({
      profileName: 'scoped',
      windowKey: 'scoped',
      includeMainWindow: false,
      focusWindowKey: 'scoped',
    });
    expect(parseLaunchIntent(['--scoped'])).toEqual({
      profileName: 'scoped',
      windowKey: 'scoped',
      includeMainWindow: false,
      focusWindowKey: 'scoped',
    });
  });

  test('keeps the main window included when explicitly requested', () => {
    expect(parseLaunchIntent(['--window', 'scoped', '--with-main-window'])).toEqual({
      profileName: 'scoped',
      windowKey: 'scoped',
      includeMainWindow: true,
      focusWindowKey: 'scoped',
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

  test('routes profile-only Scoped launches to the standalone Scoped window', () => {
    expect(parseLaunchIntent(['--profile=scoped'])).toEqual({
      profileName: 'scoped',
      windowKey: 'scoped',
      includeMainWindow: false,
      focusWindowKey: 'scoped',
    });
  });

  test('lets profile-only Scoped launches include main when explicitly requested', () => {
    expect(parseLaunchIntent(['--profile=scoped', '--with-main-window'])).toEqual({
      profileName: 'scoped',
      windowKey: 'scoped',
      includeMainWindow: true,
      focusWindowKey: 'scoped',
    });
  });

  test('allows an explicit profile to override an Scoped window launch', () => {
    expect(parseLaunchIntent(['--profile=main', '--window=scoped', '--solo-window'])).toEqual({
      profileName: 'main',
      windowKey: 'scoped',
      includeMainWindow: false,
      focusWindowKey: 'scoped',
    });
  });
});
