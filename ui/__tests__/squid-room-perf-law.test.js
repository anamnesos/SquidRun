'use strict';

/**
 * PERF LAW static fixture (Oracle wave-3b contract #5, S463 crash autopsy):
 * the squid-room renderer died at 2.9GB RSS with a FLAT JS heap because the
 * frame path minted native-backed CanvasGradients every frame (~480/s).
 * This fixture makes that crash class UNCOMMITTABLE: gradient constructors
 * may exist ONLY inside the engine's memoized ensureGradients cache -
 * nowhere else reachable from the frame path.
 */

const fs = require('fs');
const path = require('path');

const GRADIENT_RE = /create(?:Radial|Linear|Conic)Gradient/g;

function readModule(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'modules', name), 'utf8');
}

function countMatches(text) {
  return (text.match(GRADIENT_RE) || []).length;
}

describe('PERF LAW: no gradient creation outside memoized caches (the 2.9GB autopsy)', () => {
  test('engine: every gradient constructor lives inside ensureGradients', () => {
    const source = readModule('squid-room-creature-engine.js');
    const total = countMatches(source);
    expect(total).toBeGreaterThan(0); // the cache itself must exist

    // Extract the ensureGradients function body by brace matching.
    const start = source.indexOf('function ensureGradients');
    expect(start).toBeGreaterThan(-1);
    const open = source.indexOf('{', start);
    let depth = 1;
    let end = open + 1;
    while (end < source.length && depth > 0) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') depth -= 1;
      end += 1;
    }
    const insideCache = countMatches(source.slice(start, end));
    const outsideCache = total - insideCache;
    // The law: zero gradient constructors outside the memoized cache. If
    // this fails, you are about to re-ship the leak that killed the
    // renderer at 19 minutes - move the gradient into ensureGradients.
    expect(outsideCache).toBe(0);
  });

  test('runtime frame path: zero gradient constructors', () => {
    expect(countMatches(readModule('squid-room-creature-runtime.js'))).toBe(0);
  });

  test('speech system frame path: zero gradient constructors', () => {
    expect(countMatches(readModule('squid-room-speech-system.js'))).toBe(0);
  });

  test('engine caches gradients once: ensureGradients memoizes', () => {
    const source = readModule('squid-room-creature-engine.js');
    // The memo guard must precede construction: an early return on the
    // cached object is what makes per-frame calls allocation-free.
    const fn = source.slice(source.indexOf('function ensureGradients'));
    const guardIndex = fn.indexOf('if (gradientCache) return gradientCache');
    const firstCreate = fn.search(GRADIENT_RE);
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(firstCreate);
  });
});
