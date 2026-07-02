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

  test('a sessionScopeId SCHEME mismatch never demotes the true owner (S463 Bug 2)', () => {
    // Exact production values from James's failed pane-2 switch: the owner
    // registry froze the boot fallback (instance scheme) while the renderer
    // carried the canonical session scheme. Ownership must fall back to
    // windowKey + profileName instead of silently skipping the respawn.
    setRendererScope({
      windowKey: 'main',
      profileName: 'main',
      sessionScopeId: 'app-session-463',
    });

    expect(_internals.isOwnerAssertionMatch({
      ownerInstance: {
        windowKey: 'main',
        profileName: 'main',
        sessionScopeId: 'app-5076-1782936074440',
      },
    })).toBe(true);
  });

  test('scheme mismatch still rejects when window identity differs', () => {
    setRendererScope({
      windowKey: 'squid-room',
      profileName: 'main',
      sessionScopeId: 'app-session-463:squid-room',
    });

    expect(_internals.isOwnerAssertionMatch({
      ownerInstance: {
        windowKey: 'main',
        profileName: 'main',
        sessionScopeId: 'app-5076-1782936074440',
      },
    })).toBe(false);
  });

  test('resolves concrete Claude selector values into claudeModel payload fields', () => {
    const select = {
      value: 'claude:fable',
      selectedOptions: [{
        textContent: 'Claude Fable 5',
        dataset: { claudeModel: 'claude-fable-5[1m]' },
      }],
    };

    expect(_internals.resolveSelectedModel(select)).toEqual({
      model: 'claude',
      selectorValue: 'claude:fable',
      claudeModel: 'claude-fable-5',
    });
  });

  test('generic Claude selector value clears the UI-managed claudeModel override', () => {
    expect(_internals.resolveSelectedModel({ value: 'claude', selectedOptions: [] })).toEqual({
      model: 'claude',
      selectorValue: 'claude',
      claudeModel: '',
    });
  });
});
