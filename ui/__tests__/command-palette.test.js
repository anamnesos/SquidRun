'use strict';

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
}));

jest.mock('../modules/terminal', () => ({
  focusPane: jest.fn(),
}));

const { getCommandPaletteCommands } = require('../modules/command-palette');

describe('command-palette', () => {
  test('includes the [private-profile] window command and routes it to the window opener', () => {
    const openAppWindow = jest.fn();
    const commands = getCommandPaletteCommands({ openAppWindow });
    const private-profileCommand = commands.find((entry) => entry.id === 'open-private-profile-window');

    expect(private-profileCommand).toEqual(expect.objectContaining({
      label: 'Open [private-profile] Window',
      category: 'Windows',
    }));
    private-profileCommand.action();
    expect(openAppWindow).toHaveBeenCalledWith('private-profile');
  });
});
