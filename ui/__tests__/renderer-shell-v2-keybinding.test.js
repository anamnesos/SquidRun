'use strict';

const fs = require('fs');
const path = require('path');

describe('renderer Shell V2 keybinding ownership guard', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const shellV2Source = fs.readFileSync(path.join(__dirname, '..', 'modules', 'shell-v2.js'), 'utf8');

  test('old Ctrl+number pane focus handler is inert when Shell V2 is enabled', () => {
    const guardIndex = source.indexOf("document.body?.classList?.contains('shell-v2-enabled')");
    const focusIndex = source.indexOf('terminal.focusPane(e.key);', guardIndex);

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(focusIndex).toBeGreaterThan(guardIndex);
    expect(source.slice(guardIndex, focusIndex)).toContain('return;');
  });

  test('Shell V2 implements Alt+number pane focus instead of just advertising it', () => {
    expect(shellV2Source).toContain('SHELL_V2_PANE_SHORTCUTS');
    expect(shellV2Source).toContain('function resolveShortcutPane(event)');
    expect(shellV2Source).toContain('event?.altKey');
    expect(shellV2Source).toContain('options.terminal?.focusPane?.(targetPane.paneId)');
  });
});
