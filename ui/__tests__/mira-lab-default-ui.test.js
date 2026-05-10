'use strict';

const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'mira-lab.html');
const CSS_PATH = path.join(__dirname, '..', 'styles', 'mira-lab.css');
const RENDERER_PATH = path.join(__dirname, '..', 'mira-lab-renderer.js');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function attrsOfFirstTag(html, tagPattern) {
  const re = new RegExp(tagPattern, 'i');
  const m = html.match(re);
  return m ? m[0] : null;
}

describe('mira-lab default UI is conversation-first', () => {
  test('speaker selector is wrapped in a default-hidden routing block', () => {
    const html = read(HTML_PATH);
    expect(html).toMatch(/<div\s+class="mira-lab-routing"\s+id="miraLabRouting"\s+hidden\b/);
    const routingBlock = html.match(/<div\s+class="mira-lab-routing"[\s\S]*?<\/div>\s*<div\s+class="mira-lab-input-row"/);
    expect(routingBlock).not.toBeNull();
    expect(routingBlock[0]).toMatch(/id="miraLabSpeaker"/);
    expect(routingBlock[0]).toMatch(/id="miraLabTargets"/);
  });

  test('composer textarea + send button are NOT hidden by default', () => {
    const html = read(HTML_PATH);
    const textareaTag = attrsOfFirstTag(html, '<textarea[^>]*id="miraLabInput"[^>]*>');
    const sendTag = attrsOfFirstTag(html, '<button[^>]*class="mira-lab-send"[^>]*>');
    expect(textareaTag).not.toBeNull();
    expect(sendTag).not.toBeNull();
    expect(textareaTag).not.toMatch(/\bhidden\b/);
    expect(sendTag).not.toMatch(/\bhidden\b/);
    expect(html).toMatch(/<div\s+class="mira-lab-input-row">/);
  });

  test('default HTML does not surface speaker or target inputs outside the hidden routing block', () => {
    const html = read(HTML_PATH);
    const speakerCount = (html.match(/id="miraLabSpeaker"/g) || []).length;
    const targetsCount = (html.match(/id="miraLabTargets"/g) || []).length;
    expect(speakerCount).toBe(1);
    expect(targetsCount).toBe(1);
    // The routing block must wrap both, and it must carry the `hidden` attribute.
    const routingMatch = html.match(/<div\s+class="mira-lab-routing"\s+id="miraLabRouting"\s+hidden[\s\S]*?<\/div>/);
    expect(routingMatch).not.toBeNull();
    expect(routingMatch[0]).toMatch(/id="miraLabSpeaker"/);
    expect(routingMatch[0]).toMatch(/id="miraLabTargets"/);
  });

  test('CSS pins shell to viewport so composer cannot be pushed off-screen', () => {
    const css = read(CSS_PATH);
    expect(css).toMatch(/\.mira-lab-shell\s*\{[^}]*height:\s*100vh/);
    expect(css).toMatch(/\.mira-lab-shell\s*\{[^}]*max-height:\s*100vh/);
    expect(css).toMatch(/\.mira-lab-shell\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.mira-lab-shell\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/);
  });

  test('CSS makes the transcript scrollable instead of pushing the composer', () => {
    const css = read(CSS_PATH);
    expect(css).toMatch(/\.mira-lab-transcript\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.mira-lab-transcript\s*\{[^}]*min-height:\s*0/);
  });

  test('CSS gives the composer a minimum height so it stays visible', () => {
    const css = read(CSS_PATH);
    expect(css).toMatch(/\.mira-lab-composer\s*\{[^}]*min-height:\s*\d+px/);
    expect(css).toMatch(/@media\s*\(max-height:\s*520px\)/);
  });

  test('renderer reveals routing only when ?diagnostics=1 (or ?routing=1)', () => {
    const src = read(RENDERER_PATH);
    expect(src).toMatch(/maybeRevealRouting/);
    expect(src).toMatch(/diagnostics.*===.*'1'/);
    expect(src).toMatch(/routing.*===.*'1'/);
    expect(src).toMatch(/getElementById\(\s*'miraLabRouting'\s*\)/);
  });

  test('default copy stays conversation-first and does not narrate machinery', () => {
    const html = read(HTML_PATH);
    const css = read(CSS_PATH);
    const combined = `${html}\n${css}`;
    expect(combined).not.toMatch(/\b(shadcn|dashboard|card-grid|status-card|btn-primary|panel-tab)\b/i);
    // The placeholder "Mira to agents: ..." must be reachable only via the hidden routing block.
    const visiblePlaceholder = html.match(/placeholder="Speak into the lab"/);
    expect(visiblePlaceholder).not.toBeNull();
  });
});
