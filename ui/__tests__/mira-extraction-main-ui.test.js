'use strict';

const fs = require('fs');
const path = require('path');

describe('Mira extraction main UI boundary', () => {
  const uiRoot = path.resolve(__dirname, '..');

  test('main SquidRun right panel no longer mounts a primary Mira tab', () => {
    const html = fs.readFileSync(path.join(uiRoot, 'index.html'), 'utf8');

    expect(html).not.toMatch(/class="panel-tab"[^>]*data-tab="mira"/);
    expect(html).not.toContain('id="tab-mira"');
    expect(html).not.toContain('id="miraLocalTextPanel"');
  });

  test('Mira Lab remains reachable through the standalone window opener', () => {
    const html = fs.readFileSync(path.join(uiRoot, 'index.html'), 'utf8');
    const openAppWindow = jest.fn();
    jest.resetModules();
    jest.doMock('../modules/logger', () => ({ info: jest.fn() }));
    jest.doMock('../modules/terminal', () => ({ focusPane: jest.fn() }));
    const { getCommandPaletteCommands } = require('../modules/command-palette');

    const miraLabCommand = getCommandPaletteCommands({ openAppWindow })
      .find((entry) => entry.id === 'open-mira-lab');

    expect(html).toContain('id="openMiraLabBtn"');
    expect(html).toContain("'open-app-window','mira-lab'");
    expect(miraLabCommand).toEqual(expect.objectContaining({
      label: 'Open Mira Lab',
      category: 'Windows',
    }));

    miraLabCommand.action();
    expect(openAppWindow).toHaveBeenCalledWith('mira-lab');
  });
});
