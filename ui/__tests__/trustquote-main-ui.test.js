'use strict';

const fs = require('fs');
const path = require('path');

describe('TrustQuote main UI entry points', () => {
  const uiRoot = path.resolve(__dirname, '..');

  test('TrustQuote workspace remains reachable through a visible no-duplicate-agent opener', () => {
    const html = fs.readFileSync(path.join(uiRoot, 'index.html'), 'utf8');

    expect(html).toContain('id="openTrustQuoteWorkspaceBtn"');
    expect(html).toContain("'open-app-window',{windowKey:'trustquote',profileName:'trustquote',autoBootAgents:false}");
  });

  test('Squid Room has an explicit surface opener in the header', () => {
    const html = fs.readFileSync(path.join(uiRoot, 'index.html'), 'utf8');

    expect(html).toContain('id="openSquidRoomBtn"');
    expect(html).toContain("windowKey:'squid-room',profileName:'main',windowTeam:'squid-room',autoBootAgents:false,displayOnly:true,skipStartupBundle:true");
  });
});
