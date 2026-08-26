/**
 * S492 v7 §4 Step 3 — the PRODUCTION loaded-release / call-graph fingerprint.
 *
 * Step 2B proved no production file outside the queue owner can append a legacy
 * attempt. That proof is a Jest suite, which makes it a claim about the tree at
 * test time; the fence needs a claim about the code that is loaded and running.
 * These tests attack the production scanner that makes the second claim.
 *
 * NOTHING LIVE. Planted temp trees for every scanner attack, and read-only
 * calls against the real release for the capture path.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Load the anchors so the real capture path can resolve a single root.
require('../modules/telegram-inbound-durable-queue');
require('../modules/main/telegram-ingress-drain');
require('../modules/main/telegram-ingress-spool');
require('../modules/main/telegram-source-protocol');
require('../modules/main/telegram-legacy-cutover-fence');
require('../modules/main/squidrun-app');

const release = require('../modules/main/telegram-loaded-release');

const {
  RELEASE_REASONS,
  RELEASE_ANCHORS,
  LEGACY_WRITER_OWNER,
  EXECUTABLE_EXTENSIONS,
  scanProductionSurface,
  resolveLoadedReleaseRoot,
  buildReleaseMaterial,
  captureLoadedRelease,
  verifyLoadedReleaseUnchanged,
  findLegacyWriterReferences,
} = release;

const SYMBOL = 'appendAttempt';
const tempRoots = [];

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-release-'));
  tempRoots.push(dir);
  return dir;
}

function write(root, relative, contents) {
  const full = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

/** The owner's exact two permitted code lines, plus prose that must not match. */
const OWNER_SOURCE = [
  '/**',
  ` * ${SYMBOL} writes JSON + newline as ONE record. Prose, not a call.`,
  ' */',
  `function ${SYMBOL}(dir, updateId, entryState, provenance = {}) {`,
  '  return { dir, updateId, entryState, provenance };',
  '}',
  '',
  'module.exports = {',
  `  ${SYMBOL},`,
  '};',
  '',
].join('\n');

/** A minimal but structurally real release tree. */
function plantRelease(overrides = {}) {
  const root = tempRoot();
  write(root, 'main.js', "'use strict';\nrequire('./modules/main/ordinary');\n");
  write(root, LEGACY_WRITER_OWNER, OWNER_SOURCE);
  write(root, 'modules/main/ordinary.js', "'use strict';\nmodule.exports = { ordinary: true };\n");
  write(root, 'scripts/hm-telegram-recover-inbound.js', "'use strict';\nmodule.exports = { recover: true };\n");
  // Excluded surfaces that must not be measured.
  write(root, 'node_modules/dep/index.js', `const x = queue.${SYMBOL};\n`);
  write(root, '__tests__/some.test.js', `const y = queue.${SYMBOL};\n`);
  for (const [relative, contents] of Object.entries(overrides)) write(root, relative, contents);
  return root;
}

const SCAN = { minimumFiles: 1 };

function scan(root, deps = {}) {
  return scanProductionSurface(root, { ...SCAN, ...deps });
}

