'use strict';

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
}));

jest.mock('../modules/terminal', () => ({
  focusPane: jest.fn(),
  spawnAllAgents: jest.fn(),
}));

const {
  getCommandPaletteCommands,
  getPaneControlCommands,
  smokeCommandPaletteCommands,
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

  test('adds pane commands for Builder and Oracle controls and resolves their targets', () => {
    const clicked = new Set();
    const targets = new Map();
    const commands = getPaneControlCommands();
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
        'pane-builder-interrupt',
        'pane-builder-restart',
        'pane-builder-fresh-session',
        'pane-builder-lock',
        'pane-builder-role-info',
        'pane-builder-health',
        'pane-oracle-interrupt',
        'pane-oracle-restart',
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

  test('command registry resolves every surviving command target', () => {
    const openAppWindow = jest.fn();
    const selectorTargets = new Map();
    const commands = getCommandPaletteCommands({ openAppWindow });
    for (const command of commands) {
      if (command.targetSelector) {
        selectorTargets.set(command.targetSelector, {
          click: jest.fn(),
          focus: jest.fn(),
        });
      }
    }
    const previousDocument = global.document;
    global.document = {
      querySelector: jest.fn((selector) => selectorTargets.get(selector) || null),
      getElementById: jest.fn((id) => selectorTargets.get(`#${id}`) || null),
    };

    try {
      const smoke = smokeCommandPaletteCommands(commands, { openAppWindow });
      expect(smoke).toHaveLength(commands.length);
      expect(smoke.every((entry) => entry.ok)).toBe(true);
      expect(commands.map((command) => command.id)).not.toContain('open-mira-lab');
      expect(commands.map((command) => command.id)).not.toEqual(expect.arrayContaining([
        'shell-v2-open-settings',
        'shell-v2-screenshots-gallery',
      ]));
    } finally {
      global.document = previousDocument;
    }
  });
});
