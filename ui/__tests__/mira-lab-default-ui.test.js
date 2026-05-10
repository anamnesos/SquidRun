'use strict';

const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'mira-lab.html');
const CSS_PATH = path.join(__dirname, '..', 'styles', 'mira-lab.css');
const RENDERER_PATH = path.join(__dirname, '..', 'mira-lab-renderer.js');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

describe('mira-lab default UI is James <-> Mira only (ARCH #14/#16/#17/#18)', () => {
  test('HTML contains no speaker selector, no targets input, no routing block', () => {
    const html = read(HTML_PATH);
    expect(html).not.toMatch(/id="miraLabSpeaker"/);
    expect(html).not.toMatch(/id="miraLabTargets"/);
    expect(html).not.toMatch(/id="miraLabRouting"/);
    expect(html).not.toMatch(/<select\b[^>]*>/i);
    expect(html).not.toMatch(/class="mira-lab-routing"/);
    expect(html).not.toMatch(/class="mira-lab-route"/);
    expect(html).not.toMatch(/class="mira-lab-targets"/);
  });

  test('HTML never mentions Mira-to-agents text or Builder/Oracle as conversation participants', () => {
    const html = read(HTML_PATH);
    expect(html.toLowerCase()).not.toContain('mira to agents');
    expect(html).not.toMatch(/<option\s+value="builder"/i);
    expect(html).not.toMatch(/<option\s+value="oracle"/i);
    expect(html).not.toMatch(/<option\s+value="architect"/i);
    expect(html).not.toMatch(/<option\s+value="mira"/i);
  });

  test('HTML composer contains only the textarea + Send button', () => {
    const html = read(HTML_PATH);
    expect(html).toMatch(/<textarea[^>]*id="miraLabInput"[^>]*placeholder="Speak into the lab"/);
    expect(html).toMatch(/<button[^>]*class="mira-lab-send"[^>]*type="submit"|<button[^>]*type="submit"[^>]*class="mira-lab-send"/);
    expect(html).toMatch(/<div\s+class="mira-lab-input-row">[\s\S]*?<\/div>/);
    // Form should contain only the input row — no routing siblings.
    const form = html.match(/<form\s+class="mira-lab-composer"[\s\S]*?<\/form>/);
    expect(form).not.toBeNull();
    expect(form[0]).not.toMatch(/<select\b/i);
    expect(form[0]).not.toMatch(/<input\b/i);
  });

  test('renderer has no targetAgents parsing, no routing reveal, no speaker dropdown reads', () => {
    const src = read(RENDERER_PATH);
    expect(src).not.toMatch(/function\s+targetAgents/);
    expect(src).not.toMatch(/maybeRevealRouting/);
    expect(src).not.toMatch(/getElementById\(\s*['"]miraLabSpeaker['"]\s*\)/);
    expect(src).not.toMatch(/getElementById\(\s*['"]miraLabTargets['"]\s*\)/);
    expect(src).not.toMatch(/getElementById\(\s*['"]miraLabRouting['"]\s*\)/);
    expect(src).not.toMatch(/['"]diagnostics['"]\s*===\s*['"]1['"]/);
    expect(src).not.toMatch(/params\.get\(\s*['"]routing['"]\s*\)/);
    expect(src).not.toMatch(/TURN_CHANNEL/);
  });

  test('renderer hardcodes speakerRole=james for user sends', () => {
    const src = read(RENDERER_PATH);
    expect(src).toMatch(/USER_SPEAKER_ROLE\s*=\s*['"]james['"]/);
    expect(src).toMatch(/speakerRole:\s*USER_SPEAKER_ROLE/);
    expect(src).toMatch(/requesterPane:\s*null/);
  });

  test('CSS pins the shell to viewport so composer cannot be pushed off-screen', () => {
    const css = read(CSS_PATH);
    expect(css).toMatch(/\.mira-lab-shell\s*\{[^}]*height:\s*100vh/);
    expect(css).toMatch(/\.mira-lab-shell\s*\{[^}]*max-height:\s*100vh/);
    expect(css).toMatch(/\.mira-lab-shell\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.mira-lab-shell\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/);
  });

  test('CSS makes the transcript scrollable and gives the composer a min height', () => {
    const css = read(CSS_PATH);
    expect(css).toMatch(/\.mira-lab-transcript\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.mira-lab-transcript\s*\{[^}]*min-height:\s*0/);
    expect(css).toMatch(/\.mira-lab-composer\s*\{[^}]*min-height:\s*\d+px/);
    expect(css).toMatch(/@media\s*\(max-height:\s*520px\)/);
  });

  test('CSS contains no rules for routing/route/targets selectors', () => {
    const css = read(CSS_PATH);
    expect(css).not.toMatch(/\.mira-lab-routing\b/);
    expect(css).not.toMatch(/\.mira-lab-route\b/);
    expect(css).not.toMatch(/\.mira-lab-targets\b/);
  });

  test('default copy stays conversation-first and does not narrate machinery', () => {
    const html = read(HTML_PATH);
    const css = read(CSS_PATH);
    const combined = `${html}\n${css}`;
    expect(combined).not.toMatch(/\b(shadcn|dashboard|card-grid|status-card|btn-primary|panel-tab)\b/i);
    expect(combined.toLowerCase()).not.toContain('switchboard');
    expect(combined.toLowerCase()).not.toContain('backchannel');
  });
});
