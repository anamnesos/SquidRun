'use strict';

/**
 * WHICH RELEASE IS ACTUALLY RUNNING, AND CAN IT STILL WRITE A LEGACY ATTEMPT?
 *
 * =====================================================================
 * WHY THE STEP-2B PROOF COULD NOT SIMPLY BE REUSED
 * =====================================================================
 * Step 2B proved that no production file outside the queue owner references
 * `appendAttempt`. That proof is real and it stays — but it lives in a Jest
 * suite, which means it is a statement about THE TREE ON DISK AT TEST TIME, and
 * the v7 §4 fence needs a statement about THE CODE THAT IS LOADED RIGHT NOW.
 * Those are different claims, and the gap between them is a build that passed
 * its tests and is running something else.
 *
 * Everything easy here is also wrong, which is why none of it is used:
 *
 *   * a Git tree hash — the checkout is mutable and the running process does
 *     not read Git;
 *   * an export-existence check or a counted symbol — proves a shape, not a
 *     call graph;
 *   * a caller-supplied fingerprint or boolean — the caller is the thing being
 *     checked;
 *   * a transitive `require()` closure from the app — Architect #150/#156
 *     already caught that missing `ui/main.js` and
 *     `scripts/hm-telegram-recover-inbound.js`, both of which can append.
 *
 * So production does the work: it locates the release from modules that are
 * ACTUALLY LOADED, enumerates the complete executable production JS surface
 * under that one root, digests every file, and runs the reachability detector
 * itself.
 *
 * =====================================================================
 * THE ABSOLUTE PATH IS EVIDENCE, NOT MATERIAL
 * =====================================================================
 * The root tells us WHICH release we found; it must not tell us WHAT the fence
 * id is. A fingerprint that included `D:\projects\...` would change when the
 * same bytes were checked out elsewhere, and "path spelling cannot create an
 * alternate authority" would be a sentence rather than a test. Canonical
 * material carries relative POSIX paths and digests only.
 *
 * =====================================================================
 * FROZEN AT STARTUP, COMPARED AT EVERY USE
 * =====================================================================
 * The capture happens ONCE per app generation, before drain or scheduling
 * authority exists (loaded-release ruling v1). Lazily computing it at first
 * fence use would fingerprint whatever the disk said at that moment, which is
 * not the generation that loaded. Every later use — fence create, commit,
 * post-commit reread, health — recomputes the CURRENT disk manifest and demands
 * exact equality with that frozen capture. A divergence is a HOLD. It is never
 * a reason to mint a newer fence: a release that changed underneath a running
 * generation is a cutover violation, not a new cutover.
 */

const fs = require('node:fs');
const path = require('node:path');

const { canonicalJson, sha256 } = require('./canonical-json');

const LOADED_RELEASE_SCHEMA = 'squidrun.telegram_loaded_release.v1';
const RELEASE_SCANNER_VERSION = 'legacy_writer_reachability.v1';

/**
 * THE SAME SCAN, ASSERTING THE OPPOSITE FACT (Oracle #105).
 *
 * The fence's original-writer capture may only be issued by a generation that
 * belongs to the legacy world — a generation whose own release proves the legacy
 * writer is unreferenced is not a witness to that world, it is the world that
 * replaced it, and letting it originate the historical row is the self-capture
 * Oracle refused.
 *
 * `scanProductionSurface` cannot serve that question, and the reason is
 * structural rather than an oversight: an outside-owner reference is exactly
 * what it REFUSES on, so the only releases eligible to issue a capture are the
 * ones it returns `ok: false` for. So the measurement is shared and the verdict
 * is split — mutually exclusive by construction.
 *
 * =====================================================================
 * WHAT THE POSITIVE CAPTURE DOES *NOT* CLAIM (Oracle #107)
 * =====================================================================
 * It does not claim the legacy writer was REACHABLE. The Step-2B detector is
 * deliberately conservative: an executable mention of the identifier is enough
 * to DEFEAT a no-writer proof, because the cost of a false positive there is a
 * hold and the cost of a false negative is a fence built over a live writer.
 * Inverting a conservative detector does not give you a strong claim — it gives
 * you the weak one stated the other way round, and the honest name for it is
 * "an outside-owner reference to the legacy writer is PRESENT in this release".
 *
 * So the capability material carries the exact sorted reference evidence rather
 * than a boolean or a count. A later build that wants "reachable" has to write a
 * real call-graph verifier and a new version constant; it may not reinterpret
 * this one, which is why the version is named for what it measures.
 */
