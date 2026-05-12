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

  test('renderer threads friction_state through IPC: module-memory state + payload + response read (ARCH #122/#129 direction A)', () => {
    const src = read(RENDERER_PATH);
    // Module-scope memory for friction_state.
    expect(src).toMatch(/let\s+currentFrictionState\s*=\s*null/);
    // Outbound payload passes friction_state via priorFrameState when
    // currentFrictionState is non-null.
    expect(src).toMatch(/priorFrameState:\s*currentFrictionState\s*\?\s*\{\s*friction_state:\s*currentFrictionState/);
    // Inbound response reads friction_state_next off the IPC reply and
    // updates module memory.
    expect(src).toMatch(/currentFrictionState\s*=\s*replyResult\.friction_state_next\s*\|\|\s*null/);
    // Visible-render path does NOT contain a read of friction_state on the
    // render side — the threading field is for module memory only.
    expect(src).not.toMatch(/appendLine\(['"][^'"]*['"],\s*[^,)]*\.friction_state/);
  });

  test('renderer composer status banner: local gate annotations render real text, no fallback substitution', () => {
    const src = read(RENDERER_PATH);
    // ARCH #24/#29: local conversation gates annotate instead of swapping in
    // fallback text. The old quarantine/fallback wording stays gone.
    expect(src).not.toMatch(/Mira reply quarantined \/ gate failed/);
    expect(src).not.toMatch(/safe fallback shown/);
    expect(src).toMatch(/Mira reply rendered \/ diagnostic flags recorded/);
    // Pass branch wording stays as it was.
    expect(src).toMatch(/Mira reply rendered \/ gates passed/);
    // Blocked/degraded continues to use a non-Mira system-state banner.
    expect(src).toMatch(/SYSTEM_ERROR_BANNER_TEXT\s*=\s*['"]Mira Lab held that reply/);
    // The old `appendQuarantinedReply` path stays deleted.
    expect(src).not.toMatch(/appendQuarantinedReply/);
    expect(src).not.toMatch(/\[MIRA LAB OUTPUT - GATE FAILED\]/);
    expect(src).not.toMatch(/gate_failed_fallback/);
    expect(src).toMatch(/annotated_reply/);
    expect(src).toMatch(/replayed_reply/);
  });

  test('CSS shell is fixed to the viewport edges so the composer cannot be clipped', () => {
    const css = read(CSS_PATH);
    expect(css).toMatch(/\.mira-lab-shell\s*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/\.mira-lab-shell\s*\{[^}]*inset:\s*0/);
    expect(css).toMatch(/\.mira-lab-shell\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.mira-lab-shell\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/);
    // html + body must also bound the viewport so 100vh references work in Electron.
    expect(css).toMatch(/html\s*,\s*body\s*\{[^}]*height:\s*100vh/);
    expect(css).toMatch(/html\s*,\s*body\s*\{[^}]*max-height:\s*100vh/);
    expect(css).toMatch(/body\s*\{[^}]*overflow:\s*hidden/);
  });

  test('CSS makes the transcript scrollable and gives the composer a min height', () => {
    const css = read(CSS_PATH);
    expect(css).toMatch(/\.mira-lab-transcript\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.mira-lab-transcript\s*\{[^}]*min-height:\s*0/);
    expect(css).toMatch(/\.mira-lab-composer\s*\{[^}]*min-height:\s*\d+px/);
  });

  test('CSS shrinks chrome aggressively at small viewport heights', () => {
    const css = read(CSS_PATH);
    expect(css).toMatch(/@media\s*\(max-height:\s*700px\)/);
    expect(css).toMatch(/@media\s*\(max-height:\s*520px\)/);
    // Header name must not be allowed to clamp huge enough to swallow the composer.
    const nameMatch = css.match(/\.mira-lab-name\s*\{[^}]*font-size:\s*clamp\(([^)]+)\)/);
    expect(nameMatch).not.toBeNull();
    const nameUpper = parseFloat(nameMatch[1].split(',').pop());
    expect(nameUpper).toBeLessThanOrEqual(50);
    // Default shell padding upper bound must also stay lean so transcript+composer fit.
    const padMatch = css.match(/\.mira-lab-shell\s*\{[^}]*padding:\s*clamp\(([^)]+)\)/);
    expect(padMatch).not.toBeNull();
    const padUpper = parseFloat(padMatch[1].split(',').pop());
    expect(padUpper).toBeLessThanOrEqual(40);
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

  test('layout chrome budget keeps composer visible at 900x760, 720x481, 600x420', () => {
    const css = read(CSS_PATH);

    function clampAt(rule, vmin, vw, vmax, viewportWidthPx) {
      const m = css.match(new RegExp(rule));
      if (!m) throw new Error(`Missing rule for ${rule}`);
      const [low, mid, high] = m[1].split(',').map((s) => s.trim());
      const lowPx = parseFloat(low);
      const highPx = parseFloat(high);
      const midPx = mid.endsWith('vw')
        ? (parseFloat(mid) / 100) * viewportWidthPx
        : parseFloat(mid);
      return Math.min(highPx, Math.max(lowPx, midPx));
    }

    function staticPx(rule, prop) {
      const re = new RegExp(`${rule}\\s*\\{[^}]*${prop}:\\s*(\\d+)px`);
      const m = css.match(re);
      if (!m) throw new Error(`Missing ${prop} in ${rule}`);
      return parseInt(m[1], 10);
    }

    function chromeFor(viewportWidth, viewportHeight, mediaActive) {
      // Default-rule values; override with media-query values when the viewport
      // height is at or below the breakpoint.
      let shellPad = clampAt(
        '\\.mira-lab-shell\\s*\\{[^}]*padding:\\s*clamp\\(([^)]+)\\)',
        14, 3, 32, viewportWidth,
      );
      let shellGap = clampAt(
        '\\.mira-lab-shell\\s*\\{[^}]*gap:\\s*clamp\\(([^)]+)\\)',
        10, 2, 20, viewportWidth,
      );
      let composerMin = staticPx('\\.mira-lab-composer', 'min-height');
      let nameSize = clampAt(
        '\\.mira-lab-name\\s*\\{[^}]*font-size:\\s*clamp\\(([^)]+)\\)',
        22, 3.2, 42, viewportWidth,
      );

      if (mediaActive === 'mh700' || mediaActive === 'mh520') {
        // crude: parse media-block overrides
        const block700 = css.match(/@media\s*\(max-height:\s*700px\)\s*\{([\s\S]*?)\n\}\s*\n/);
        if (block700) {
          const padM = block700[1].match(/\.mira-lab-shell\s*\{[^}]*padding:\s*(\d+)px/);
          const gapM = block700[1].match(/\.mira-lab-shell\s*\{[^}]*gap:\s*(\d+)px/);
          const compM = block700[1].match(/\.mira-lab-composer\s*\{[^}]*min-height:\s*(\d+)px/);
          if (padM) shellPad = parseInt(padM[1], 10);
          if (gapM) shellGap = parseInt(gapM[1], 10);
          if (compM) composerMin = parseInt(compM[1], 10);
          // approximate name shrink for h<=700 — the test only needs an upper-bound budget.
          nameSize = Math.min(nameSize, 28);
        }
      }
      if (mediaActive === 'mh520') {
        const block520 = css.match(/@media\s*\(max-height:\s*520px\)\s*\{([\s\S]*?)\n\}\s*\n/);
        if (block520) {
          const padM = block520[1].match(/\.mira-lab-shell\s*\{[^}]*padding:\s*(\d+)px/);
          const gapM = block520[1].match(/\.mira-lab-shell\s*\{[^}]*gap:\s*(\d+)px/);
          const compM = block520[1].match(/\.mira-lab-composer\s*\{[^}]*min-height:\s*(\d+)px/);
          if (padM) shellPad = parseInt(padM[1], 10);
          if (gapM) shellGap = parseInt(gapM[1], 10);
          if (compM) composerMin = parseInt(compM[1], 10);
        }
      }

      // Header height: max of (name line + state) vs presence pulse column.
      const nameLine = nameSize * 0.96; // line-height factor
      const stateLine = 14; // ~12-13px font + small margin
      const headerStack = nameLine + 6 + stateLine;
      const presenceCol = 22 + 12; // pulse height + padding-top
      const headerHeight = Math.max(headerStack, presenceCol);

      // Total fixed chrome (top padding + header + 2 gaps + composer + bottom padding).
      const chrome = shellPad + headerHeight + shellGap + composerMin + shellGap + shellPad;
      return { chrome, shellPad, shellGap, composerMin, headerHeight };
    }

    const cases = [
      { w: 900, h: 760, media: 'none' },
      { w: 720, h: 481, media: 'mh520' },
      { w: 600, h: 420, media: 'mh520' },
    ];
    for (const c of cases) {
      const { chrome, composerMin } = chromeFor(c.w, c.h, c.media);
      const transcriptBudget = c.h - chrome;
      // Composer must fit within the viewport regardless of transcript content.
      // A negative transcriptBudget would mean the composer is clipped — which is
      // exactly what ARCH #20/#21 reported. Require ≥ 40px of transcript room so
      // at least one line of conversation history is visible alongside the composer.
      expect(transcriptBudget).toBeGreaterThanOrEqual(40);
      expect(composerMin).toBeGreaterThan(0);
    }
  });
});
