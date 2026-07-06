'use strict';

const fs = require('fs');
const path = require('path');

describe('UI design wave contracts', () => {
  const uiRoot = path.resolve(__dirname, '..');
  const read = (...segments) => fs.readFileSync(path.join(uiRoot, ...segments), 'utf8');

  test('boot splash uses only self-contained and existing assets', () => {
    const html = read('index.html');
    const baseCss = read('styles', 'base.css');

    expect(html).toContain('assets/squidrun-favicon.ico');
    expect(html).not.toContain('squidrun-favicon-32.png');
    expect(html).not.toContain('squidrun-favicon-16.png');
    expect(html).not.toContain('assets/squidrun-logo.png');
    expect(html).toContain('<svg class="startup-loading-logo"');
    expect(baseCss).toContain('0 0 0 200vmax rgba(5, 8, 14, 0.78)');
    expect(baseCss).toContain('.startup-loading-overlay.error');
  });

  test('startup splash has a renderer-local stall watchdog', () => {
    const renderer = read('renderer.js');

    expect(renderer).toContain('const STARTUP_OVERLAY_STALL_WATCHDOG_MS = 45000;');
    expect(renderer).toContain('startupOverlayLastPercent > STARTUP_OVERLAY_INITIAL_PERCENT');
    expect(renderer).toContain('startupOverlayStalled = true;');
    expect(renderer).toContain('if (startupOverlayResolved || startupOverlayStalled) return;');
    expect(renderer).toContain('The window bridge never reported ready');
    expect(renderer).toContain('hideSpinner: true');
  });

  test('status colors map to semantic state tokens', () => {
    const layoutCss = read('styles', 'layout.css');
    const statusStripCss = read('styles', 'status-strip.css');
    const panesCss = read('styles', 'panes.css');

    expect(layoutCss).toMatch(/\.command-delivery-status\.delivered\s*{\s*color: var\(--color-success\);/);
    expect(layoutCss).toMatch(/\.command-delivery-status\.failed\s*{\s*color: var\(--color-error\);/);
    expect(layoutCss).toMatch(/\.sync-chip\.synced\s*{\s*border-color: var\(--color-success\);\s*color: var\(--color-success\);/);
    expect(statusStripCss).toMatch(/\.status-segment\.done:hover\s*{\s*background: rgba\(0, 230, 118, 0\.15\);/);
    expect(statusStripCss).toMatch(/\.status-segment\.running:hover\s*{\s*background: rgba\(0, 240, 255, 0\.15\);/);
    expect(`${layoutCss}\n${panesCss}`).not.toContain('var(--color-accent, #00f0ff)');
  });

  test('sync chips expose legible tooltip labels without changing status classes', () => {
    const layoutCss = read('styles', 'layout.css');
    const uiView = read('modules', 'ui-view.js');

    expect(layoutCss).toMatch(/\.sync-label\s*{[^}]*font-size: var\(--text-xs\);/s);
    expect(layoutCss).toMatch(/\.sync-chip\s*{[^}]*font-size: var\(--text-xs\);/s);
    expect(uiView).toContain("label.dataset.tooltip = 'Context sync status';");
    expect(uiView).toContain("chip.dataset.tooltip = `${file} not synced`;");
    expect(uiView).toContain("chip.setAttribute('aria-label', tooltip);");
  });

  test('hidden pane host terminals share the visible terminal legibility floor', () => {
    const paneHost = read('pane-host-renderer.js');

    expect(paneHost).toContain("'Cascadia Code', 'Consolas', 'Monaco', monospace");
    expect(paneHost).toContain('lineHeight: 1.25');
    expect(paneHost).toContain('letterSpacing: 0');
    expect(paneHost).toContain('minimumContrastRatio: 4.5');
    expect(paneHost).toContain('fontWeightBold: 600');
    expect(paneHost).toContain("brightBlack: '#5c6a80'");
  });

  test('preload installs the local script shebang loader before importing script-backed APIs', () => {
    const preload = read('preload.js');

    expect(preload.indexOf('installLocalScriptShebangLoader();')).toBeGreaterThan(-1);
    expect(preload.indexOf('installLocalScriptShebangLoader();')).toBeLessThan(
      preload.indexOf("require('./modules/bridge/preload-api')")
    );
  });
});
