'use strict';

const fs = require('fs');
const path = require('path');

describe('TrustQuote main UI entry points', () => {
  const uiRoot = path.resolve(__dirname, '..');

  test('TrustQuote work-room opener is absent from the main header', () => {
    const html = fs.readFileSync(path.join(uiRoot, 'index.html'), 'utf8');

    expect(html).not.toContain(`id="${['open', 'TrustQuote', 'Workspace', 'Btn'].join('')}"`);
    expect(html).not.toContain(`windowKey:'${'trust' + 'quote'}',profileName:'${'trust' + 'quote'}'`);
  });

  test('Squid Room has an explicit surface opener in the header', () => {
    const html = fs.readFileSync(path.join(uiRoot, 'index.html'), 'utf8');

    expect(html).toContain('id="openSquidRoomBtn"');
    expect(html).toContain("windowKey:'squid-room',profileName:'main',windowTeam:'squid-room',autoBootAgents:false,displayOnly:true,skipStartupBundle:true");
  });
});