afterAll(() => {
  for (const dir of tempRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('the scanner measures the whole production surface', () => {
  test('a clean planted release scans, and excluded directories are not measured', () => {
    const root = plantRelease();
    const result = scan(root);
    expect(result.ok).toBe(true);
    const paths = result.manifest.map((entry) => entry.path);
    expect(paths).toEqual([
      LEGACY_WRITER_OWNER,
      'main.js',
      'modules/main/ordinary.js',
      'scripts/hm-telegram-recover-inbound.js',
    ].sort());
    // The two excluded files each carry a reference; neither was scanned.
    expect(result.reachability.offenders).toEqual([]);
    expect(result.fileCount).toBe(4);
    expect(result.totalBytes).toBeGreaterThan(0);
  });

  test('an empty or implausibly small surface is refused, not passed vacuously', () => {
    const root = plantRelease();
    // The default guard, not the relaxed one the other tests use.
    const result = scanProductionSurface(root);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(RELEASE_REASONS.SURFACE_TOO_SMALL);
  });

  test('the real release passes its own scanner with zero offenders', () => {
    const uiRoot = path.join(__dirname, '..');
    const result = scanProductionSurface(uiRoot);
    expect(result.ok).toBe(true);
    expect(result.reachability.offenders).toEqual([]);
    expect(result.fileCount).toBeGreaterThan(500);
    // Coverage the require-closure narrowing missed (Architect #150/#156).
    const paths = new Set(result.manifest.map((entry) => entry.path));
    expect(paths.has('main.js')).toBe(true);
    expect(paths.has(LEGACY_WRITER_OWNER)).toBe(true);
    expect(paths.has('scripts/hm-telegram-recover-inbound.js')).toBe(true);
    expect(paths.has('modules/main/squidrun-app.js')).toBe(true);
  });
});

describe('a reachable legacy writer is refused wherever it is planted', () => {
  // The four sites the loaded-release ruling names explicitly.
  const sites = [
    ['ui/main.js', 'main.js', `'use strict';\nconst write = queue.${SYMBOL};\n`],
    ['a standalone recovery script', 'scripts/hm-telegram-recover-inbound.js',
      `'use strict';\nqueue.${SYMBOL}(dir, 1, 'attempted');\n`],
    ['an ordinary module', 'modules/main/ordinary.js',
      `'use strict';\nconst { ${SYMBOL} } = require('../telegram-inbound-durable-queue');\n`],
    ['a computed property access', 'modules/main/ordinary.js',
      `'use strict';\nconst op = '${SYMBOL}'; queue[op](dir, 1);\n`],
  ];

  test.each(sites)('%s', (_label, relative, contents) => {
    const root = plantRelease({ [relative]: contents });
    const result = scan(root);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(RELEASE_REASONS.REACHABLE_WRITER);
    expect(result.detail.offenders.map((entry) => entry.path)).toContain(relative);
  });

  test('a private caller inside the queue owner itself is refused', () => {
    // The sweep skips the owner by construction, so its internals are checked
    // by exact shape instead: a third code line is what that caller looks like.
    const root = plantRelease({
      [LEGACY_WRITER_OWNER]: `${OWNER_SOURCE}\nfunction internal() { return ${SYMBOL}(1, 2, 'attempted'); }\n`,
    });
    const result = scan(root);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(RELEASE_REASONS.OWNER_SHAPE);
  });

  test('an owner missing its definition or export is refused', () => {
    const root = plantRelease({ [LEGACY_WRITER_OWNER]: `module.exports = {\n  ${SYMBOL},\n};\n` });
    expect(scan(root).reason).toBe(RELEASE_REASONS.OWNER_SHAPE);
  });

  test('an owner that is not in the surface at all is refused', () => {
    const root = tempRoot();
    write(root, 'main.js', "'use strict';\n");
    write(root, 'modules/main/ordinary.js', "'use strict';\n");
    expect(scan(root).reason).toBe(RELEASE_REASONS.OWNER_MISSING);
  });

  test('prose mentioning the symbol is not a reference', () => {
    expect(findLegacyWriterReferences(`// ${SYMBOL}(dir) is never called here\n`)).toEqual([]);
    expect(findLegacyWriterReferences(` * ${SYMBOL} writes JSON + newline\n`)).toEqual([]);
    expect(findLegacyWriterReferences(`/* ${SYMBOL}(x) */\n`)).toEqual([]);
    expect(findLegacyWriterReferences(`const write = queue.${SYMBOL};\n`))
      .toEqual([`const write = queue.${SYMBOL};`]);
  });
});

describe('the surface covers every executable extension', () => {
  test.each(EXECUTABLE_EXTENSIONS)('a planted %s offender is caught', (extension) => {
    const relative = `scripts/recovery${extension}`;
    const root = plantRelease({ [relative]: `export const write = queue.${SYMBOL};\n` });
    const result = scan(root);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(RELEASE_REASONS.REACHABLE_WRITER);
    expect(result.detail.offenders.map((entry) => entry.path)).toContain(relative);
  });

  test('.mjs and .cjs files are measured, so adding one moves the fingerprint', () => {
    const clean = scan(plantRelease());
    const withEsm = scan(plantRelease({ 'scripts/extra.mjs': 'export const extra = 1;\n' }));
    expect(withEsm.ok).toBe(true);
    expect(withEsm.manifestSha256).not.toBe(clean.manifestSha256);
    expect(withEsm.fileCount).toBe(clean.fileCount + 1);
  });
});

describe('links and escapes stop the scan instead of being skipped', () => {
  /** Symlink creation needs privilege on Windows; skip rather than fake a pass. */
  function trySymlink(target, linkPath, type) {
    try {
      fs.symlinkSync(target, linkPath, type);
      return true;
    } catch {
      return false;
    }
  }

  test('a symlinked DIRECTORY is refused, not silently skipped', () => {
    const root = plantRelease();
    const outside = tempRoot();
    write(outside, 'evil.js', `const write = queue.${SYMBOL};\n`);
    if (!trySymlink(outside, path.join(root, 'payload'), 'junction')) {
      // Without the privilege the attack cannot be planted; say so rather than
      // reporting a pass this run did not earn.
      console.warn('symlink attack skipped: no privilege to create a junction');
      return;
    }
    const result = scan(root);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(RELEASE_REASONS.SYMLINK_ENTRY);
    expect(result.detail.path).toBe('payload');
  });

  test('a symlinked FILE is refused', () => {
    const root = plantRelease();
    const outside = tempRoot();
    const target = write(outside, 'evil.js', `const write = queue.${SYMBOL};\n`);
    if (!trySymlink(target, path.join(root, 'modules', 'linked.js'), 'file')) {
      console.warn('symlink attack skipped: no privilege to create a file link');
      return;
    }
    const result = scan(root);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(RELEASE_REASONS.SYMLINK_ENTRY);
  });

  test('an unresolvable root is a refusal, never a resolved string', () => {
    const result = scan(path.join(tempRoot(), 'does-not-exist'));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(RELEASE_REASONS.PATH_UNRESOLVABLE);
  });
});

describe('the fingerprint is content-derived and path-independent', () => {
  function copyTree(from, to) {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
        copyTree(source, target);
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
      }
    }
  }

  test('identical bytes under a DIFFERENT absolute root derive the same fingerprint', () => {
    const first = plantRelease();
    const second = tempRoot();
    copyTree(first, second);
    const a = buildReleaseMaterial(scan(first));
    const b = buildReleaseMaterial(scan(second));
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
    // And the absolute root appears nowhere in the material.
    expect(JSON.stringify(a)).not.toContain(first.split(path.sep).join('/'));
  });

  test('one changed byte moves the manifest digest', () => {
    const clean = scan(plantRelease());
    const edited = scan(plantRelease({ 'modules/main/ordinary.js': "'use strict';\nmodule.exports = { ordinary: false };\n" }));
    expect(edited.ok).toBe(true);
    expect(edited.manifestSha256).not.toBe(clean.manifestSha256);
  });

  test('a line-ending rewrite moves the manifest digest', () => {
    const lf = scan(plantRelease({ 'modules/main/ordinary.js': "'use strict';\nmodule.exports = {};\n" }));
    const crlf = scan(plantRelease({ 'modules/main/ordinary.js': "'use strict';\r\nmodule.exports = {};\r\n" }));
    expect(crlf.ok).toBe(true);
    expect(crlf.manifestSha256).not.toBe(lf.manifestSha256);
  });

  test('the owner definition and export lines are bound, not merely counted', () => {
    const clean = scan(plantRelease());
    const renamedParams = scan(plantRelease({
      [LEGACY_WRITER_OWNER]: OWNER_SOURCE.replace('(dir, updateId, entryState, provenance = {})', '(d, u, s, p = {})'),
    }));
    expect(renamedParams.ok).toBe(true);
    expect(renamedParams.reachability.ownerDefinition).not.toBe(clean.reachability.ownerDefinition);
    expect(JSON.stringify(buildReleaseMaterial(renamedParams)))
      .not.toEqual(JSON.stringify(buildReleaseMaterial(clean)));
  });
});

describe('anchors locate exactly one loaded root', () => {
  const uiRoot = path.join(__dirname, '..');
  const anchorPath = (anchor) => path.join(uiRoot, ...anchor.split('/'));

  function cacheFor(anchors) {
    const cache = {};
    for (const anchor of anchors) cache[anchorPath(anchor)] = {};
    return cache;
  }

  test('every fixed anchor loaded from one root resolves', () => {
    const result = resolveLoadedReleaseRoot({ moduleCache: cacheFor(RELEASE_ANCHORS) });
    expect(result.ok).toBe(true);
    expect(result.root).toBe(uiRoot);
  });

  test('a missing anchor HOLDs', () => {
    const result = resolveLoadedReleaseRoot({ moduleCache: cacheFor(RELEASE_ANCHORS.slice(1)) });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(RELEASE_REASONS.ANCHOR_NOT_LOADED);
    expect(result.detail.missing).toEqual([RELEASE_ANCHORS[0]]);
  });

  test('a SECOND checkout loaded alongside ours HOLDs even though ours is loaded', () => {
    // The fail-open shape Architect #175 caught: `loaded.has(expected)` would
    // short-circuit and never look at the foreign copy.
    const foreignRoot = plantRelease();
    const cache = cacheFor(RELEASE_ANCHORS);
    cache[path.join(foreignRoot, ...RELEASE_ANCHORS[0].split('/'))] = {};
    fs.mkdirSync(path.dirname(path.join(foreignRoot, ...RELEASE_ANCHORS[0].split('/'))), { recursive: true });
    const result = resolveLoadedReleaseRoot({ moduleCache: cache });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(RELEASE_REASONS.MULTIPLE_ROOTS);
  });

  test('an anchor loaded ONLY from a foreign root HOLDs', () => {
    const foreignRoot = plantRelease();
    const cache = cacheFor(RELEASE_ANCHORS.slice(1));
    cache[path.join(foreignRoot, ...RELEASE_ANCHORS[0].split('/'))] = {};
    const result = resolveLoadedReleaseRoot({ moduleCache: cache });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(RELEASE_REASONS.ANCHOR_FOREIGN_ROOT);
  });
});

describe('the branded capture is production authority, not a caller shape', () => {
  test('the real capture succeeds and re-verifies against current disk', () => {
    const capture = captureLoadedRelease();
    expect(capture.ok).toBe(true);
    expect(capture.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyLoadedReleaseUnchanged(capture).ok).toBe(true);
  });

  test('the capture is deep-frozen, so nothing can edit it after the fact', () => {
    const capture = captureLoadedRelease();
    expect(Object.isFrozen(capture)).toBe(true);
    expect(Object.isFrozen(capture.material)).toBe(true);
    expect(Object.isFrozen(capture.material.reachability)).toBe(true);
    expect(Object.isFrozen(capture.material.reachability.offenders)).toBe(true);
    expect(Object.isFrozen(capture.material.anchors[0])).toBe(true);
    expect(() => { 'use strict'; capture.material.reachability.offenders.push({}); }).toThrow();
  });

  test('a caller-shaped capture is refused even when its fields are correct', () => {
    const real = captureLoadedRelease();
    const forged = {
      ok: true,
      schema: real.schema,
      root: real.root,
      material: JSON.parse(JSON.stringify(real.material)),
      fingerprint: real.fingerprint,
      manifestSha256: real.manifestSha256,
      fileCount: real.fileCount,
      totalBytes: real.totalBytes,
    };
    expect(verifyLoadedReleaseUnchanged(forged)).toEqual({ ok: false, reason: RELEASE_REASONS.CAPTURE_MISSING });
  });

  test('captureLoadedRelease takes no arguments, so a subset of anchors cannot be injected', () => {
    // The #177 attack: one real anchor supplied, six unchecked, result branded.
    expect(captureLoadedRelease.length).toBe(0);
    const capture = captureLoadedRelease({ anchors: ['modules/main/telegram-loaded-release.js'] });
    // The argument is ignored: the fingerprint is the fixed-anchor one.
    expect(capture.fingerprint).toBe(captureLoadedRelease().fingerprint);
  });

  test('verifyLoadedReleaseUnchanged takes no injectable reader', () => {
    expect(verifyLoadedReleaseUnchanged.length).toBe(1);
  });

  test('a release that changes on disk after the capture HOLDs and never remints', () => {
    // The end-to-end mutation the ruling names. A file is added under the real
    // release root and removed again in `finally`, because the alternative —
    // asserting this only against a planted tree — would prove the scanner and
    // not the capture/compare seam the fence stands on.
    const capture = captureLoadedRelease();
    const probeDir = path.join(__dirname, '..', '__fence_probe__');
    const probeFile = path.join(probeDir, 'probe.js');
    try {
      fs.mkdirSync(probeDir, { recursive: true });
      fs.writeFileSync(probeFile, "'use strict';\nmodule.exports = { probe: true };\n");
      const diverged = verifyLoadedReleaseUnchanged(capture);
      expect(diverged.ok).toBe(false);
      expect(diverged.reason).toBe(RELEASE_REASONS.CAPTURE_DIVERGED);
      expect(diverged.detail.captured).toBe(capture.fingerprint);
      expect(diverged.detail.current).not.toBe(capture.fingerprint);
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
    // ...and the original capture is healthy again once the tree is restored,
    // which is what "never remints" means: the fence id did not move.
    expect(fs.existsSync(probeDir)).toBe(false);
    expect(verifyLoadedReleaseUnchanged(capture).ok).toBe(true);
  });
});
