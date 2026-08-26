'use strict';

const { verifyAppWindowVisible } = require('../modules/main/app-window-visibility');

function verify(windowRef, overrides = {}) {
  return verifyAppWindowVisible({
    rawWindowKey: 'team-room',
    expectedTitle: 'SquidRun Team Room',
    getAppWindow: () => windowRef,
    canSendToWindow: (candidate) => Boolean(candidate),
    ...overrides,
  });
}

describe('app window visibility proof', () => {
  test('fails when the requested window is not registered', () => {
    expect(verify(null)).toEqual({
      ok: false,
      windowKey: 'team-room',
      reason: 'team-room_window_not_registered',
    });
  });

  test('fails when a registered window is hidden', () => {
    expect(verify({ isVisible: () => false })).toEqual({
      ok: false,
      windowKey: 'team-room',
      reason: 'team-room_window_not_visible',
      visible: false,
    });
  });

  test('fails on a conflicting non-empty title', () => {
    expect(verify({ isVisible: () => true, getTitle: () => 'Wrong Room' })).toEqual({
      ok: false,
      windowKey: 'team-room',
      reason: 'team-room_window_title_mismatch',
      expectedTitle: 'SquidRun Team Room',
      title: 'Wrong Room',
      visible: true,
    });
  });

  test('returns visible proof for the expected window', () => {
    expect(verify({ isVisible: () => true, getTitle: () => 'SquidRun Team Room' })).toEqual({
      ok: true,
      windowKey: 'team-room',
      visible: true,
      title: 'SquidRun Team Room',
    });
  });
});
