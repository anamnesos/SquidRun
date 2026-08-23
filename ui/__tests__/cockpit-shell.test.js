const fs = require('fs');
const path = require('path');

const UI_ROOT = path.join(__dirname, '..');
const readUi = (relativePath) => fs.readFileSync(path.join(UI_ROOT, relativePath), 'utf8');

describe('main cockpit shell', () => {
  const html = readUi('index.html');
  const css = readUi(path.join('styles', 'cockpit.css'));
  const stateBarCss = readUi(path.join('styles', 'state-bar.css'));
  const uiView = readUi(path.join('modules', 'ui-view.js'));

  test('keeps the established three-pane geometry and gives every pane a quiet control menu', () => {
    expect(html).toContain('class="main-pane-container"');
    expect(html).toContain('class="side-panes-container"');
    expect((html.match(/class="pane-menu"/g) || [])).toHaveLength(3);

    [
      ['Mira', 'Architect'],
      ['Rook', 'Builder'],
      ['Vera', 'Oracle'],
    ].forEach(([name, role]) => {
      expect(html).toContain(`class="pane-name">${name}</span>`);
      expect(html).toContain(`class="pane-role-label">${role}</span>`);
    });

    expect((html.match(/>Start a new conversation<\/button>/g) || [])).toHaveLength(3);
    expect((html.match(/>Restart agent<\/button>/g) || [])).toHaveLength(3);
    expect((html.match(/>Send Enter<\/button>/g) || [])).toHaveLength(3);
  });

  test('keeps the main header focused on workspace, Team Room, preferences, and power', () => {
    expect((html.match(/id="projectPath"/g) || [])).toHaveLength(1);
    expect(html).toContain('id="selectProjectBtn"');
    expect(html).toContain('id="openTeamRoomBtn"');
    expect(html).toContain('id="settingsBtn"');
    expect(html).toContain('id="fullRestartBtn"');

    ['profileBtn', 'todayBtn', 'squidRoomBtn', 'miraLabBtn', 'screenshotsBtn', 'commsBtn']
      .forEach((retiredId) => expect(html).not.toContain(`id="${retiredId}"`));
  });

  test('shows only three human preferences before the collapsed developer drawer', () => {
    const visiblePreferences = html.slice(
      html.indexOf('<div class="preferences-list">'),
      html.indexOf('<details class="developer-settings">')
    );

    expect((visiblePreferences.match(/class="preference-row"/g) || [])).toHaveLength(3);
    expect(visiblePreferences).toContain('data-setting="voiceInputEnabled"');
    expect(visiblePreferences).toContain('data-setting="voiceAutoSend"');
    expect(visiblePreferences).toContain('data-setting="allowAllPermissions"');
    expect(visiblePreferences).toContain('We still stop for money, customers, and things we cannot undo.');
    expect(html).toContain('<details class="developer-settings">');
    expect(html).toContain('id="panelBtn"');
    expect(html).toContain('id="devicePairingDetails"');
    expect(html).toContain('id="pairingInitBtn"');
    expect(html).toContain('id="pairingJoinBtn"');
    expect(html).toContain('id="pairedDevicesTableBody"');
  });

  test('keeps direct pane input and model switching reachable for Rook and Vera', () => {
    for (const paneId of ['2', '3']) {
      expect(html).toContain(`id="terminal-${paneId}"`);
      expect(html).toContain(`id="model-selector-${paneId}"`);
      expect(html).toContain(`id="lock-icon-${paneId}"`);
    }
  });

  test('uses Team Room colors and an actual draggable integrated title region', () => {
    expect(css).toContain('--cockpit-mira: #38d6f0');
    expect(css).toContain('--cockpit-rook: #7ee787');
    expect(css).toContain('--cockpit-vera: #c792ea');
    expect(css).toMatch(/\.header\s*\{[\s\S]*?-webkit-app-region:\s*drag/);
    expect(css).toMatch(/\.header\s+(?:button|select|input)[\s\S]*?-webkit-app-region:\s*no-drag/);
  });

  test('does not pretend coarse process state is live agent activity', () => {
    expect(html).not.toContain('agent-badge');
    expect(css).not.toContain('.agent-badge');
    expect(stateBarCss).not.toContain('.agent-badge');
    expect(uiView).not.toContain('updateAgentStatus');
  });
});