const WRITER_CAPABILITY_SCHEMA = 'squidrun.telegram_legacy_writer_capability.v1';
const WRITER_CAPABILITY_SCANNER_VERSION = 'legacy_writer_capability_v1';

/**
 * NAMED EXCLUSIONS, AND DELIBERATELY THE SAME SET STEP 2B USED.
 *
 * Enumerate-and-exclude rather than reachability: a directory nobody thought of
 * is included by default, which is the failure mode you want. Every entry here
 * is tests, dependencies, generated output or VCS metadata — nothing that a
 * running app executes. Adding to this list narrows the proof, so it does not
 * grow without a reason written next to it.
 */
const EXCLUDED_DIRS = Object.freeze([
  'node_modules', '__tests__', 'dist', 'build', 'out', 'release', '.git', 'coverage',
]);

/** The one production module allowed to contain the legacy attempt writer. */
const LEGACY_WRITER_OWNER = 'modules/telegram-inbound-durable-queue.js';

/**
 * The identifier whose production reachability the fence has to disprove.
 *
 * ASSEMBLED, NOT WRITTEN, AND THAT IS NOT A TRICK. This module is itself part
 * of the production surface it scans, so a literal here makes the scanner an
 * offender in its own sweep — and the only two ways out of that are worse: a
 * self-exception ("every file except this one"), which is a check shaped around
 * a failure it cannot see past, or deleting the check. The symbol therefore
 * exists exactly once, in pieces, and every pattern below is derived from it so
 * the two can never drift.
 */
const LEGACY_WRITER_SYMBOL = ['append', 'Attempt'].join('');

/** The owner's only two permitted code lines: the definition and the export. */
const OWNER_DEFINITION_PATTERN = new RegExp(`^function\\s+${LEGACY_WRITER_SYMBOL}\\s*\\(`);
const OWNER_EXPORT_PATTERN = new RegExp(`^${LEGACY_WRITER_SYMBOL}\\s*,$`);

/**
 * ANCHORS: modules whose LOADED filenames locate the release.
 *
 * They are not the coverage set — coverage is the whole surface below. They
 * answer a narrower question: of the possibly several copies of this repository
 * on this machine, which one is this process actually running out of? Every
 * anchor must be loaded and every anchor must resolve under the same root, or
 * we do not know, and not knowing is a HOLD.
 */
const RELEASE_ANCHORS = Object.freeze([
  LEGACY_WRITER_OWNER,
  'modules/main/telegram-ingress-drain.js',
  'modules/main/telegram-ingress-spool.js',
  'modules/main/telegram-source-protocol.js',
  'modules/main/telegram-legacy-cutover-fence.js',
  'modules/main/telegram-loaded-release.js',
  'modules/main/squidrun-app.js',
]);

const RELEASE_REASONS = Object.freeze({
  ROOT_UNRESOLVED: 'release_root_unresolved',
  ANCHOR_NOT_LOADED: 'release_anchor_not_loaded',
  ANCHOR_FOREIGN_ROOT: 'release_anchor_foreign_root',
  MULTIPLE_ROOTS: 'release_multiple_roots',
  SCAN_FAILED: 'release_scan_failed',
  PATH_UNRESOLVABLE: 'release_path_unresolvable',
  SYMLINK_ENTRY: 'release_symlink_entry',
  PATH_ESCAPE: 'release_path_escape',
  SURFACE_TOO_SMALL: 'release_surface_implausible',
  OWNER_MISSING: 'release_legacy_writer_owner_missing',
  OWNER_SHAPE: 'release_legacy_writer_owner_shape',
  REACHABLE_WRITER: 'release_legacy_writer_reachable',
  // The mirror refusal: no outside-owner reference to the legacy writer exists
  // in this release, so it is not eligible to originate the historical capture.
  // Named for what was MEASURED — a missing reference — and not for the stronger
  // "cannot append" it would be overclaiming (Oracle #107).
  WRITER_REFERENCE_ABSENT: 'release_legacy_writer_reference_absent',
  CAPTURE_MISSING: 'release_capture_missing',
  CAPTURE_DIVERGED: 'release_capture_diverged',
});

