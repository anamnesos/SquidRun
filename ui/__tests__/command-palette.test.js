'use strict';

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
}));

jest.mock('../modules/terminal', () => ({
  focusPane: jest.fn(),
}));

const { getCommandPaletteCommands } = require('../modules/command-palette');

describe('command-palette', () => {
  test('includes the Scoped window command and routes it to the window opener', () => {
    const openAppWindow = jest.fn();
    const commands = getCommandPaletteCommands({ openAppWindow });
    const scopedCommand = commands.find((entry) => entry.id === 'open-scoped-window');

    expect(scopedCommand).toEqual(expect.objectContaining({
      label: 'Open Scoped Window',
      category: 'Windows',
    }));
    scopedCommand.action();
    expect(openAppWindow).toHaveBeenCalledWith('scoped');
  });

  test('labels pane 1 navigation with Mira without changing the pane target', () => {
    const terminal = require('../modules/terminal');
    const commands = getCommandPaletteCommands();
    const focusMiraCommand = commands.find((entry) => entry.id === 'focus-1');

    expect(focusMiraCommand).toEqual(expect.objectContaining({
      label: 'Focus Mira (Pane 1)',
      category: 'Navigate',
    }));
    focusMiraCommand.action();
    expect(terminal.focusPane).toHaveBeenCalledWith('1');
  });
});
