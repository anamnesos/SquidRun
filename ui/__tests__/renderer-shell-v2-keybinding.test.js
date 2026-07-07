'use strict';

const fs = require('fs');
const path = require('path');

describe('renderer Shell V2 keybinding ownership guard', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

  test('old Ctrl+number pane focus handler is inert when Shell V2 is enabled', () => {
    const guardIndex = source.indexOf("document.body?.classList?.contains('shell-v2-enabled')");
    const focusIndex = source.indexOf('terminal.focusPane(e.key);', guardIndex);

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(focusIndex).toBeGreaterThan(guardIndex);
    expect(source.slice(guardIndex, focusIndex)).toContain('return;');
  });
});