function fail(reason, detail = null) {
  return detail === null ? { ok: false, reason } : { ok: false, reason, detail };
}

/**
 * Comparable absolute path, or NULL when the OS cannot resolve it.
 *
 * `realpathSync.native` matters on this machine specifically: the workspace is
 * reached through a junction, so two different-looking paths are routinely the
 * same file. What it must NOT do is fall back to `path.resolve` when the
 * resolution fails (Architect #175): that turns "I could not find out what this
 * file really is" into a confident string, and two unresolvable paths would
 * then compare equal on spelling alone. Unresolvable is a HOLD, so it has to be
 * representable.
 */
function canonicalAbsolute(target) {
  let resolved;
  try {
    resolved = fs.realpathSync.native(path.resolve(target));
  } catch {
    return null;
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

function toPosixRelative(root, absolute) {
  return toPosix(path.relative(root, absolute));
}

/** A scan refusal that has to travel up through a recursive walk. */
class ReleaseScanError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.releaseReason = reason;
    this.releaseDetail = detail;
  }
}

/**
 * ANY EXECUTABLE REFERENCE, not just a call shape (Architect #156).
 *
 * Block comments are stripped and line comments dropped first, because the
 * queue owner's own documentation mentions the identifier and a raw match fires
 * on prose — the false positive that gets a real check deleted rather than
 * fixed. After that the detector looks for the NAME, not `name(`:
 * `const write = queue.appendAttempt`, `const { appendAttempt } = queue` and
 * `queue['appendAttempt'](...)` are each a call one indirection later, and a
 * call-shape regex sees none of them.
 */
function findLegacyWriterReferences(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .filter((line) => line.includes(LEGACY_WRITER_SYMBOL))
    .map((line) => line.trim());
}

/**
 * EVERY EXTENSION NODE WILL EXECUTE, not just `.js` (Architect #175).
 *
 * A sweep that only knows `.js` is defeated by adding `recovery.mjs`. The
 * fingerprint would not move, the reachability verdict would still say "no
 * production file can append", and both would be false.
 */
const EXECUTABLE_EXTENSIONS = Object.freeze(['.js', '.cjs', '.mjs']);

