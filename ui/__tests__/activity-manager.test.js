/* global beforeEach, describe, expect, it, jest */

jest.mock('../config', () => require('./helpers/mock-config').mockDefaultConfig);

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const ActivityManager = require('../modules/main/activity-manager');

function createContext() {
  return {
    mainWindow: {
      isDestroyed: jest.fn().mockReturnValue(false),
      webContents: {
        send: jest.fn(),
      },
    },
    pluginManager: {
      hasHook: jest.fn().mockReturnValue(false),
      dispatch: jest.fn(),
    },
  };
}

describe('ActivityManager', () => {
  let ctx;
  let manager;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx = createContext();
    manager = new ActivityManager(ctx);
  });

  it('records ordinary error activity in the renderer activity stream', () => {
    manager.logActivity('error', '2', 'Build failed', {
      snippet: 'Typecheck failed',
    });

    expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith(
      'activity-logged',
      expect.objectContaining({
        type: 'error',
        paneId: '2',
        message: 'Build failed',
      })
    );
  });

  it('keeps agent response debt in activity without creating user-facing homework', () => {
    manager.logActivity('error', '1', 'TELEGRAM REPLY REQUIREMENT UNRESOLVED Pane 1 still owes Telegram egress.', {
      source: 'telegram-reply-requirement',
      debtKind: 'telegram_reply_required',
      agentSideOnly: true,
      requiresTelegramEgress: true,
    });

    expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith(
      'activity-logged',
      expect.objectContaining({
        type: 'error',
        paneId: '1',
        message: expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
      })
    );
  });
});
