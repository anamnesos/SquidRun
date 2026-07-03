'use strict';

/**
 * WHITELIST CONTRACT (S467 remodel charter, Oracle honesty-gate lane).
 * The room renders only what squid-room-v2-manifest.js declares.
 *
 * >>> Builder: REMOVE the .skip when the v2 mount lands and add your shell
 * >>> module + squid-room-v2.css to manifest.presentationSources. <<<
 *
 * Live NOW for the sources already declared (speech system) — the harness
 * is proven on real code before v2 arrives, per contracts-first.
 */

const fs = require('fs');
const path = require('path');
const manifest = require('../modules/squid-room-v2-manifest');

const ROOT = path.join(__dirname, '..', '..');

function extractClassLiterals(source) {
  const found = new Set();
  // className = 'a b'; classList.add('a'); class="a b" in template strings;
  // and CSS selectors .a { — every way a room class enters the render path.
  const patterns = [
    /className\s*=\s*['"`]([^'"`]+)['"`]/g,
    /classList\.(?:add|toggle)\(\s*['"`]([^'"`]+)['"`]/g,
    /class="([^"]+)"/g,
    /^\s*\.([a-z][\w-]+)\s*[,{[:]/gim,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      for (const cls of m[1].split(/\s+/)) {
        const clean = cls.trim().replace(/^\./, '');
        if (clean) found.add(clean);
      }
    }
  }
  return found;
}

function isDeclared(cls) {
  if (manifest.classes.includes(cls)) return true;
  return manifest.prefixes.some((p) => cls.startsWith(p));
}

describe('room remodel v2 — the whitelist owns what renders', () => {
  test('every room class in declared presentation sources is manifest-declared', () => {
    const undeclared = [];
    for (const rel of manifest.presentationSources) {
      const file = path.join(ROOT, rel);
      if (!fs.existsSync(file)) continue; // a source may land later; absent != violation
      const classes = extractClassLiterals(fs.readFileSync(file, 'utf8'));
      for (const cls of classes) {
        // Ignore non-room utility words that regex over-matches (pure CSS
        // keywords etc.) — only sr/squid-room namespaces are room classes.
        if (!/^(sr2?-|sr-|squid-room)/.test(cls)) continue;
        if (!isDeclared(cls)) undeclared.push(`${rel}: .${cls}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  test('v2 mount renders zero undeclared legacy classes (mount step 2 flip)', () => {
    // The creature-layer presentation DOM builds pure sr2-: scan the shell
    // source's PRESENTATION class literals - every squid-room-* survivor
    // must be a manifest-declared debt entry, nothing silent.
    const source = fs.readFileSync(path.join(ROOT, 'ui/modules/workspace-pane-shell.js'), 'utf8');
    const ghosts = [];
    for (const cls of extractClassLiterals(source)) {
      if (!/^squid-room/.test(cls)) continue;
      if (!isDeclared(cls)) ghosts.push(cls);
    }
    expect(ghosts).toEqual([]);
    // And the v2 layer actually mounts: the sr2 skeleton classes exist in
    // the shell's build path (not just the stylesheet).
    for (const required of ['sr2-creature-stage', 'sr2-pet-water', 'sr2-creature-canvas', 'sr2-name-tag']) {
      expect(source).toContain(required);
    }
  });
});