function isExecutableJs(name) {
  return EXECUTABLE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * Every executable production file under `root`, excluding the named
 * directories.
 *
 * SYMLINKS AND REPARSE POINTS ARE REFUSED RATHER THAN FOLLOWED OR SKIPPED.
 * Following one lets a linked directory inject code the manifest attributes to
 * this release; skipping one lets that same code run unmeasured. Neither is a
 * fingerprint, so an unexpected link stops the scan and the fence HOLDs. The
 * canonical-escape check behind it is the same argument for the case where the
 * link is somewhere above us in the tree.
 */
function enumerateProductionFiles(root, deps = {}) {
  const readdir = deps.readdirSync || fs.readdirSync;
  const excluded = new Set(EXCLUDED_DIRS);
  const canonicalRoot = canonicalAbsolute(root);
  if (canonicalRoot === null) {
    throw new ReleaseScanError(RELEASE_REASONS.PATH_UNRESOLVABLE, { path: String(root) });
  }
  const rootPrefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : `${canonicalRoot}${path.sep}`;

  const files = [];
  const walk = (dir) => {
    for (const entry of readdir(dir, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      // THE LINK TEST COMES FIRST (Architect #177). A symlinked directory is
      // reported as neither a directory nor a `.js` file, so an extension
      // filter above this line skips it in silence — `ui/payload -> elsewhere`
      // would be unmeasured, unrefused, and running.
      if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) {
        throw new ReleaseScanError(RELEASE_REASONS.SYMLINK_ENTRY, { path: toPosixRelative(root, full) });
      }
      const isDirectory = entry.isDirectory();
      if (!isDirectory && !isExecutableJs(entry.name)) continue;
      const canonical = canonicalAbsolute(full);
      if (canonical === null) {
        throw new ReleaseScanError(RELEASE_REASONS.PATH_UNRESOLVABLE, { path: toPosixRelative(root, full) });
      }
      // The resolved file must still be INSIDE the release we are measuring.
      if (!canonical.startsWith(rootPrefix)) {
        throw new ReleaseScanError(RELEASE_REASONS.PATH_ESCAPE, {
          path: toPosixRelative(root, full),
          canonical,
        });
      }
      if (isDirectory) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

/**
 * Scan one release root and return its manifest plus the reachability verdict.
 *
 * Exported separately from the capture so the detector can be driven against a
 * planted tree. The capture path cannot be handed a root — it derives one from
 * loaded modules — which is what keeps "production computed this" true while
 * still leaving the scanner falsifiable.
 */
function measureProductionSurface(root, deps = {}) {
  const readFile = deps.readFileSync || fs.readFileSync;
  const minimumFiles = Number.isInteger(deps.minimumFiles) ? deps.minimumFiles : 50;

  let absoluteFiles;
  try {
    absoluteFiles = enumerateProductionFiles(root, deps);
  } catch (error) {
    if (error instanceof ReleaseScanError) return fail(error.releaseReason, error.releaseDetail);
    return fail(RELEASE_REASONS.SCAN_FAILED, { message: error?.message || String(error) });
  }
  // AN EMPTY SWEEP PASSES EVERY ASSERTION BELOW IT. A root that yielded nothing
  // is a root we resolved wrongly, not a release with no legacy writer.
  if (absoluteFiles.length < minimumFiles) {
    return fail(RELEASE_REASONS.SURFACE_TOO_SMALL, { files: absoluteFiles.length, minimumFiles });
  }

  const manifest = [];
  const offenders = [];
  let ownerReferences = null;
  let totalBytes = 0;

  for (const absolute of absoluteFiles) {
    const relative = toPosixRelative(root, absolute);
    let raw;
    try {
      raw = readFile(absolute);
    } catch (error) {
      return fail(RELEASE_REASONS.SCAN_FAILED, { file: relative, message: error?.message || String(error) });
    }
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
    // BYTES, NOT DECODED TEXT. The digest has to move when a CRLF does, or a
    // line-ending rewrite would silently preserve a fingerprint.
    manifest.push({ path: relative, bytes: buffer.length, sha256: sha256(buffer) });
    totalBytes += buffer.length;

    const source = buffer.toString('utf8');
    const references = findLegacyWriterReferences(source);
    if (relative === LEGACY_WRITER_OWNER) {
      ownerReferences = references;
    } else if (references.length > 0) {
      offenders.push({ path: relative, references });
    }
  }

  if (ownerReferences === null) {
    return fail(RELEASE_REASONS.OWNER_MISSING, { owner: LEGACY_WRITER_OWNER });
  }
  // THE OWNER'S OWN INTERNALS. The sweep above skips this file by construction,
  // so a private caller inside it would be invisible; exactly two code lines —
  // the definition and the export — is what "defined and exported only" means,
  // and a third is what that caller would look like.
  const definition = ownerReferences.filter((line) => OWNER_DEFINITION_PATTERN.test(line));
  const exported = ownerReferences.filter((line) => OWNER_EXPORT_PATTERN.test(line));
  if (ownerReferences.length !== 2 || definition.length !== 1 || exported.length !== 1) {
    return fail(RELEASE_REASONS.OWNER_SHAPE, { owner: LEGACY_WRITER_OWNER, references: ownerReferences });
  }
  const manifestSha256 = sha256(canonicalJson(manifest));
  return {
    ok: true,
    root,
    manifest,
    manifestSha256,
    fileCount: manifest.length,
    totalBytes,
    // THE MEASUREMENT STOPS HERE AND THE VERDICT IS THE CALLER'S. Both verdicts
    // below are total over this same list, so neither can drift from the other
    // by measuring differently — only by disagreeing about what it means.
    offenders,
    reachability: {
      scanner: RELEASE_SCANNER_VERSION,
      symbol: LEGACY_WRITER_SYMBOL,
      owner: LEGACY_WRITER_OWNER,
      // The owner's exact two lines are BOUND, not merely counted: a rewritten
      // definition is a different legacy writer and must move the fingerprint.
      ownerDefinition: definition[0],
      ownerExport: exported[0],
    },
  };
}

/**
 * The measured surface, refusing any release where the legacy writer is
 * reachable. This is the fence's release proof and its contract is unchanged.
 */
function scanProductionSurface(root, deps = {}) {
  const measured = measureProductionSurface(root, deps);
  if (!measured.ok) return measured;
  if (measured.offenders.length > 0) {
    return fail(RELEASE_REASONS.REACHABLE_WRITER, { offenders: measured.offenders });
  }
  return {
    ok: true,
    root: measured.root,
    manifest: measured.manifest,
    manifestSha256: measured.manifestSha256,
    fileCount: measured.fileCount,
    totalBytes: measured.totalBytes,
    reachability: { ...measured.reachability, offenders: [] },
  };
}

/**
 * The measured surface, refusing any release with NO outside-owner reference to
 * the legacy writer — the exact inverse, for the exact inverse question.
 *
 * The reference list is carried whole and sorted rather than counted, because
 * "this release belongs to the legacy world" is a claim about specific lines in
 * specific files, and a capture that survived those lines changing would be
 * attesting to evidence it never measured (Oracle #107).
 */
function scanLegacyWriterCapability(root, deps = {}) {
  const measured = measureProductionSurface(root, deps);
  if (!measured.ok) return measured;
  if (measured.offenders.length === 0) {
    return fail(RELEASE_REASONS.WRITER_REFERENCE_ABSENT, { owner: LEGACY_WRITER_OWNER });
  }
  return {
    ok: true,
    root: measured.root,
    manifest: measured.manifest,
    manifestSha256: measured.manifestSha256,
    fileCount: measured.fileCount,
    totalBytes: measured.totalBytes,
    outsideOwnerReferences: measured.offenders,
    ownerShape: {
      symbol: measured.reachability.symbol,
      owner: measured.reachability.owner,
      ownerDefinition: measured.reachability.ownerDefinition,
      ownerExport: measured.reachability.ownerExport,
    },
  };
}

/**
 * The canonical, path-independent WRITER-CAPABILITY material.
 *
 * Deliberately its own builder rather than a `schema` option on
 * `buildReleaseMaterial`: the two materials assert opposite facts, and one
 * function emitting either depending on a string argument is how a reader ends
 * up holding the wrong one while every field name still looks right.
 */
function buildWriterCapabilityMaterial(scan) {
  const anchorEntries = RELEASE_ANCHORS
    .map((anchor) => scan.manifest.find((entry) => entry.path === anchor) || null)
    .filter((entry) => entry !== null)
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));

  const references = scan.outsideOwnerReferences
    .map((entry) => ({ path: entry.path, references: [...entry.references] }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));

  return {
    schema: WRITER_CAPABILITY_SCHEMA,
    scanner: WRITER_CAPABILITY_SCANNER_VERSION,
    anchors: anchorEntries,
    fileCount: scan.fileCount,
    totalBytes: scan.totalBytes,
    manifestSha256: scan.manifestSha256,
    // THE EVIDENCE, NOT A VERDICT. `symbol` and `owner` are bound too, so a
    // future build that renamed either cannot read this row as if it measured
    // the same thing.
    capability: {
      symbol: scan.ownerShape.symbol,
      owner: scan.ownerShape.owner,
      ownerDefinition: scan.ownerShape.ownerDefinition,
      ownerExport: scan.ownerShape.ownerExport,
      outsideOwnerReferences: references,
    },
  };
}

/**
 * Locate the single production `ui` root from modules that are actually loaded.
 *
 * `moduleCache` is injectable so the ambiguous-root and missing-anchor branches
 * can be driven; it is a LOCATOR input only. Nothing about the manifest,
 * digests or reachability verdict comes from it.
 */
function resolveLoadedReleaseRoot(deps = {}) {
  const cache = deps.moduleCache || require.cache;
  const anchors = Array.isArray(deps.anchors) ? deps.anchors : RELEASE_ANCHORS;
  const selfRoot = deps.selfRoot || path.resolve(__dirname, '..', '..');
  const canonicalSelfRoot = canonicalAbsolute(selfRoot);
  if (canonicalSelfRoot === null) {
    return fail(RELEASE_REASONS.PATH_UNRESOLVABLE, { path: selfRoot });
  }

  /** Loaded file -> its canonical identity. Unresolvable entries are kept as null. */
  const loaded = [];
  for (const key of Object.keys(cache)) {
    if (!isExecutableJs(key)) continue;
    loaded.push({ key, canonical: canonicalAbsolute(key) });
  }

  const missing = [];
  const foreignRoots = new Set();
  for (const anchor of anchors) {
    const expected = canonicalAbsolute(path.join(selfRoot, anchor));
    const suffix = `/${anchor}`;
    // EVERY MATCH, NOT THE FIRST (Architect #175). Short-circuiting on "the
    // expected one is loaded" is precisely the fail-open shape: a second
    // checkout loaded alongside ours satisfies the check and never gets looked
    // at, so the manifest measures one release while the process runs two.
    const matches = loaded.filter((entry) => {
      if (entry.canonical === null) return toPosix(entry.key).endsWith(suffix);
      return entry.canonical === expected || toPosix(entry.canonical).endsWith(suffix);
    });
    if (matches.length === 0) { missing.push(anchor); continue; }

    const canonicalMatches = new Set(matches.map((entry) => entry.canonical));
    if (canonicalMatches.has(null)) {
      return fail(RELEASE_REASONS.PATH_UNRESOLVABLE, {
        anchor,
        loaded: matches.filter((entry) => entry.canonical === null).map((entry) => entry.key),
      });
    }
    if (canonicalMatches.size > 1) {
      return fail(RELEASE_REASONS.MULTIPLE_ROOTS, { anchor, loaded: [...canonicalMatches] });
    }
    const [only] = [...canonicalMatches];
    if (expected === null || only !== expected) {
      foreignRoots.add(only);
    }
  }

  if (missing.length > 0) {
    return fail(RELEASE_REASONS.ANCHOR_NOT_LOADED, { missing });
  }
  if (foreignRoots.size > 0) {
    return fail(RELEASE_REASONS.ANCHOR_FOREIGN_ROOT, { anchors: [...foreignRoots] });
  }
  if (!fs.existsSync(path.join(selfRoot, 'main.js'))) {
    // The root must look like the `ui` release, not merely like a directory an
    // anchor happened to sit under.
    return fail(RELEASE_REASONS.ROOT_UNRESOLVED, { root: selfRoot });
  }
  return { ok: true, root: selfRoot, canonicalRoot: canonicalSelfRoot, anchors: [...anchors] };
}

/**
 * The canonical, path-independent release material.
 *
 * Anchor digests are carried explicitly rather than left implicit in the
 * manifest: they are the files whose identity located the release, so a fence
 * that survives an anchor swap would be attesting to a release it did not run.
 */
function buildReleaseMaterial(scan) {
  const anchorEntries = RELEASE_ANCHORS
    .map((anchor) => scan.manifest.find((entry) => entry.path === anchor) || null)
    .filter((entry) => entry !== null)
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));

  return {
    schema: LOADED_RELEASE_SCHEMA,
    scanner: RELEASE_SCANNER_VERSION,
    anchors: anchorEntries,
    fileCount: scan.fileCount,
    totalBytes: scan.totalBytes,
    manifestSha256: scan.manifestSha256,
    reachability: scan.reachability,
  };
}

