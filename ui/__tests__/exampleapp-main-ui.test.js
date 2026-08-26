'use strict';

const fs = require('fs');
const path = require('path');

describe('ExampleApp main UI entry points', () => {
  const uiRoot = path.resolve(__dirname, '..');

  test('ExampleApp work-room opener is absent from the main header', () => {
    const html = fs.readFileSync(path.join(uiRoot, 'index.html'), 'utf8');

    expect(html).not.toContain(`id="${['open', 'ExampleApp', 'Workspace', 'Btn'].join('')}"`);
    expect(html).not.toContain(`windowKey:'${'trust' + 'quote'}',profileName:'${'trust' + 'quote'}'`);
  });

  test('Squid Room is hidden from the header while its parked arm surface remains importable', () => {
    const html = fs.readFileSync(path.join(uiRoot, 'index.html'), 'utf8');
    const squidRoomSurface = require('../modules/squid-room-surface');

    expect(html).not.toContain('id="openSquidRoomBtn"');
    expect(squidRoomSurface).toEqual(expect.objectContaining({
      initSquidRoomSurface: expect.any(Function),
      buildSquidRoomModel: expect.any(Function),
    }));
  });
});
