jest.mock('../modules/renderer-bridge', () => ({
  invokeBridge: jest.fn(),
}));

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../modules/terminal', () => ({
  setPaneRuntimeOverride: jest.fn(),
  getPaneRuntimeOverride: jest.fn(),
  restartPane: jest.fn(),
}));

jest.mock('../modules/settings', () => ({
  refreshSettingsFromMain: jest.fn(),
}));

jest.mock('../modules/notifications', () => ({
  showStatusNotice: jest.fn(),
}));

jest.mock('../modules/renderer-ipc-registry', () => ({
  registerScopedIpcListener: jest.fn(),
}));

const { _internals } = require('../modules/model-selector');

describe('model-selector owner assertions', () => {
  afterEach(() => {
    delete global.document;
  });

  function setRendererScope(scope = {}) {
    global.document = {
      body: {
        dataset: {
          windowKey: scope.windowKey || 'main',
          profileName: scope.profileName || 'main',
          sessionScopeId: scope.sessionScopeId || '',
        },
      },
    };
  }

  test('accepts a matching owner instance assertion', () => {
    setRendererScope({
      windowKey: 'sideprofile',
      profileName: 'sideprofile',
      sessionScopeId: 'app-session-428:sideprofile',
    });

    expect(_internals.isOwnerAssertionMatch({
      ownerInstance: {
        windowKey: 'sideprofile',
        profileName: 'sideprofile',
        sessionScopeId: 'app-session-428:sideprofile',
      },
    })).toBe(true);
  });

  test('rejects a colliding pane id sent to the wrong profile instance', () => {
    setRendererScope({
      windowKey: 'main',
      profileName: 'main',
      sessionScopeId: 'app-session-428',
    });

    expect(_internals.isOwnerAssertionMatch({
      ownerInstance: {
        windowKey: 'sideprofile',
        profileName: 'sideprofile',
        sessionScopeId: 'app-session-428:sideprofile',
      },
    })).toBe(false);
  });

  test('rejects a matching window key with the wrong session scope', () => {
    setRendererScope({
      windowKey: 'sideprofile',
      profileName: 'sideprofile',
      sessionScopeId: 'app-session-999:sideprofile',
    });

    expect(_internals.isOwnerAssertionMatch({
      ownerWindowKey: 'sideprofile',
      ownerProfileName: 'sideprofile',
      ownerSessionScopeId: 'app-session-428:sideprofile',
    })).toBe(false);
  });
});