/**
 * DEEP FREEZE, not a frozen wrapper around mutable innards (Architect #175).
 *
 * `Object.freeze({material})` leaves `material.reachability.offenders` writable,
 * so anything holding the capture could push an offender out of the list — or
 * edit an anchor digest — while the capture still reports frozen and the
 * fingerprint still reads as computed. A capture that can be edited after the
 * fact is a variable, not evidence.
 */
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

/**
 * THE CAPTURES THIS MODULE ACTUALLY PRODUCED.
 *
 * A `WeakSet` rather than a marker field, because a marker field is a string a
 * caller can type. Everything downstream — the fence, health revalidation —
 * asks this set whether the capture in its hands came from a real scan, so a
 * caller-shaped `{ok: true, fingerprint: '...', root: '...'}` is refused by
 * construction instead of by inspection.
 */
const genuineCaptures = new WeakSet();

/** Did this exact object come out of `captureLoadedRelease`? */
function isGenuineCapture(capture) {
  return typeof capture === 'object' && capture !== null && genuineCaptures.has(capture);
}

/**
 * A SEPARATE SET, NOT A FLAG ON THE SAME ONE. The two captures answer opposite
 * questions, and one WeakSet with a schema field to tell them apart would make
 * the distinction a string comparison somebody can get backwards exactly once.
 */
