/**
 * Importing the Telegram CLI as a library must not change the desktop app's
 * process-wide project root. The CLI may bind its cwd when main() runs, but
 * squidrun-app imports sendTelegram/normalizeChatId during startup.
 */
jest.mock('../config', () => ({
  setProjectRoot: jest.fn(),
  resolveCoordPath: jest.fn(() => null),
}));

jest.mock('../modules/main/comms-journal', () => ({
  appendCommsJournalEntry: jest.fn(() => ({ ok: true })),
  claimCommsSend: jest.fn(),
  closeCommsJournalStores: jest.fn(),
}));

jest.mock('../modules/main/telegram-reply-obligations', () => ({
  reconcileTelegramReplyObligationFromJournal: jest.fn(() => ({ ok: true })),
}));

test('library import leaves the active project root untouched', () => {
  const config = require('../config');

  require('../scripts/hm-telegram');

  expect(config.setProjectRoot).not.toHaveBeenCalled();
});
