'use strict';

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
}));

jest.mock('../modules/terminal', () => ({
  focusPane: jest.fn(),
}));

const { getCommandPaletteCommands } = require('../modules/command-palette');

describe('command-palette', () => {
  test('includes the Eunbyeol window command and routes it to the window opener', () => {
    const openAppWindow = jest.fn();
    const commands = getCommandPaletteCommands({ openAppWindow });
    const eunbyeolCommand = commands.find((entry) => entry.id === 'open-eunbyeol-window');

    expect(eunbyeolCommand).toEqual(expect.objectContaining({
      label: 'Open Eunbyeol Window',
      category: 'Windows',
    }));
    eunbyeolCommand.action();
    expect(openAppWindow).toHaveBeenCalledWith('eunbyeol');
  });
});