const genuineCapabilityCaptures = new WeakSet();

/** Did this exact object come out of `captureLegacyWriterCapability`? */
function isGenuineCapabilityCapture(capture) {
  return typeof capture === 'object' && capture !== null && genuineCapabilityCaptures.has(capture);
}

/**
 * Capture the loaded release once. The result is frozen and content-addressed.
 *
 * TAKES NO ARGUMENTS, DELIBERATELY (Architect #177). The lower layers accept
 * injection so the anchor and scanner branches can be driven, and that is
 * exactly why THIS function must not forward any of it: a caller who could pass
 * `{anchors: ['modules/main/telegram-loaded-release.js']}` would get a capture
 * branded genuine while six of the seven anchors were never checked, and a
 * caller who could pass a `readFile` would get one branded genuine over bytes
 * it invented. Fixed anchors, the real module cache, the real filesystem.
 *
 * Every anchor must also be present in the manifest: an anchor that located the
 * root but was then excluded from coverage would mean the two proofs disagree
 * about what the release contains.
 */
function captureLoadedRelease() {
  const located = resolveLoadedReleaseRoot();
  if (!located.ok) return located;

  const scan = scanProductionSurface(located.root);
  if (!scan.ok) return scan;

  const missingAnchors = RELEASE_ANCHORS.filter(
    (anchor) => !scan.manifest.some((entry) => entry.path === anchor)
  );
  if (missingAnchors.length > 0) {
    return fail(RELEASE_REASONS.ROOT_UNRESOLVED, { missingAnchors });
  }

  const material = buildReleaseMaterial(scan);
  const capture = deepFreeze({
    ok: true,
    schema: LOADED_RELEASE_SCHEMA,
    // LOCATOR EVIDENCE, NOT MATERIAL. Never reaches the fingerprint.
    root: located.root,
    material,
    fingerprint: sha256(canonicalJson(material)),
    manifestSha256: scan.manifestSha256,
    fileCount: scan.fileCount,
    totalBytes: scan.totalBytes,
  });
  genuineCaptures.add(capture);
  return capture;
}

