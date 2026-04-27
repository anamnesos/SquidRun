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
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      includeMainWindow: false,
      focusWindowKey: 'eunbyeol',
    });
    expect(parseLaunchIntent(['--eunbyul'])).toEqual({
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      includeMainWindow: false,
      focusWindowKey: 'eunbyeol',
    });
  });

  test('keeps the main window included when explicitly requested', () => {
    expect(parseLaunchIntent(['--window', 'eunbyeol', '--with-main-window'])).toEqual({
      profileName: 'eunbyeol',
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

  test('routes profile-only Eunbyeol launches to the standalone Eunbyeol window', () => {
    expect(parseLaunchIntent(['--profile=eunbyeol'])).toEqual({
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      includeMainWindow: false,
      focusWindowKey: 'eunbyeol',
    });
  });

  test('lets profile-only Eunbyeol launches include main when explicitly requested', () => {
    expect(parseLaunchIntent(['--profile=eunbyeol', '--with-main-window'])).toEqual({
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      includeMainWindow: true,
      focusWindowKey: 'eunbyeol',
    });
  });

  test('allows an explicit profile to override an Eunbyeol window launch', () => {
    expect(parseLaunchIntent(['--profile=main', '--window=eunbyeol', '--solo-window'])).toEqual({
      profileName: 'main',
      windowKey: 'eunbyeol',
      includeMainWindow: false,
      focusWindowKey: 'eunbyeol',
    });
  });
});
