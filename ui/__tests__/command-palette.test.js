'use strict';

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
}));

jest.mock('../modules/terminal', () => ({
  focusPane: jest.fn(),
}));

const {
  getCommandPaletteCommands,
  getShellV2StationCommands,
} = require('../modules/command-palette');

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

  test('includes the Mira Lab window command and routes it to the window opener', () => {
    const openAppWindow = jest.fn();
    const commands = getCommandPaletteCommands({ openAppWindow });
    const miraLabCommand = commands.find((entry) => entry.id === 'open-mira-lab');

    expect(miraLabCommand).toEqual(expect.objectContaining({
      label: 'Open Mira Lab',
      category: 'Windows',
    }));
    miraLabCommand.action();
    expect(openAppWindow).toHaveBeenCalledWith('mira-lab');
  });

  test('includes the Task Audit sidecar command and routes it to the window opener', () => {
    const openAppWindow = jest.fn();
    const commands = getCommandPaletteCommands({ openAppWindow });
    const sidecarCommand = commands.find((entry) => entry.id === 'open-live-task-audit-sidecar');

    expect(sidecarCommand).toEqual(expect.objectContaining({
      label: 'Open Task Audit',
      category: 'Windows',
    }));
    sidecarCommand.action();
    expect(openAppWindow).toHaveBeenCalledWith('live-task-audit-sidecar');
  });

  test('includes the Squid Room command and routes it to the explicit window opener', () => {
    const openAppWindow = jest.fn();
    const commands = getCommandPaletteCommands({ openAppWindow });
    const squidRoomCommand = commands.find((entry) => entry.id === 'open-squid-room');

    expect(squidRoomCommand).toEqual(expect.objectContaining({
      label: 'Open Squid Room',
      category: 'Windows',
    }));
    squidRoomCommand.action();
    expect(openAppWindow).toHaveBeenCalledWith('squid-room');
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

  test('adds Shell V2 station commands for moved header controls and resolves their targets', () => {
    const clicked = new Set();
    const targets = new Map();
    const commands = getShellV2StationCommands();
    for (const command of commands) {
      targets.set(command.targetSelector, {
        click: jest.fn(() => clicked.add(command.targetSelector)),
      });
    }
    const previousDocument = global.document;
    global.document = {
      querySelector: jest.fn((selector) => targets.get(selector) || null),
    };

    try {
      expect(commands).toHaveLength(12);
      expect(commands.map((command) => command.id)).toEqual(expect.arrayContaining([
        'shell-v2-builder-interrupt',
        'shell-v2-builder-restart',
        'shell-v2-builder-fresh-session',
        'shell-v2-builder-lock',
        'shell-v2-builder-role-info',
        'shell-v2-builder-health',
        'shell-v2-oracle-interrupt',
        'shell-v2-oracle-restart',
      ]));

      for (const command of commands) {
        expect(command.targetSelector).toBeTruthy();
        expect(command.action()).toBe(true);
        expect(clicked.has(command.targetSelector)).toBe(true);
      }
    } finally {
      global.document = previousDocument;
    }
  });
});