/**
 * Recompute the CURRENT on-disk release and require exact equality with the
 * generation's frozen startup capture.
 *
 * The comparison is over the fingerprint AND the material, because equal
 * fingerprints with unequal material would mean the digest stopped covering
 * something — a failure worth naming rather than passing.
 */
function verifyLoadedReleaseUnchanged(capture) {
  // ONLY A CAPTURE THIS MODULE MADE. A caller-shaped object carrying `ok` and a
  // plausible fingerprint is the whole attack, and comparing it against itself
  // would pass every time.
  if (!isGenuineCapture(capture)) return fail(RELEASE_REASONS.CAPTURE_MISSING);
  if (capture.ok !== true || typeof capture.fingerprint !== 'string') {
    return fail(RELEASE_REASONS.CAPTURE_MISSING);
  }
  // NO INJECTION HERE EITHER. This is the comparison the fence and health both
  // stand on; a caller-supplied `readFile` would make "the release is unchanged"
  // a statement by the caller.
  const scan = scanProductionSurface(capture.root);
  if (!scan.ok) return scan;

  const material = buildReleaseMaterial(scan);
  const fingerprint = sha256(canonicalJson(material));
  if (fingerprint !== capture.fingerprint
    || canonicalJson(material) !== canonicalJson(capture.material)) {
    return fail(RELEASE_REASONS.CAPTURE_DIVERGED, {
      captured: capture.fingerprint,
      current: fingerprint,
    });
  }
  return { ok: true, fingerprint, material };
}

