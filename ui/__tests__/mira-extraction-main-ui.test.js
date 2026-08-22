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

  test('standalone Mira Lab chrome and commands are gone while the main conversation entrypoint remains', () => {
    const html = fs.readFileSync(path.join(uiRoot, 'index.html'), 'utf8');
    jest.resetModules();
    jest.doMock('../modules/logger', () => ({ info: jest.fn() }));
    jest.doMock('../modules/terminal', () => ({ focusPane: jest.fn() }));
    const { getCommandPaletteCommands } = require('../modules/command-palette');

    expect(html).not.toContain('id="openMiraLabBtn"');
    expect(html).toContain('id="broadcastInput"');
    expect(html).toContain('id="miraLiveReply"');
    expect(getCommandPaletteCommands().map((entry) => entry.id)).not.toContain('open-mira-lab');
  });
});
