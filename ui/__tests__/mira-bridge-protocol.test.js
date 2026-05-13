'use strict';

const fs = require('fs');
const path = require('path');

describe('Mira SquidRun adapter protocol', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const protocolPath = path.join(repoRoot, 'mira', 'bridge', 'squidrun-adapter-protocol-v0.md');

  test('defines the bridge-only contract without taking over Telegram or UI', () => {
    const protocol = fs.readFileSync(protocolPath, 'utf8');

    expect(protocol).toContain('GET /bridge/health');
    expect(protocol).toContain('GET /bridge/capabilities');
    expect(protocol).toContain('GET /bridge/session-context');
    expect(protocol).toContain('POST /bridge/pane-messages');
    expect(protocol).toContain('GET /bridge/pane-messages?since=<cursor>');
    expect(protocol).toContain('"telegram_route_control": false');
    expect(protocol).toContain('"ui_surface_control": false');
    expect(protocol).toContain('No Telegram route work.');
    expect(protocol).toContain('No UI product surface.');
    expect(protocol).toContain('No live state copy or deletion.');
  });

  test('keeps adapter implementation inventory read-only for this milestone', () => {
    const protocol = fs.readFileSync(protocolPath, 'utf8');

    expect(protocol).toContain('## Read-Only SquidRun Adapter Inventory');
    expect(protocol).toContain('ui/scripts/hm-send.js');
    expect(protocol).toContain('ui/scripts/hm-comms.js');
    expect(protocol).toContain('ui/modules/main/squidrun-app.js');
    expect(protocol).toContain('ui/modules/ipc/mira-lab-handlers.js');
  });
});