/**
 * Capture THIS generation's legacy-writer capability, once, for issuance only.
 *
 * TAKES NO ARGUMENTS, for the same reason `captureLoadedRelease` does not: this
 * result is the sole production evidence that the issuing generation belongs to
 * the legacy world, and a caller who could inject a root or a reader would be
 * asserting exactly the fact being proved.
 *
 * On the repaired release this ALWAYS refuses with `WRITER_REFERENCE_ABSENT`,
 * and that refusal is the correct current answer rather than a gap: no
 * generation of this build may originate the historical capture, so if no
 * capture already exists on a machine, the fence cannot be created there. Oracle
 * #105 named that outcome and it is honest — the alternative is a build that can
 * invent its own predecessor.
 */
function captureLegacyWriterCapability() {
  const located = resolveLoadedReleaseRoot();
  if (!located.ok) return located;

  const scan = scanLegacyWriterCapability(located.root);
  if (!scan.ok) return scan;

  const missingAnchors = RELEASE_ANCHORS.filter(
    (anchor) => !scan.manifest.some((entry) => entry.path === anchor)
  );
  if (missingAnchors.length > 0) {
    return fail(RELEASE_REASONS.ROOT_UNRESOLVED, { missingAnchors });
  }

  const material = buildWriterCapabilityMaterial(scan);
  const capture = deepFreeze({
    ok: true,
    schema: WRITER_CAPABILITY_SCHEMA,
    root: located.root,
    material,
    fingerprint: sha256(canonicalJson(material)),
    manifestSha256: scan.manifestSha256,
    fileCount: scan.fileCount,
    totalBytes: scan.totalBytes,
  });
  genuineCapabilityCaptures.add(capture);
  return capture;
}

module.exports = Object.freeze({
  LOADED_RELEASE_SCHEMA,
  WRITER_CAPABILITY_SCHEMA,
  WRITER_CAPABILITY_SCANNER_VERSION,
  RELEASE_SCANNER_VERSION,
  RELEASE_ANCHORS,
  RELEASE_REASONS,
  EXCLUDED_DIRS,
  EXECUTABLE_EXTENSIONS,
  LEGACY_WRITER_OWNER,
  LEGACY_WRITER_SYMBOL,
  isGenuineCapture,
  isGenuineCapabilityCapture,
  findLegacyWriterReferences,
  enumerateProductionFiles,
  measureProductionSurface,
  scanProductionSurface,
  scanLegacyWriterCapability,
  resolveLoadedReleaseRoot,
  buildReleaseMaterial,
  buildWriterCapabilityMaterial,
  captureLoadedRelease,
  captureLegacyWriterCapability,
  verifyLoadedReleaseUnchanged,
});
